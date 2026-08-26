import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeHookIngestResponse,
	RuntimeProjectAddResponse,
	RuntimeProjectBoardCommandExecutionResult,
	RuntimeProjectStateResponse,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartResponse,
	RuntimeStateStreamErrorMessage,
	RuntimeStateStreamProjectStateMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskNotificationMessage,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core";
import { deriveTaskIndicatorState, QUARTERDECK_BUILD_ID } from "../../src/core";
import { loadProjectContext } from "../../src/state";
import { createBoard, createReviewBoard } from "../utilities/board-factory";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import {
	getAvailablePort,
	resolveTsxLoaderImportSpecifier,
	startQuarterdeckServer,
} from "../utilities/integration-server";
import { createBoardSeedCommandBatch } from "../utilities/project-board-command";
import { connectRuntimeStream, type RuntimeStreamClient } from "../utilities/runtime-stream-client";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

function installDeterministicFakeCodex(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	const nodePath = process.execPath;
	const tsxLoader = resolveTsxLoaderImportSpecifier();
	const fakeCodexPath = resolve(process.cwd(), "scripts/agent-lab/fake-codex.ts");
	if (process.platform === "win32") {
		writeFileSync(
			join(binDir, "codex.cmd"),
			`@echo off\r\n"${nodePath}" --import "${tsxLoader}" "${fakeCodexPath}" %*\r\n`,
			"utf8",
		);
		return;
	}
	const launcherPath = join(binDir, "codex");
	writeFileSync(
		launcherPath,
		`#!/bin/sh\nexec ${JSON.stringify(nodePath)} --import ${JSON.stringify(tsxLoader)} ${JSON.stringify(fakeCodexPath)} "$@"\n`,
		"utf8",
	);
	chmodSync(launcherPath, 0o755);
}

describe.sequential("state streaming integration", () => {
	it("streams per-project snapshots and isolates project updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-stream-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-projects-stream-");

		const projectAPath = join(tempRoot, "project-a");
		const projectBPath = join(tempRoot, "project-b");
		mkdirSync(projectAPath, { recursive: true });
		mkdirSync(projectBPath, { recursive: true });
		initGitRepository(projectAPath);
		initGitRepository(projectBPath);

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectAPath,
			homeDir: tempHome,
			port,
		});

		let streamA: RuntimeStreamClient | null = null;
		let streamB: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const projectAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(projectAId).not.toBe("");
			const expectedProjectAPath = await realpath(projectAPath).catch(() => resolve(projectAPath));
			const expectedProjectBPath = await realpath(projectBPath).catch(() => resolve(projectBPath));

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				projectId: projectAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
			const projectBId = addProjectResponse.payload.project?.id ?? null;
			expect(projectBId).not.toBeNull();
			if (!projectBId) {
				throw new Error("Missing project id for added project.");
			}

			streamA = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectAId)}`,
			);
			const snapshotA = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshotA.runtimeBuildId).toBe(QUARTERDECK_BUILD_ID);
			expect(snapshotA.currentProjectId).toBe(projectAId);
			expect(snapshotA.projectState?.repoPath).toBe(expectedProjectAPath);
			expect(snapshotA.projects.map((project) => project.id).sort()).toEqual([projectAId, projectBId].sort());

			streamB = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectBId)}`,
			);
			const snapshotB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshotB.currentProjectId).toBe(projectBId);
			expect(snapshotB.projectState?.repoPath).toBe(expectedProjectBPath);

			const currentProjectBState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId: projectBId,
			});
			const previousRevision = currentProjectBState.payload.revision;
			const saveProjectBResponse = await requestJson<RuntimeProjectBoardCommandExecutionResult>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.applyBoardCommands",
				type: "mutation",
				projectId: projectBId,
				payload: createBoardSeedCommandBatch(createBoard("Realtime Task"), previousRevision, "seed-realtime-task"),
			});
			expect(saveProjectBResponse.status).toBe(200);
			expect(saveProjectBResponse.payload.state.revision).toBe(previousRevision + 1);

			const projectUpdateB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamProjectStateMessage =>
					message.type === "project_state_updated" &&
					message.projectId === projectBId &&
					message.projectState.revision === previousRevision + 1,
			)) as RuntimeStateStreamProjectStateMessage;
			expect(projectUpdateB.projectState.revision).toBe(previousRevision + 1);
			expect(projectUpdateB.projectState.board.columns[0]?.cards[0]?.prompt).toBe("Realtime Task");

			const streamAMessages = await streamA.collectFor(500);
			expect(
				streamAMessages.some(
					(message) => message.type === "project_state_updated" && message.projectId === projectBId,
				),
			).toBe(false);
			const projectsUpdateForB = streamAMessages.find(
				(message) =>
					message.type === "projects_updated" &&
					message.projects.some(
						(project) => project.id === projectBId && project.boardRevision === previousRevision + 1,
					),
			);
			expect(projectsUpdateForB).toMatchObject({
				type: "projects_updated",
				projects: expect.arrayContaining([
					expect.objectContaining({
						id: projectBId,
						boardRevision: previousRevision + 1,
						taskCounts: { backlog: 1, in_progress: 0, review: 0, trash: 0 },
					}),
				]),
			});

			const projectsAfterUpdate = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				projectId: projectAId,
			});
			expect(projectsAfterUpdate.status).toBe(200);
			const projectB = projectsAfterUpdate.payload.projects.find((project) => project.id === projectBId) ?? null;
			expect(projectB?.taskCounts.backlog).toBe(1);
			// The accepted browser command is exactly +1 (asserted above), but the
			// runtime may subsequently persist task Git/worktree metadata through the
			// same board authority before this later list query.
			expect(projectB?.boardRevision).toBeGreaterThanOrEqual(previousRevision + 1);

			const projectsWhileBIsPreferred = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				projectId: projectBId,
			});
			const projectBAfterPreferenceChange =
				projectsWhileBIsPreferred.payload.projects.find((project) => project.id === projectBId) ?? null;
			expect(projectBAfterPreferenceChange?.taskCounts).toEqual(projectB?.taskCounts);
			expect(projectBAfterPreferenceChange?.boardRevision).toBe(projectB?.boardRevision);
		} finally {
			if (streamA) {
				await streamA.close();
			}
			if (streamB) {
				await streamB.close();
			}
			await server.stop();
			cleanupRoot();
			cleanupHome();
		}
	}, 30_000);

	it("seeds cross-project notification state when a browser stream connects", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-notification-seed-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-projects-notification-seed-");

		const projectAPath = join(tempRoot, "project-a");
		const projectBPath = join(tempRoot, "project-b");
		mkdirSync(projectAPath, { recursive: true });
		mkdirSync(projectBPath, { recursive: true });
		initGitRepository(projectAPath);
		initGitRepository(projectBPath);

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectAPath,
			homeDir: tempHome,
			port,
		});

		let streamA: RuntimeStreamClient | null = null;
		let startedTaskId: string | null = null;
		let projectBId: string | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const projectAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(projectAId).not.toBe("");

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				projectId: projectAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
			projectBId = addProjectResponse.payload.project?.id ?? null;
			expect(projectBId).not.toBeNull();
			if (!projectBId) {
				throw new Error("Missing project id for added project.");
			}

			startedTaskId = "task-1";
			const projectBState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId: projectBId,
			});
			expect(projectBState.status).toBe(200);
			const seedProjectBBoard = await requestJson<RuntimeProjectBoardCommandExecutionResult>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.applyBoardCommands",
				type: "mutation",
				projectId: projectBId,
				payload: createBoardSeedCommandBatch(
					createReviewBoard(startedTaskId, "Project B notification task"),
					projectBState.payload.revision,
					"seed-project-b-notification",
				),
			});
			expect(seedProjectBBoard.status).toBe(200);

			const startShellResponse = await requestJson<RuntimeShellSessionStartResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.startShellSession",
				type: "mutation",
				projectId: projectBId,
				payload: {
					taskId: startedTaskId,
					baseRef: "HEAD",
				},
			});
			expect(startShellResponse.status).toBe(200);
			expect(startShellResponse.payload.ok).toBe(true);
			expect(startShellResponse.payload.summary?.state).toBe("running");

			streamA = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectAId)}`,
			);
			const snapshot = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(
				snapshot.notificationSummariesByProject?.[projectBId]?.some(
					(summary) => summary.taskId === startedTaskId && summary.state === "running",
				),
			).toBe(true);
		} finally {
			if (streamA) {
				await streamA.close();
			}
			if (projectBId && startedTaskId) {
				await requestJson({
					baseUrl: `http://127.0.0.1:${port}`,
					procedure: "runtime.stopTaskSession",
					type: "mutation",
					projectId: projectBId,
					payload: { taskId: startedTaskId },
				});
			}
			await server.stop();
			cleanupRoot();
			cleanupHome();
		}
	}, 30_000);

	it("streams the project list when the selected project's state cannot load", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-stream-corrupt-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-projects-stream-corrupt-");

		const projectAPath = join(tempRoot, "project-a");
		const projectBPath = join(tempRoot, "project-b");
		mkdirSync(projectAPath, { recursive: true });
		mkdirSync(projectBPath, { recursive: true });
		initGitRepository(projectAPath);
		initGitRepository(projectBPath);

		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		let projectAId = "";
		let projectBId = "";
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		try {
			const contextA = await loadProjectContext(projectAPath);
			const contextB = await loadProjectContext(projectBPath);
			projectAId = contextA.projectId;
			projectBId = contextB.projectId;
			mkdirSync(contextA.statePath, { recursive: true });
			writeFileSync(
				join(contextA.statePath, "board.json"),
				JSON.stringify(createBoard("Valid board"), null, 2),
				"utf8",
			);
			writeFileSync(join(contextA.statePath, "sessions.json"), JSON.stringify(["not", "an", "object"]), "utf8");
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousUserProfile;
			}
		}

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectAPath,
			homeDir: tempHome,
			port,
		});

		let stream: RuntimeStreamClient | null = null;
		try {
			stream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectAId)}`,
			);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.currentProjectId).toBe(projectAId);
			expect(snapshot.projects.map((project) => project.id).sort()).toEqual([projectAId, projectBId].sort());
			expect(snapshot.projectState).toBeNull();

			const error = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamErrorMessage => message.type === "error",
			)) as RuntimeStateStreamErrorMessage;
			expect(error.message).toContain("Invalid sessions.json file");
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			cleanupRoot();
			cleanupHome();
		}
	}, 30_000);

	it("keeps session repair warnings visible when startup hydration repairs the file first", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-startup-repair-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck-project-startup-repair-");

		mkdirSync(projectPath, { recursive: true });
		initGitRepository(projectPath);

		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		let projectId = "";
		let sessionsPath = "";
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		try {
			const context = await loadProjectContext(projectPath);
			projectId = context.projectId;
			sessionsPath = join(context.statePath, "sessions.json");
			mkdirSync(context.statePath, { recursive: true });
			writeFileSync(
				join(context.statePath, "board.json"),
				JSON.stringify(createBoard("Valid board"), null, 2),
				"utf8",
			);
			writeFileSync(
				sessionsPath,
				JSON.stringify(
					{
						// task-1 matches the card created by createBoard so it survives
						// the board-linked prune applied to the broadcast snapshot.
						"task-1": createTestTaskSessionSummary({
							taskId: "task-1",
							updatedAt: 100,
						}),
						"task-bad": {
							...createTestTaskSessionSummary({
								taskId: "task-bad",
								updatedAt: 200,
							}),
							agentId: "old-agent",
						},
					},
					null,
					2,
				),
				"utf8",
			);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousUserProfile;
			}
		}

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port,
		});

		let stream: RuntimeStreamClient | null = null;
		try {
			stream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectId)}`,
			);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.projectState?.warnings).toEqual([
				expect.objectContaining({
					kind: "sessions_corruption",
					droppedCount: 1,
				}),
			]);
			expect(Object.keys(snapshot.projectState?.sessions ?? {})).toEqual(["task-1"]);

			const repairedSessions = JSON.parse(readFileSync(sessionsPath, "utf8")) as Record<string, unknown>;
			expect(Object.keys(repairedSessions)).toEqual(["task-1"]);
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			cleanupProject();
			cleanupHome();
		}
	}, 30_000);

	it("keeps board counts and notification semantics aligned across review, response, and interrupt transitions", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-hook-stream-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck-project-hook-stream-");

		mkdirSync(projectPath, { recursive: true });
		initGitRepository(projectPath);
		const fakeBinPath = join(tempHome, "bin");
		installDeterministicFakeCodex(fakeBinPath);

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port,
			extraEnv: {
				PATH: [fakeBinPath, process.env.PATH].filter(Boolean).join(delimiter),
				QUARTERDECK_AGENT_LAB_SCENARIO: "idle",
			},
		});

		let stream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const projectId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(projectId).not.toBe("");
			const taskId = "hook-review-task";

			stream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectId)}`,
			);
			await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			);

			const initialState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			const seedResponse = await requestJson<RuntimeProjectBoardCommandExecutionResult>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.applyBoardCommands",
				type: "mutation",
				projectId,
				payload: createBoardSeedCommandBatch(
					createReviewBoard(taskId, "Review and response convergence"),
					initialState.payload.revision,
					"seed-review-response-convergence",
				),
			});
			expect(seedResponse.status).toBe(200);

			const startTaskResponse = await requestJson<RuntimeTaskSessionStartResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.startTaskSession",
				type: "mutation",
				projectId,
				payload: {
					taskId,
					prompt: "Exercise canonical state-stream transitions [agent-lab:idle]",
					agentId: "codex",
					baseRef: "HEAD",
					useWorktree: false,
				},
			});
			expect(startTaskResponse.status).toBe(200);
			expect(startTaskResponse.payload.ok).toBe(true);
			const sessionInstanceId = startTaskResponse.payload.summary?.sessionInstanceId;
			expect(sessionInstanceId).toBeTruthy();
			if (!sessionInstanceId) throw new Error("Missing live Codex session identity.");

			const initialUnconfirmedStateMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectStateMessage =>
					message.type === "project_state_updated" &&
					message.projectId === projectId &&
					message.projectState.board.columns.some(
						(column) => column.id === "review" && column.cards.some((card) => card.id === taskId),
					),
				10_000,
			)) as RuntimeStateStreamProjectStateMessage;
			await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectsMessage =>
					message.type === "projects_updated" &&
					message.projects.some(
						(project) =>
							project.id === projectId &&
							project.boardRevision >= initialUnconfirmedStateMessage.projectState.revision &&
							project.taskCounts.in_progress === 0 &&
							project.taskCounts.review === 1,
					),
				10_000,
			);

			const startWorkResponse = await requestJson<RuntimeHookIngestResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "hooks.ingest",
				type: "mutation",
				payload: {
					taskId,
					projectId,
					event: "to_in_progress",
					metadata: {
						source: "codex",
						hookEventName: "UserPromptSubmit",
						sessionInstanceId,
						turnId: "turn-1",
					},
					delivery: {
						id: "00000000-0000-4000-8000-000000000099",
						occurredAt: Date.now(),
					},
				},
			});
			expect(startWorkResponse.status).toBe(200);
			expect(startWorkResponse.payload.ok).toBe(true);
			const confirmedRunningStateMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectStateMessage =>
					message.type === "project_state_updated" &&
					message.projectId === projectId &&
					message.projectState.board.columns.some(
						(column) => column.id === "in_progress" && column.cards.some((card) => card.id === taskId),
					),
				10_000,
			)) as RuntimeStateStreamProjectStateMessage;

			const permissionOccurredAt = Date.now();
			const preToolUseResponse = await requestJson<RuntimeHookIngestResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "hooks.ingest",
				type: "mutation",
				payload: {
					taskId,
					projectId,
					event: "activity",
					metadata: {
						source: "codex",
						hookEventName: "PreToolUse",
						sessionInstanceId,
						turnId: "turn-1",
						toolUseId: "tool-1",
						toolName: "Bash",
					},
					delivery: {
						id: "00000000-0000-4000-8000-000000000000",
						occurredAt: permissionOccurredAt - 1,
					},
				},
			});
			expect(preToolUseResponse.status).toBe(200);
			expect(preToolUseResponse.payload.ok).toBe(true);

			const hookResponse = await requestJson<RuntimeHookIngestResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "hooks.ingest",
				type: "mutation",
				payload: {
					taskId,
					projectId,
					event: "to_review",
					metadata: {
						source: "codex",
						hookEventName: "PermissionRequest",
						sessionInstanceId,
						turnId: "turn-1",
						toolName: "Bash",
						notificationType: "permission_prompt",
						activityText: "Waiting for approval",
					},
					delivery: {
						id: "00000000-0000-4000-8000-000000000001",
						occurredAt: permissionOccurredAt,
					},
				},
			});
			expect(hookResponse.status).toBe(200);
			expect(hookResponse.payload.ok).toBe(true);
			const permissionState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(permissionState.payload.sessions[taskId]?.outstandingInteraction).toMatchObject({
				status: "waiting",
				turnId: "turn-1",
				toolUseId: "tool-1",
			});

			const needsInputNotification = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamTaskNotificationMessage =>
					message.type === "task_notification" &&
					message.projectId === projectId &&
					message.summaries.some(
						(summary) => summary.taskId === taskId && deriveTaskIndicatorState(summary).needsInput,
					),
				10_000,
			)) as RuntimeStateStreamTaskNotificationMessage;
			expect(needsInputNotification.summaries).toContainEqual(
				expect.objectContaining({ taskId, state: "awaiting_review", reviewReason: "hook" }),
			);

			const reviewStateMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectStateMessage =>
					message.type === "project_state_updated" &&
					message.projectId === projectId &&
					message.projectState.revision > confirmedRunningStateMessage.projectState.revision &&
					message.projectState.board.columns.some(
						(column) => column.id === "review" && column.cards.some((card) => card.id === taskId),
					),
				10_000,
			)) as RuntimeStateStreamProjectStateMessage;
			const reviewProjectMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectsMessage =>
					message.type === "projects_updated" &&
					message.projects.some(
						(project) =>
							project.id === projectId &&
							project.boardRevision >= reviewStateMessage.projectState.revision &&
							project.taskCounts.in_progress === 0 &&
							project.taskCounts.review === 1,
					),
				10_000,
			)) as RuntimeStateStreamProjectsMessage;
			const reviewProject = reviewProjectMessage.projects.find((project) => project.id === projectId);
			// Automatic title or runtime metadata persistence may legitimately advance
			// the durable board between the project-state and project-list frames. The
			// list must never lag the observed state and its semantic counts must agree.
			expect(reviewProject?.boardRevision).toBeGreaterThanOrEqual(reviewStateMessage.projectState.revision);

			const inputResponse = await requestJson<RuntimeTaskSessionInputResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.sendTaskSessionInput",
				type: "mutation",
				projectId,
				payload: {
					taskId,
					text: "y",
					appendNewline: true,
					intent: "submit",
				},
			});
			expect(inputResponse.status).toBe(200);
			expect(inputResponse.payload).toMatchObject({
				ok: true,
				summary: { taskId, state: "awaiting_review", reviewReason: "hook" },
			});
			const resumeHookResponse = await requestJson<RuntimeHookIngestResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "hooks.ingest",
				type: "mutation",
				payload: {
					taskId,
					projectId,
					event: "activity",
					metadata: {
						source: "codex",
						hookEventName: "PreToolUse",
						sessionInstanceId,
						turnId: "turn-1",
						toolUseId: "tool-2",
						toolName: "Read",
					},
					delivery: {
						id: "00000000-0000-4000-8000-000000000002",
						occurredAt: Date.now() + 1,
					},
				},
			});
			expect(resumeHookResponse.status).toBe(200);
			expect(resumeHookResponse.payload.ok).toBe(true);
			const resumedState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(resumedState.payload.sessions[taskId]).toMatchObject({
				state: "running",
				reviewReason: null,
				outstandingInteraction: null,
			});
			const runningNotification = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamTaskNotificationMessage =>
					message.type === "task_notification" &&
					message.projectId === projectId &&
					message.notificationRevision > needsInputNotification.notificationRevision &&
					message.summaries.some(
						(summary) =>
							summary.taskId === taskId &&
							summary.state === "running" &&
							!deriveTaskIndicatorState(summary).needsInput,
					),
				10_000,
			)) as RuntimeStateStreamTaskNotificationMessage;
			expect(runningNotification.notificationRevision).toBeGreaterThan(needsInputNotification.notificationRevision);

			const runningStateMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectStateMessage =>
					message.type === "project_state_updated" &&
					message.projectId === projectId &&
					message.projectState.revision > reviewStateMessage.projectState.revision &&
					message.projectState.board.columns.some(
						(column) => column.id === "in_progress" && column.cards.some((card) => card.id === taskId),
					),
				10_000,
			)) as RuntimeStateStreamProjectStateMessage;
			const runningProjectMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectsMessage =>
					message.type === "projects_updated" &&
					message.projects.some(
						(project) =>
							project.id === projectId &&
							project.boardRevision >= runningStateMessage.projectState.revision &&
							project.taskCounts.in_progress === 1 &&
							project.taskCounts.review === 0,
					),
				10_000,
			)) as RuntimeStateStreamProjectsMessage;
			const runningProject = runningProjectMessage.projects.find((project) => project.id === projectId);
			expect(runningProject?.boardRevision).toBeGreaterThanOrEqual(runningStateMessage.projectState.revision);

			const interruptResponse = await requestJson<RuntimeTaskSessionInputResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.sendTaskSessionInput",
				type: "mutation",
				projectId,
				payload: {
					taskId,
					text: "\u001b",
					appendNewline: false,
					intent: "write",
				},
			});
			expect(interruptResponse.status).toBe(200);
			expect(interruptResponse.payload.ok).toBe(true);

			const interruptedNotification = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamTaskNotificationMessage =>
					message.type === "task_notification" &&
					message.projectId === projectId &&
					message.notificationRevision > runningNotification.notificationRevision &&
					message.summaries.some(
						(summary) =>
							summary.taskId === taskId &&
							summary.state === "awaiting_review" &&
							summary.reviewReason === "interrupted" &&
							!deriveTaskIndicatorState(summary).needsInput,
					),
				10_000,
			)) as RuntimeStateStreamTaskNotificationMessage;
			expect(interruptedNotification.notificationRevision).toBeGreaterThan(runningNotification.notificationRevision);

			const interruptedStateMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectStateMessage =>
					message.type === "project_state_updated" &&
					message.projectId === projectId &&
					message.projectState.revision > runningStateMessage.projectState.revision &&
					message.projectState.board.columns.some(
						(column) => column.id === "review" && column.cards.some((card) => card.id === taskId),
					),
				10_000,
			)) as RuntimeStateStreamProjectStateMessage;
			await stream.waitForMessage(
				(message): message is RuntimeStateStreamProjectsMessage =>
					message.type === "projects_updated" &&
					message.projects.some(
						(project) =>
							project.id === projectId &&
							project.boardRevision >= interruptedStateMessage.projectState.revision &&
							project.taskCounts.in_progress === 0 &&
							project.taskCounts.review === 1,
					),
				10_000,
			);

			const finalState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(finalState.payload.board.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(0);
			expect(finalState.payload.board.columns.find((column) => column.id === "review")?.cards).toContainEqual(
				expect.objectContaining({ id: taskId }),
			);

			await requestJson({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.stopTaskSession",
				type: "mutation",
				projectId,
				payload: { taskId },
			});
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			cleanupProject();
			cleanupHome();
		}
	}, 30_000);

	it("streams centralized project metadata updates for task worktrees", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-metadata-stream-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck-project-metadata-stream-");

		mkdirSync(projectPath, { recursive: true });
		initGitRepository(projectPath);
		runGit(projectPath, ["config", "user.name", "Test User"]);
		runGit(projectPath, ["config", "user.email", "test@example.com"]);
		writeFileSync(join(projectPath, "README.md"), "seed\n", "utf8");
		commitAll(projectPath, "seed project");

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port,
		});

		let stream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const projectId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(projectId).not.toBe("");

			const stateResponse = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(stateResponse.status).toBe(200);

			const taskId = "metadata-stream-task";
			const trashTaskId = "metadata-trash-task";
			const baseRef = runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
			const board = createReviewBoard(taskId, "Metadata stream task", trashTaskId);
			const reviewColumn = board.columns.find((column) => column.id === "review");
			const trashColumn = board.columns.find((column) => column.id === "trash");
			if (!reviewColumn?.cards[0]) {
				throw new Error("Expected seeded review card.");
			}
			reviewColumn.cards[0].baseRef = baseRef;
			if (!trashColumn?.cards[0]) {
				throw new Error("Expected seeded trash card.");
			}
			trashColumn.cards[0].baseRef = baseRef;

			const saveResponse = await requestJson<RuntimeProjectBoardCommandExecutionResult>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.applyBoardCommands",
				type: "mutation",
				projectId,
				payload: createBoardSeedCommandBatch(board, stateResponse.payload.revision, "seed-metadata-board"),
			});
			expect(saveResponse.status).toBe(200);

			const ensureResponse = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.ensureWorktree",
				type: "mutation",
				projectId,
				payload: {
					taskId,
					baseRef,
				},
			});
			expect(ensureResponse.status).toBe(200);
			expect(ensureResponse.payload.ok).toBe(true);
			if (!ensureResponse.payload.ok) {
				throw new Error(ensureResponse.payload.error ?? "ensureWorktree failed");
			}

			stream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectId)}`,
			);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.projectMetadata).toBeNull();
			const initialMetadataMessage = await stream.waitForMessage(
				(message) =>
					message.type === "project_metadata_updated" &&
					message.projectId === projectId &&
					message.projectMetadata.taskWorktrees.some((task) => task.taskId === taskId),
				10_000,
			);
			expect(initialMetadataMessage.type).toBe("project_metadata_updated");
			if (initialMetadataMessage.type !== "project_metadata_updated") {
				throw new Error("Expected initial project metadata update message.");
			}
			const initialTaskMetadata =
				initialMetadataMessage.projectMetadata.taskWorktrees.find((task) => task.taskId === taskId) ?? null;
			expect(initialTaskMetadata).not.toBeNull();
			expect(initialTaskMetadata?.changedFiles ?? 0).toBe(0);
			expect(initialMetadataMessage.projectMetadata.taskWorktrees.some((task) => task.taskId === trashTaskId)).toBe(
				false,
			);

			writeFileSync(join(ensureResponse.payload.path, "task-change.txt"), "updated\n", "utf8");
			const focusResponse = await requestJson({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.setFocusedTask",
				type: "mutation",
				projectId,
				payload: {
					taskId,
				},
			});
			expect(focusResponse.status).toBe(200);

			const metadataMessage = await stream.waitForMessage(
				(message) =>
					message.type === "project_metadata_updated" &&
					message.projectId === projectId &&
					message.projectMetadata.taskWorktrees.some(
						(task) => task.taskId === taskId && (task.changedFiles ?? 0) > 0,
					),
				10_000,
			);
			expect(metadataMessage.type).toBe("project_metadata_updated");
			if (metadataMessage.type !== "project_metadata_updated") {
				throw new Error("Expected project metadata update message.");
			}
			const updatedTaskMetadata = metadataMessage.projectMetadata.taskWorktrees.find(
				(task) => task.taskId === taskId,
			);
			expect(updatedTaskMetadata?.changedFiles).toBeGreaterThan(0);
			expect(updatedTaskMetadata?.stateVersion).toBeGreaterThan(initialTaskMetadata?.stateVersion ?? 0);
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			cleanupProject();
			cleanupHome();
		}
	}, 45_000);
});
