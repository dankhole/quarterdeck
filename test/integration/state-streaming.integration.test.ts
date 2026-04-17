import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeHookIngestResponse,
	RuntimeProjectAddResponse,
	RuntimeProjectStateResponse,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartResponse,
	RuntimeStateStreamProjectStateMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core";
import { createBoard, createReviewBoard } from "../utilities/board-factory";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { getAvailablePort, startQuarterdeckServer } from "../utilities/integration-server";
import { connectRuntimeStream, type RuntimeStreamClient } from "../utilities/runtime-stream-client";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

describe.sequential("state streaming integration", () => {
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
				projectId: workspaceAId,
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
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(workspaceAId)}`,
			);
			const snapshotA = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshotA.currentProjectId).toBe(workspaceAId);
			expect(snapshotA.projectState?.repoPath).toBe(expectedProjectAPath);
			expect(snapshotA.projects.map((project) => project.id).sort()).toEqual([workspaceAId, workspaceBId].sort());

			streamB = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(workspaceBId)}`,
			);
			const snapshotB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshotB.currentProjectId).toBe(workspaceBId);
			expect(snapshotB.projectState?.repoPath).toBe(expectedProjectBPath);

			const currentWorkspaceBState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId: workspaceBId,
			});
			const previousRevision = currentWorkspaceBState.payload.revision;
			const saveWorkspaceBResponse = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.saveState",
				type: "mutation",
				projectId: workspaceBId,
				payload: {
					board: createBoard("Realtime Task"),
					sessions: currentWorkspaceBState.payload.sessions,
					expectedRevision: previousRevision,
				},
			});
			expect(saveWorkspaceBResponse.status).toBe(200);
			expect(saveWorkspaceBResponse.payload.revision).toBe(previousRevision + 1);

			const workspaceUpdateB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamProjectStateMessage =>
					message.type === "project_state_updated" && message.projectId === workspaceBId,
			)) as RuntimeStateStreamProjectStateMessage;
			expect(workspaceUpdateB.projectState.revision).toBe(previousRevision + 1);
			expect(workspaceUpdateB.projectState.board.columns[0]?.cards[0]?.prompt).toBe("Realtime Task");

			const streamAMessages = await streamA.collectFor(500);
			expect(
				streamAMessages.some(
					(message) => message.type === "project_state_updated" && message.projectId === workspaceBId,
				),
			).toBe(false);

			const projectsAfterUpdate = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				projectId: workspaceAId,
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
					sessions: stateResponse.payload.sessions,
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
					message.projectMetadata.taskWorkspaces.some((task) => task.taskId === taskId),
				10_000,
			);
			expect(initialMetadataMessage.type).toBe("project_metadata_updated");
			if (initialMetadataMessage.type !== "project_metadata_updated") {
				throw new Error("Expected initial workspace metadata update message.");
			}
			const initialTaskMetadata =
				initialMetadataMessage.projectMetadata.taskWorkspaces.find((task) => task.taskId === taskId) ?? null;
			expect(initialTaskMetadata).not.toBeNull();
			expect(initialTaskMetadata?.changedFiles ?? 0).toBe(0);
			expect(initialMetadataMessage.projectMetadata.taskWorkspaces.some((task) => task.taskId === trashTaskId)).toBe(
				false,
			);

			writeFileSync(join(ensureResponse.payload.path, "task-change.txt"), "updated\n", "utf8");

			const metadataMessage = await stream.waitForMessage(
				(message) =>
					message.type === "project_metadata_updated" &&
					message.projectId === projectId &&
					message.projectMetadata.taskWorkspaces.some(
						(task) => task.taskId === taskId && (task.changedFiles ?? 0) > 0,
					),
				10_000,
			);
			expect(metadataMessage.type).toBe("project_metadata_updated");
			if (metadataMessage.type !== "project_metadata_updated") {
				throw new Error("Expected workspace metadata update message.");
			}
			const updatedTaskMetadata = metadataMessage.projectMetadata.taskWorkspaces.find(
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
