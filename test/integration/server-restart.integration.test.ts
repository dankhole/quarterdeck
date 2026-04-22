import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeProjectStateResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorktreeInfoResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core";
import { saveProjectState } from "../../src/state";
import { createBoard, createReviewBoard } from "../utilities/board-factory";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { getAvailablePort, startQuarterdeckServer } from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

async function withStateHomeOverride<T>(stateHome: string, run: () => Promise<T>): Promise<T> {
	const previousStateHome = process.env.QUARTERDECK_STATE_HOME;
	// This only scopes the in-process low-level state writer to the same
	// runtime-state root the spawned test server uses under HOME/.quarterdeck.
	process.env.QUARTERDECK_STATE_HOME = join(stateHome, ".quarterdeck");
	try {
		return await run();
	} finally {
		if (previousStateHome === undefined) {
			delete process.env.QUARTERDECK_STATE_HOME;
		} else {
			process.env.QUARTERDECK_STATE_HOME = previousStateHome;
		}
	}
}

function createPersistedReviewSession(
	taskId: string,
	sessionLaunchPath: string,
	now: number,
	reviewReason: "exit" | "hook",
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "awaiting_review",
		agentId: "codex",
		sessionLaunchPath,
		pid: null,
		startedAt: now - 2_000,
		updatedAt: now,
		lastOutputAt: now,
		reviewReason,
		exitCode: reviewReason === "exit" ? 0 : null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

describe.sequential("server restart integration", () => {
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
			const projectId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(projectId).not.toBe("");

			const stateResponse = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getState",
				type: "query",
				projectId,
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

			const firstEnsure = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.ensureWorktree",
				type: "mutation",
				projectId,
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
				procedure: "project.ensureWorktree",
				type: "mutation",
				projectId,
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

			const taskContext = await requestJson<RuntimeTaskWorktreeInfoResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "project.getTaskContext",
				type: "query",
				projectId,
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

	it("preserves review cards with terminal review reasons across server restart", async () => {
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
			const projectId = decodeURIComponent(firstRuntimeUrl.pathname.slice(1));
			expect(projectId).not.toBe("");

			const currentState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(currentState.status).toBe(200);

			const boardSeedResponse = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "project.saveState",
				type: "mutation",
				projectId,
				payload: {
					board: createReviewBoard(taskId, taskTitle),
					expectedRevision: currentState.payload.revision,
				},
			});
			expect(boardSeedResponse.status).toBe(200);

			const seedResponse = await withStateHomeOverride(
				tempHome,
				async () =>
					await saveProjectState(projectPath, {
						board: boardSeedResponse.payload.board,
						sessions: {
							[taskId]: createPersistedReviewSession(taskId, projectPath, now, "exit"),
						},
						expectedRevision: boardSeedResponse.payload.revision,
					}),
			);
			expect(seedResponse.revision).toBe(boardSeedResponse.payload.revision + 1);
			const taskWorktreeInfo = await requestJson<RuntimeTaskWorktreeInfoResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "project.getTaskContext",
				type: "query",
				projectId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(taskWorktreeInfo.status).toBe(200);
			mkdirSync(taskWorktreeInfo.payload.path, { recursive: true });
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
			const projectId = decodeURIComponent(secondRuntimeUrl.pathname.slice(1));
			expect(projectId).not.toBe("");

			const finalState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(finalState.status).toBe(200);

			const reviewCards = finalState.payload.board.columns.find((column) => column.id === "review")?.cards ?? [];
			const trashCards = finalState.payload.board.columns.find((column) => column.id === "trash")?.cards ?? [];
			expect(reviewCards.some((card) => card.id === taskId)).toBe(true);
			expect(trashCards.some((card) => card.id === taskId)).toBe(false);
			expect(finalState.payload.sessions[taskId]?.state).toBe("awaiting_review");
			expect(finalState.payload.sessions[taskId]?.reviewReason).toBe("exit");
			const worktreeInfo = await requestJson<RuntimeTaskWorktreeInfoResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "project.getTaskContext",
				type: "query",
				projectId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(worktreeInfo.status).toBe(200);
			expect(worktreeInfo.payload.exists).toBe(true);
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
			const projectId = decodeURIComponent(firstRuntimeUrl.pathname.slice(1));
			expect(projectId).not.toBe("");

			const currentState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(currentState.status).toBe(200);

			const boardSeedResponse = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "project.saveState",
				type: "mutation",
				projectId,
				payload: {
					board: createReviewBoard(taskId, taskTitle),
					expectedRevision: currentState.payload.revision,
				},
			});
			expect(boardSeedResponse.status).toBe(200);

			const seedResponse = await withStateHomeOverride(
				tempHome,
				async () =>
					await saveProjectState(projectPath, {
						board: boardSeedResponse.payload.board,
						sessions: {
							[taskId]: createPersistedReviewSession(taskId, projectPath, now, "hook"),
						},
						expectedRevision: boardSeedResponse.payload.revision,
					}),
			);
			expect(seedResponse.revision).toBe(boardSeedResponse.payload.revision + 1);

			const taskWorktreeInfo = await requestJson<RuntimeTaskWorktreeInfoResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "project.getTaskContext",
				type: "query",
				projectId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(taskWorktreeInfo.status).toBe(200);
			mkdirSync(taskWorktreeInfo.payload.path, { recursive: true });
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
			const projectId = decodeURIComponent(secondRuntimeUrl.pathname.slice(1));
			expect(projectId).not.toBe("");

			const finalState = await requestJson<RuntimeProjectStateResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(finalState.status).toBe(200);

			const reviewCards = finalState.payload.board.columns.find((column) => column.id === "review")?.cards ?? [];
			const trashCards = finalState.payload.board.columns.find((column) => column.id === "trash")?.cards ?? [];
			expect(reviewCards.some((card) => card.id === taskId)).toBe(true);
			expect(trashCards.some((card) => card.id === taskId)).toBe(false);
			expect(finalState.payload.sessions[taskId]?.state).toBe("awaiting_review");
			expect(finalState.payload.sessions[taskId]?.reviewReason).toBe("hook");

			const worktreeInfo = await requestJson<RuntimeTaskWorktreeInfoResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "project.getTaskContext",
				type: "query",
				projectId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(worktreeInfo.status).toBe(200);
			expect(worktreeInfo.payload.exists).toBe(true);
		} finally {
			await secondServer.stop();
			cleanupProject();
			cleanupHome();
		}
	}, 45_000);
});
