import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core";
import { shutdownRuntimeServer } from "../../src/server";
import { loadProjectState, saveProjectState } from "../../src/state";
import type { TerminalSessionManager } from "../../src/terminal";
import { initGitRepository } from "../utilities/git-env";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

function createCard(taskId: string) {
	return {
		id: taskId,
		title: null,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: { inProgress?: string[]; review?: string[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: (taskIds.inProgress ?? []).map((taskId) => createCard(taskId)),
			},
			{
				id: "review",
				title: "Review",
				cards: (taskIds.review ?? []).map((taskId) => createCard(taskId)),
			},
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function createSession(
	taskId: string,
	state: "running" | "awaiting_review" | "idle" | "interrupted",
): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state,
		agentId: "codex",
		sessionLaunchPath: `/tmp/${taskId}`,
		pid: state === "idle" || state === "interrupted" ? null : 1234,
		startedAt: state === "idle" ? null : Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: state === "idle" ? null : Date.now(),
		reviewReason: state === "awaiting_review" ? "hook" : state === "interrupted" ? "interrupted" : null,
	});
}

describe.sequential("shutdown coordinator integration", () => {
	it("preserves cards in their columns and marks sessions interrupted on shutdown", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("quarterdeck-shutdown-scope-");
			try {
				const managedProjectPath = join(sandboxRoot, "managed-project");
				const indexedProjectPath = join(sandboxRoot, "indexed-project");
				mkdirSync(managedProjectPath, { recursive: true });
				mkdirSync(indexedProjectPath, { recursive: true });
				initGitRepository(managedProjectPath);
				initGitRepository(indexedProjectPath);

				const managedInitial = await loadProjectState(managedProjectPath);
				const managedSaved = await saveProjectState(managedProjectPath, {
					board: createBoard({
						inProgress: ["managed-running", "managed-missing-session"],
						review: ["managed-idle"],
					}),
					sessions: {
						"managed-running": createSession("managed-running", "running"),
						"managed-idle": createSession("managed-idle", "idle"),
					},
					expectedRevision: managedInitial.revision,
				});

				const indexedInitial = await loadProjectState(indexedProjectPath);
				const indexedSaved = await saveProjectState(indexedProjectPath, {
					board: createBoard({
						inProgress: ["indexed-missing-session"],
						review: ["indexed-awaiting-review"],
					}),
					sessions: {
						"indexed-awaiting-review": createSession("indexed-awaiting-review", "awaiting_review"),
					},
					expectedRevision: indexedInitial.revision,
				});

				let didCloseRuntimeServer = false;
				const interruptedManagedRunning = createSession("managed-running", "interrupted");
				const managedTerminalManager = {
					stopReconciliation: () => {},
					markInterruptedAndStopAll: () => [interruptedManagedRunning],
					store: {
						listSummaries: () => [interruptedManagedRunning],
						getSummary: (taskId: string) => {
							if (taskId === "managed-running") {
								return interruptedManagedRunning;
							}
							if (taskId === "managed-idle") {
								return createSession("managed-idle", "idle");
							}
							return null;
						},
					},
				} as unknown as TerminalSessionManager;
				await shutdownRuntimeServer({
					projectRegistry: {
						listManagedProjects: () => [
							{
								projectId: "managed-project",
								projectPath: managedProjectPath,
								terminalManager: managedTerminalManager,
							},
						],
					},
					warn: () => {},
					closeRuntimeServer: async () => {
						didCloseRuntimeServer = true;
					},
				});

				expect(didCloseRuntimeServer).toBe(true);

				// Cards stay in their original columns — not moved to trash.
				const managedAfter = await loadProjectState(managedProjectPath);
				expect(managedAfter.revision).toBe(managedSaved.revision);
				const managedInProgress =
					managedAfter.board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
				const managedReview = managedAfter.board.columns.find((column) => column.id === "review")?.cards ?? [];
				const managedTrash = managedAfter.board.columns.find((column) => column.id === "trash")?.cards ?? [];
				expect(managedInProgress.map((card) => card.id).sort()).toEqual(
					["managed-missing-session", "managed-running"].sort(),
				);
				expect(managedReview.map((card) => card.id)).toEqual(["managed-idle"]);
				expect(managedTrash).toEqual([]);

				// Running sessions are marked interrupted on shutdown.
				expect(managedAfter.sessions["managed-running"]?.state).toBe("interrupted");
				// Idle sessions are not actively working — left as-is.
				expect(managedAfter.sessions["managed-idle"]?.state).toBe("idle");
				// Tasks without a pre-existing session record are unchanged.
				expect(managedAfter.sessions["managed-missing-session"]).toBeUndefined();

				// Indexed (non-managed) projects are also preserved in place.
				const indexedAfter = await loadProjectState(indexedProjectPath);
				expect(indexedAfter.revision).toBe(indexedSaved.revision);
				const indexedInProgress =
					indexedAfter.board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
				const indexedReview = indexedAfter.board.columns.find((column) => column.id === "review")?.cards ?? [];
				const indexedTrash = indexedAfter.board.columns.find((column) => column.id === "trash")?.cards ?? [];
				expect(indexedInProgress.map((card) => card.id)).toEqual(["indexed-missing-session"]);
				expect(indexedReview.map((card) => card.id)).toEqual(["indexed-awaiting-review"]);
				expect(indexedTrash).toEqual([]);
				// awaiting_review with terminal review reason ("hook") is preserved.
				expect(indexedAfter.sessions["indexed-awaiting-review"]?.state).toBe("awaiting_review");
				expect(indexedAfter.sessions["indexed-missing-session"]).toBeUndefined();
			} finally {
				cleanup();
			}
		});
	}, 30_000);
});
