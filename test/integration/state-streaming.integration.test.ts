import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeHookIngestResponse,
	RuntimeProjectAddResponse,
	RuntimeProjectStateResponse,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartResponse,
	RuntimeStateStreamErrorMessage,
	RuntimeStateStreamProjectStateMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core";
import { loadProjectContext } from "../../src/state";
import { createBoard, createReviewBoard } from "../utilities/board-factory";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { getAvailablePort, startQuarterdeckServer } from "../utilities/integration-server";
import { connectRuntimeStream, type RuntimeStreamClient } from "../utilities/runtime-stream-client";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

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
			const saveProjectBResponse = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.saveState",
				type: "mutation",
				projectId: projectBId,
				payload: {
					board: createBoard("Realtime Task"),
					expectedRevision: previousRevision,
				},
			});
			expect(saveProjectBResponse.status).toBe(200);
			expect(saveProjectBResponse.payload.revision).toBe(previousRevision + 1);

			const projectUpdateB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamProjectStateMessage =>
					message.type === "project_state_updated" && message.projectId === projectBId,
			)) as RuntimeStateStreamProjectStateMessage;
			expect(projectUpdateB.projectState.revision).toBe(previousRevision + 1);
			expect(projectUpdateB.projectState.board.columns[0]?.cards[0]?.prompt).toBe("Realtime Task");

			const streamAMessages = await streamA.collectFor(500);
			expect(
				streamAMessages.some(
					(message) => message.type === "project_state_updated" && message.projectId === projectBId,
				),
			).toBe(false);

			const projectsAfterUpdate = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				projectId: projectAId,
			});
			expect(projectsAfterUpdate.status).toBe(200);
			const projectB = projectsAfterUpdate.payload.projects.find((project) => project.id === projectBId) ?? null;
			expect(projectB?.taskCounts.backlog).toBe(1);
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
			const seedProjectBBoard = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.saveState",
				type: "mutation",
				projectId: projectBId,
				payload: {
					board: createReviewBoard(startedTaskId, "Project B notification task"),
					expectedRevision: projectBState.payload.revision,
				},
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

	it("emits task_ready_for_review when hook review event is ingested", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-hook-stream-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck-project-hook-stream-");

		mkdirSync(projectPath, { recursive: true });
		initGitRepository(projectPath);

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

			stream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectId)}`,
			);
			await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			);

			const taskId = "hook-review-task";
			const startShellResponse = await requestJson<RuntimeShellSessionStartResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.startShellSession",
				type: "mutation",
				projectId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(startShellResponse.status).toBe(200);
			expect(startShellResponse.payload.ok).toBe(true);

			const hookResponse = await requestJson<RuntimeHookIngestResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "hooks.ingest",
				type: "mutation",
				payload: {
					taskId,
					projectId,
					event: "to_review",
				},
			});
			expect(hookResponse.status).toBe(200);
			expect(hookResponse.payload.ok).toBe(true);

			const readyMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamTaskReadyForReviewMessage =>
					message.type === "task_ready_for_review" && message.projectId === projectId && message.taskId === taskId,
			)) as RuntimeStateStreamTaskReadyForReviewMessage;
			expect(readyMessage.type).toBe("task_ready_for_review");
			expect(readyMessage.triggeredAt).toBeGreaterThan(0);

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

			const saveResponse = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.saveState",
				type: "mutation",
				projectId,
				payload: {
					board,
					expectedRevision: stateResponse.payload.revision,
				},
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
