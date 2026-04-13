import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardData,
	RuntimeHookIngestResponse,
	RuntimeProjectAddResponse,
	RuntimeProjectRemoveResponse,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartResponse,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core/api-contract";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { getAvailablePort, startQuarterdeckServer } from "../utilities/integration-server";
import { connectRuntimeStream, type RuntimeStreamClient } from "../utilities/runtime-stream-client";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

function createBoard(title: string): RuntimeBoardData {
	const now = Date.now();
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: now,
						updatedAt: now,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function createReviewBoard(taskId: string, title: string, existingTrashTaskId?: string): RuntimeBoardData {
	const now = Date.now();
	const trashCards = existingTrashTaskId
		? [
				{
					id: existingTrashTaskId,
					title: null,
					prompt: "Already trashed task",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: now,
					updatedAt: now,
				},
			]
		: [];
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: taskId,
						title: null,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: now,
						updatedAt: now,
					},
				],
			},
			{ id: "trash", title: "Trash", cards: trashCards },
		],
		dependencies: [],
	};
}

describe.sequential("runtime state stream integration", () => {
	it("starts outside a git repository with no active workspace", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-no-git-");
		const { path: nonGitPath, cleanup: cleanupNonGitPath } = createTempDir("quarterdeck-no-git-");

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: nonGitPath,
			homeDir: tempHome,
			port,
		});

		let stream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			expect(runtimeUrl.pathname).toBe("/");

			const projectsResponse = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
			});
			expect(projectsResponse.status).toBe(200);
			expect(projectsResponse.payload.currentProjectId).toBeNull();
			expect(projectsResponse.payload.projects).toEqual([]);

			stream = await connectRuntimeStream(`ws://127.0.0.1:${port}/api/runtime/ws`);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.currentProjectId).toBeNull();
			expect(snapshot.workspaceState).toBeNull();
			expect(snapshot.projects).toEqual([]);
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			cleanupNonGitPath();
			cleanupHome();
		}
	}, 30_000);

	it("starts from the home directory with no active workspace", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-home-dir-launch-");

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: tempHome,
			homeDir: tempHome,
			port,
		});

		let stream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			expect(runtimeUrl.pathname).toBe("/");

			const projectsResponse = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
			});
			expect(projectsResponse.status).toBe(200);
			expect(projectsResponse.payload.currentProjectId).toBeNull();
			expect(projectsResponse.payload.projects).toEqual([]);

			stream = await connectRuntimeStream(`ws://127.0.0.1:${port}/api/runtime/ws`);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.currentProjectId).toBeNull();
			expect(snapshot.workspaceState).toBeNull();
			expect(snapshot.projects).toEqual([]);
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			cleanupHome();
		}
	}, 30_000);

	it("launches outside git using the first indexed project", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-first-project-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-first-project-");

		const projectAPath = join(tempRoot, "project-a");
		const projectBPath = join(tempRoot, "project-b");
		const nonGitPath = join(tempRoot, "non-git");
		mkdirSync(projectAPath, { recursive: true });
		mkdirSync(projectBPath, { recursive: true });
		mkdirSync(nonGitPath, { recursive: true });
		initGitRepository(projectAPath);
		initGitRepository(projectBPath);

		const firstPort = await getAvailablePort();
		const firstServer = await startQuarterdeckServer({
			cwd: projectAPath,
			homeDir: tempHome,
			port: firstPort,
		});

		let workspaceAId: string | null = null;
		try {
			const firstRuntimeUrl = new URL(firstServer.runtimeUrl);
			workspaceAId = decodeURIComponent(firstRuntimeUrl.pathname.slice(1));
			expect(workspaceAId).not.toBe("");

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
		} finally {
			await firstServer.stop();
		}

		const secondPort = await getAvailablePort();
		const secondServer = await startQuarterdeckServer({
			cwd: nonGitPath,
			homeDir: tempHome,
			port: secondPort,
		});

		let secondStream: RuntimeStreamClient | null = null;
		try {
			const secondRuntimeUrl = new URL(secondServer.runtimeUrl);
			expect(workspaceAId).not.toBeNull();
			if (!workspaceAId) {
				throw new Error("Missing workspace id for project A.");
			}
			const secondWorkspaceId = decodeURIComponent(secondRuntimeUrl.pathname.slice(1));
			expect(secondWorkspaceId).toBe(workspaceAId);
			const expectedProjectAPath = await realpath(projectAPath).catch(() => resolve(projectAPath));

			const projectsResponse = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "projects.list",
				type: "query",
			});
			expect(projectsResponse.status).toBe(200);
			expect(projectsResponse.payload.currentProjectId).toBe(workspaceAId);

			secondStream = await connectRuntimeStream(`ws://127.0.0.1:${secondPort}/api/runtime/ws`);
			const snapshot = (await secondStream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.currentProjectId).toBe(workspaceAId);
			expect(snapshot.workspaceState?.repoPath).toBe(expectedProjectAPath);
		} finally {
			if (secondStream) {
				await secondStream.close();
			}
			await secondServer.stop();
			cleanupRoot();
			cleanupHome();
		}
	}, 45_000);

	it("requires explicit confirmation before initializing git for a non-git added project", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-project-add-git-confirm-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-project-add-git-confirm-");

		const projectAPath = join(tempRoot, "project-a");
		const nonGitPath = join(tempRoot, "non-git-project");
		mkdirSync(projectAPath, { recursive: true });
		mkdirSync(nonGitPath, { recursive: true });
		initGitRepository(projectAPath);

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectAPath,
			homeDir: tempHome,
			port,
		});

		let workspaceAId: string | null = null;
		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			workspaceAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceAId).not.toBe("");

			const addWithoutInitResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: nonGitPath,
				},
			});
			expect(addWithoutInitResponse.status).toBe(200);
			expect(addWithoutInitResponse.payload.ok).toBe(false);
			expect(addWithoutInitResponse.payload.requiresGitInitialization).toBe(true);
			expect(existsSync(join(nonGitPath, ".git"))).toBe(false);

			const projectsAfterDeclinedInit = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				workspaceId: workspaceAId,
			});
			expect(projectsAfterDeclinedInit.status).toBe(200);
			expect(projectsAfterDeclinedInit.payload.projects).toHaveLength(1);

			const addWithInitResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: nonGitPath,
					initializeGit: true,
				},
			});
			expect(addWithInitResponse.status).toBe(200);
			expect(addWithInitResponse.payload.ok).toBe(true);
			expect(addWithInitResponse.payload.project).not.toBeNull();
			expect(existsSync(join(nonGitPath, ".git"))).toBe(true);
		} finally {
			await server.stop();
			cleanupRoot();
			cleanupHome();
		}
	}, 45_000);

	it("streams per-project snapshots and isolates workspace updates", async () => {
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
			const workspaceAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceAId).not.toBe("");
			const expectedProjectAPath = await realpath(projectAPath).catch(() => resolve(projectAPath));
			const expectedProjectBPath = await realpath(projectBPath).catch(() => resolve(projectBPath));

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
			const workspaceBId = addProjectResponse.payload.project?.id ?? null;
			expect(workspaceBId).not.toBeNull();
			if (!workspaceBId) {
				throw new Error("Missing project id for added workspace.");
			}

			streamA = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceAId)}`,
			);
			const snapshotA = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshotA.currentProjectId).toBe(workspaceAId);
			expect(snapshotA.workspaceState?.repoPath).toBe(expectedProjectAPath);
			expect(snapshotA.projects.map((project) => project.id).sort()).toEqual([workspaceAId, workspaceBId].sort());

			streamB = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceBId)}`,
			);
			const snapshotB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshotB.currentProjectId).toBe(workspaceBId);
			expect(snapshotB.workspaceState?.repoPath).toBe(expectedProjectBPath);

			const currentWorkspaceBState = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId: workspaceBId,
			});
			const previousRevision = currentWorkspaceBState.payload.revision;
			const saveWorkspaceBResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId: workspaceBId,
				payload: {
					board: createBoard("Realtime Task"),
					sessions: currentWorkspaceBState.payload.sessions,
					expectedRevision: previousRevision,
				},
			});
			expect(saveWorkspaceBResponse.status).toBe(200);
			expect(saveWorkspaceBResponse.payload.revision).toBe(previousRevision + 1);

			const workspaceUpdateB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamWorkspaceStateMessage =>
					message.type === "workspace_state_updated" && message.workspaceId === workspaceBId,
			)) as RuntimeStateStreamWorkspaceStateMessage;
			expect(workspaceUpdateB.workspaceState.revision).toBe(previousRevision + 1);
			expect(workspaceUpdateB.workspaceState.board.columns[0]?.cards[0]?.prompt).toBe("Realtime Task");

			const streamAMessages = await streamA.collectFor(500);
			expect(
				streamAMessages.some(
					(message) => message.type === "workspace_state_updated" && message.workspaceId === workspaceBId,
				),
			).toBe(false);

			const projectsAfterUpdate = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				workspaceId: workspaceAId,
			});
			expect(projectsAfterUpdate.status).toBe(200);
			const projectB = projectsAfterUpdate.payload.projects.find((project) => project.id === workspaceBId) ?? null;
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
			const workspaceId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			stream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			);

			const taskId = "hook-review-task";
			const startShellResponse = await requestJson<RuntimeShellSessionStartResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.startShellSession",
				type: "mutation",
				workspaceId,
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
					workspaceId,
					event: "to_review",
				},
			});
			expect(hookResponse.status).toBe(200);
			expect(hookResponse.payload.ok).toBe(true);

			const readyMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamTaskReadyForReviewMessage =>
					message.type === "task_ready_for_review" &&
					message.workspaceId === workspaceId &&
					message.taskId === taskId,
			)) as RuntimeStateStreamTaskReadyForReviewMessage;
			expect(readyMessage.type).toBe("task_ready_for_review");
			expect(readyMessage.triggeredAt).toBeGreaterThan(0);

			await requestJson({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.stopTaskSession",
				type: "mutation",
				workspaceId,
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

	it("streams centralized workspace metadata updates for task worktrees", async () => {
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
			const workspaceId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const stateResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
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

			const saveResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board,
					sessions: stateResponse.payload.sessions,
					expectedRevision: stateResponse.payload.revision,
				},
			});
			expect(saveResponse.status).toBe(200);

			const ensureResponse = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.ensureWorktree",
				type: "mutation",
				workspaceId,
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
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			// Metadata is delivered asynchronously via workspace_metadata_updated,
			// not bundled in the snapshot (to avoid blocking on git probe latency).
			expect(snapshot.workspaceMetadata).toBeNull();
			const initialMetadataMessage = await stream.waitForMessage(
				(message) =>
					message.type === "workspace_metadata_updated" &&
					message.workspaceId === workspaceId &&
					message.workspaceMetadata.taskWorkspaces.some((task) => task.taskId === taskId),
				10_000,
			);
			expect(initialMetadataMessage.type).toBe("workspace_metadata_updated");
			if (initialMetadataMessage.type !== "workspace_metadata_updated") {
				throw new Error("Expected initial workspace metadata update message.");
			}
			const initialTaskMetadata =
				initialMetadataMessage.workspaceMetadata.taskWorkspaces.find((task) => task.taskId === taskId) ?? null;
			expect(initialTaskMetadata).not.toBeNull();
			expect(initialTaskMetadata?.changedFiles ?? 0).toBe(0);
			expect(
				initialMetadataMessage.workspaceMetadata.taskWorkspaces.some((task) => task.taskId === trashTaskId),
			).toBe(false);

			writeFileSync(join(ensureResponse.payload.path, "task-change.txt"), "updated\n", "utf8");

			const metadataMessage = await stream.waitForMessage(
				(message) =>
					message.type === "workspace_metadata_updated" &&
					message.workspaceId === workspaceId &&
					message.workspaceMetadata.taskWorkspaces.some(
						(task) => task.taskId === taskId && (task.changedFiles ?? 0) > 0,
					),
				10_000,
			);
			expect(metadataMessage.type).toBe("workspace_metadata_updated");
			if (metadataMessage.type !== "workspace_metadata_updated") {
				throw new Error("Expected workspace metadata update message.");
			}
			const updatedTaskMetadata = metadataMessage.workspaceMetadata.taskWorkspaces.find(
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

	it("preserves existing task worktree when base ref advances", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-preserve-worktree-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck-project-preserve-worktree-");

		mkdirSync(projectPath, { recursive: true });
		initGitRepository(projectPath);
		runGit(projectPath, ["config", "user.name", "Test User"]);
		runGit(projectPath, ["config", "user.email", "test@example.com"]);
		writeFileSync(join(projectPath, "initial.txt"), "one\n", "utf8");
		const firstBaseCommit = commitAll(projectPath, "initial commit");
		const baseRef = runGit(projectPath, ["symbolic-ref", "--short", "HEAD"]);

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port,
		});

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const workspaceId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const stateResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(stateResponse.status).toBe(200);

			const taskId = "preserve-worktree-task";
			const board = createBoard("Preserve existing worktree");
			const backlogColumn = board.columns.find((column) => column.id === "backlog");
			if (!backlogColumn?.cards[0]) {
				throw new Error("Expected a backlog card for seed board.");
			}
			backlogColumn.cards[0].id = taskId;
			backlogColumn.cards[0].baseRef = baseRef;

			const saveResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board,
					sessions: stateResponse.payload.sessions,
					expectedRevision: stateResponse.payload.revision,
				},
			});
			expect(saveResponse.status).toBe(200);

			const firstEnsure = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.ensureWorktree",
				type: "mutation",
				workspaceId,
				payload: {
					taskId,
					baseRef,
				},
			});
			expect(firstEnsure.status).toBe(200);
			expect(firstEnsure.payload.ok).toBe(true);
			if (!firstEnsure.payload.ok) {
				throw new Error(firstEnsure.payload.error ?? "ensureWorktree failed");
			}
			expect(firstEnsure.payload.baseCommit).toBe(firstBaseCommit);

			runGit(firstEnsure.payload.path, ["config", "user.name", "Task User"]);
			runGit(firstEnsure.payload.path, ["config", "user.email", "task@example.com"]);
			writeFileSync(join(firstEnsure.payload.path, "task-local.txt"), "task commit\n", "utf8");
			const taskWorktreeCommit = commitAll(firstEnsure.payload.path, "task-local commit");

			writeFileSync(join(projectPath, "advance-base.txt"), "two\n", "utf8");
			const advancedBaseCommit = commitAll(projectPath, "advance base");
			expect(advancedBaseCommit).not.toBe(firstBaseCommit);

			const secondEnsure = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.ensureWorktree",
				type: "mutation",
				workspaceId,
				payload: {
					taskId,
					baseRef,
				},
			});
			expect(secondEnsure.status).toBe(200);
			expect(secondEnsure.payload.ok).toBe(true);
			if (!secondEnsure.payload.ok) {
				throw new Error(secondEnsure.payload.error ?? "ensureWorktree failed");
			}
			expect(secondEnsure.payload.path).toBe(firstEnsure.payload.path);
			expect(secondEnsure.payload.baseCommit).toBe(taskWorktreeCommit);

			const taskContext = await requestJson<RuntimeTaskWorkspaceInfoResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.getTaskContext",
				type: "query",
				workspaceId,
				payload: {
					taskId,
					baseRef,
				},
			});
			expect(taskContext.status).toBe(200);
			expect(taskContext.payload.headCommit).toBe(taskWorktreeCommit);
		} finally {
			await server.stop();
			cleanupProject();
			cleanupHome();
		}
	}, 45_000);

	it("preserves stale review cards in review column and marks sessions interrupted on shutdown", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-stale-exit-review-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck-project-stale-exit-review-");

		mkdirSync(projectPath, { recursive: true });
		initGitRepository(projectPath);

		const taskId = "stale-exit-review-task";
		const taskTitle = "Stale Exit Review Task";
		const now = Date.now();

		const firstPort = await getAvailablePort();
		const firstServer = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port: firstPort,
		});

		try {
			const firstRuntimeUrl = new URL(firstServer.runtimeUrl);
			const workspaceId = decodeURIComponent(firstRuntimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const currentState = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(currentState.status).toBe(200);

			const seedResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board: createReviewBoard(taskId, taskTitle),
					sessions: {
						[taskId]: {
							taskId,
							state: "awaiting_review",
							agentId: "codex",
							workspacePath: projectPath,
							pid: null,
							startedAt: now - 2_000,
							updatedAt: now,
							lastOutputAt: now,
							reviewReason: "exit",
							exitCode: 0,
							lastHookAt: null,
							latestHookActivity: null,
						},
					},
					expectedRevision: currentState.payload.revision,
				},
			});
			expect(seedResponse.status).toBe(200);
			const taskWorkspaceInfo = await requestJson<RuntimeTaskWorkspaceInfoResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.getTaskContext",
				type: "query",
				workspaceId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(taskWorkspaceInfo.status).toBe(200);
			mkdirSync(taskWorkspaceInfo.payload.path, { recursive: true });
		} finally {
			await firstServer.stop();
		}

		const secondPort = await getAvailablePort();
		const secondServer = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port: secondPort,
		});

		try {
			const secondRuntimeUrl = new URL(secondServer.runtimeUrl);
			const workspaceId = decodeURIComponent(secondRuntimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const finalState = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(finalState.status).toBe(200);

			const reviewCards = finalState.payload.board.columns.find((column) => column.id === "review")?.cards ?? [];
			const trashCards = finalState.payload.board.columns.find((column) => column.id === "trash")?.cards ?? [];
			expect(reviewCards.some((card) => card.id === taskId)).toBe(true);
			expect(trashCards.some((card) => card.id === taskId)).toBe(false);
			expect(finalState.payload.sessions[taskId]?.state).toBe("interrupted");
			expect(finalState.payload.sessions[taskId]?.reviewReason).toBe("interrupted");
			const workspaceInfo = await requestJson<RuntimeTaskWorkspaceInfoResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "workspace.getTaskContext",
				type: "query",
				workspaceId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(workspaceInfo.status).toBe(200);
			expect(workspaceInfo.payload.exists).toBe(true);
		} finally {
			await secondServer.stop();
			cleanupProject();
			cleanupHome();
		}
	}, 45_000);

	it("skips stale session shutdown cleanup when --skip-shutdown-cleanup is enabled", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-skip-cleanup-flag-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck-project-skip-cleanup-flag-");

		mkdirSync(projectPath, { recursive: true });
		initGitRepository(projectPath);

		const taskId = "skip-cleanup-flag-review-task";
		const taskTitle = "Keep review task when cleanup flag is enabled";
		const now = Date.now();

		const firstPort = await getAvailablePort();
		const firstServer = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port: firstPort,
			extraArgs: ["--skip-shutdown-cleanup"],
		});

		try {
			const firstRuntimeUrl = new URL(firstServer.runtimeUrl);
			const workspaceId = decodeURIComponent(firstRuntimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const currentState = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(currentState.status).toBe(200);

			const seedResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board: createReviewBoard(taskId, taskTitle),
					sessions: {
						[taskId]: {
							taskId,
							state: "awaiting_review",
							agentId: "codex",
							workspacePath: projectPath,
							pid: null,
							startedAt: now - 2_000,
							updatedAt: now,
							lastOutputAt: now,
							reviewReason: "hook",
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: null,
						},
					},
					expectedRevision: currentState.payload.revision,
				},
			});
			expect(seedResponse.status).toBe(200);

			const taskWorkspaceInfo = await requestJson<RuntimeTaskWorkspaceInfoResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.getTaskContext",
				type: "query",
				workspaceId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(taskWorkspaceInfo.status).toBe(200);
			mkdirSync(taskWorkspaceInfo.payload.path, { recursive: true });
		} finally {
			await firstServer.stop();
		}

		const secondPort = await getAvailablePort();
		const secondServer = await startQuarterdeckServer({
			cwd: projectPath,
			homeDir: tempHome,
			port: secondPort,
		});

		try {
			const secondRuntimeUrl = new URL(secondServer.runtimeUrl);
			const workspaceId = decodeURIComponent(secondRuntimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const finalState = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(finalState.status).toBe(200);

			const reviewCards = finalState.payload.board.columns.find((column) => column.id === "review")?.cards ?? [];
			const trashCards = finalState.payload.board.columns.find((column) => column.id === "trash")?.cards ?? [];
			expect(reviewCards.some((card) => card.id === taskId)).toBe(true);
			expect(trashCards.some((card) => card.id === taskId)).toBe(false);
			expect(finalState.payload.sessions[taskId]?.state).toBe("awaiting_review");
			expect(finalState.payload.sessions[taskId]?.reviewReason).toBe("hook");

			const workspaceInfo = await requestJson<RuntimeTaskWorkspaceInfoResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "workspace.getTaskContext",
				type: "query",
				workspaceId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(workspaceInfo.status).toBe(200);
			expect(workspaceInfo.payload.exists).toBe(true);
		} finally {
			await secondServer.stop();
			cleanupProject();
			cleanupHome();
		}
	}, 45_000);

	it("falls back to remaining project when removing the active project", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-remove-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-projects-remove-");

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
			const workspaceAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceAId).not.toBe("");
			const expectedProjectBPath = await realpath(projectBPath).catch(() => resolve(projectBPath));

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
			const workspaceBId = addProjectResponse.payload.project?.id ?? null;
			expect(workspaceBId).not.toBeNull();
			if (!workspaceBId) {
				throw new Error("Missing project id for added workspace.");
			}

			streamA = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceAId)}`,
			);
			const initialSnapshot = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(initialSnapshot.currentProjectId).toBe(workspaceAId);

			const removeResponse = await requestJson<RuntimeProjectRemoveResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.remove",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					projectId: workspaceAId,
				},
			});
			expect(removeResponse.status).toBe(200);
			expect(removeResponse.payload.ok).toBe(true);

			const projectsUpdated = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamProjectsMessage =>
					message.type === "projects_updated" && message.currentProjectId === workspaceBId,
			)) as RuntimeStateStreamProjectsMessage;
			expect(projectsUpdated.currentProjectId).toBe(workspaceBId);
			expect(projectsUpdated.projects.map((project) => project.id)).toEqual([workspaceBId]);

			streamB = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceBId)}`,
			);
			const fallbackSnapshot = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(fallbackSnapshot.currentProjectId).toBe(workspaceBId);
			expect(fallbackSnapshot.workspaceState?.repoPath).toBe(expectedProjectBPath);

			const projectsAfterRemoval = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				workspaceId: workspaceBId,
			});
			expect(projectsAfterRemoval.status).toBe(200);
			expect(projectsAfterRemoval.payload.currentProjectId).toBe(workspaceBId);
			expect(projectsAfterRemoval.payload.projects.map((project) => project.id)).toEqual([workspaceBId]);
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
});
