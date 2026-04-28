import { describe, expect, it } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestProjectStateResponse, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import {
	applyAuthoritativeProjectBoard,
	applyAuthoritativeProjectState,
	type CachedProjectBoardRestore,
	type ProjectVersion,
	reconcileAuthoritativeTaskSessionSummaries,
	resolveAuthoritativeBoardAction,
	shouldApplyProjectUpdate,
} from "./project-sync";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSession(taskId: string, startedAt: number | null, updatedAt: number): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: "idle",
		agentId: "claude",
		sessionLaunchPath: `/tmp/${taskId}`,
		startedAt,
		updatedAt,
	});
}

function createProjectState(
	revision: number,
	board = createInitialBoardData(),
	sessions: Record<string, RuntimeTaskSessionSummary> = {},
) {
	return createTestProjectStateResponse({
		board,
		sessions,
		revision,
	});
}

describe("reconcileAuthoritativeTaskSessionSummaries", () => {
	it("drops sessions missing from the incoming authoritative project state", () => {
		const current = {
			"task-1": makeSession("task-1", 100, 100),
			"task-2": makeSession("task-2", 150, 150),
		};
		const next = { "task-1": makeSession("task-1", 200, 200) };

		const result = reconcileAuthoritativeTaskSessionSummaries(current, next);

		expect(result["task-1"]?.startedAt).toBe(200);
		expect(result["task-2"]).toBeUndefined();
	});

	it("keeps the newer overlapping summary when the authoritative update replays older data", () => {
		const current = { "task-1": makeSession("task-1", 200, 200) };
		const next = { "task-1": makeSession("task-1", 100, 100) };

		const result = reconcileAuthoritativeTaskSessionSummaries(current, next);

		expect(result["task-1"]?.startedAt).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// shouldApplyProjectUpdate
// ---------------------------------------------------------------------------

describe("shouldApplyProjectUpdate", () => {
	it("returns 'apply' on first load (null revision)", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: null };

		expect(shouldApplyProjectUpdate(version, "proj-1", 1)).toBe("apply");
	});

	it("returns 'apply' when incoming revision is newer", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyProjectUpdate(version, "proj-1", 6)).toBe("apply");
	});

	it("returns 'apply' when incoming revision equals current", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyProjectUpdate(version, "proj-1", 5)).toBe("apply");
	});

	it("returns 'skip' when incoming revision is older", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(shouldApplyProjectUpdate(version, "proj-1", 3)).toBe("skip");
	});

	it("returns 'apply' when switching projects (different projectId)", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 10 };

		expect(shouldApplyProjectUpdate(version, "proj-2", 1)).toBe("apply");
	});
});

// ---------------------------------------------------------------------------
// resolveAuthoritativeBoardAction
// ---------------------------------------------------------------------------

describe("resolveAuthoritativeBoardAction", () => {
	it("hydrates when switching projects without a matching cache restore", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(resolveAuthoritativeBoardAction(version, "proj-2", 1, null)).toBe("hydrate");
	});

	it("hydrates when revision changes within the same project", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(resolveAuthoritativeBoardAction(version, "proj-1", 6, null)).toBe("hydrate");
	});

	it("skips hydration when the same authoritative revision is already applied", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: 5 };

		expect(resolveAuthoritativeBoardAction(version, "proj-1", 5, null)).toBe("skip");
	});

	it("confirms a cached restore when the server sends the same revision", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: null };
		const cachedRestore: CachedProjectBoardRestore = {
			projectId: "proj-1",
			authoritativeRevision: 7,
		};

		expect(resolveAuthoritativeBoardAction(version, "proj-1", 7, cachedRestore)).toBe("confirm_cache");
	});

	it("hydrates on first load when there is no matching cached restore", () => {
		const version: ProjectVersion = { projectId: "proj-1", revision: null };

		expect(resolveAuthoritativeBoardAction(version, "proj-1", 1, null)).toBe("hydrate");
	});
});

describe("applyAuthoritativeProjectBoard", () => {
	it("projects runtime-owned work-column placement onto the hydrated board", () => {
		const board = createInitialBoardData();
		const inProgressColumn = board.columns.find((column) => column.id === "in_progress");
		if (!inProgressColumn) {
			throw new Error("Missing in-progress column.");
		}
		inProgressColumn.cards.push({
			id: "task-1",
			title: null,
			prompt: "Prompt",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		const result = applyAuthoritativeProjectBoard(board, {
			"task-1": {
				...makeSession("task-1", 100, 100),
				state: "awaiting_review",
				reviewReason: "hook",
			},
		});

		expect(result.shouldSkipPersistOnHydration).toBe(false);
		expect(result.board.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(0);
		expect(result.board.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe("task-1");
	});

	it("skips persistence when authoritative hydrate already matches runtime projection", () => {
		const board = createInitialBoardData();

		const result = applyAuthoritativeProjectBoard(board, {});

		expect(result.board).toBe(board);
		expect(result.shouldSkipPersistOnHydration).toBe(true);
	});
});

describe("applyAuthoritativeProjectState", () => {
	it("derives sessions and board projection from the same current local snapshot", () => {
		const currentBoard = createInitialBoardData();
		const reviewColumn = currentBoard.columns.find((column) => column.id === "review");
		if (!reviewColumn) {
			throw new Error("Missing review column.");
		}
		reviewColumn.cards.push({
			id: "task-1",
			title: null,
			prompt: "Prompt",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});
		const incomingBoard = createInitialBoardData();
		const inProgressColumn = incomingBoard.columns.find((column) => column.id === "in_progress");
		if (!inProgressColumn) {
			throw new Error("Missing in-progress column.");
		}
		inProgressColumn.cards.push({
			id: "task-1",
			title: null,
			prompt: "Prompt",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		const result = applyAuthoritativeProjectState({
			currentState: {
				board: currentBoard,
				sessions: {
					"task-1": {
						...makeSession("task-1", 200, 200),
						state: "awaiting_review",
						reviewReason: "hook",
					},
				},
			},
			currentVersion: { projectId: "proj-1", revision: 1 },
			currentProjectId: "proj-1",
			incomingProjectState: createProjectState(2, incomingBoard, {
				"task-1": {
					...makeSession("task-1", 100, 100),
					state: "running",
				},
			}),
			cachedRestore: null,
		});

		expect(result).not.toBeNull();
		expect(result?.nextState.sessions["task-1"]?.state).toBe("awaiting_review");
		expect(result?.nextState.board.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(0);
		expect(result?.nextState.board.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe("task-1");
		expect(result?.shouldBumpHydrationNonce).toBe(true);
	});

	it("confirms a cached board without hydrating when runtime projection already matches", () => {
		const result = applyAuthoritativeProjectState({
			currentState: {
				board: createInitialBoardData(),
				sessions: {},
			},
			currentVersion: { projectId: "proj-1", revision: null },
			currentProjectId: "proj-1",
			incomingProjectState: createProjectState(3),
			cachedRestore: {
				projectId: "proj-1",
				authoritativeRevision: 3,
			},
		});

		expect(result).not.toBeNull();
		expect(result?.boardAction).toBe("confirm_cache");
		expect(result?.shouldBumpHydrationNonce).toBe(false);
		expect(result?.shouldSkipPersistOnHydration).toBe(true);
	});

	it("re-projects a same-revision cached board when authoritative runtime truth changes work-column placement", () => {
		const cachedBoard = createInitialBoardData();
		const inProgressColumn = cachedBoard.columns.find((column) => column.id === "in_progress");
		if (!inProgressColumn) {
			throw new Error("Missing in-progress column.");
		}
		inProgressColumn.cards.push({
			id: "task-1",
			title: null,
			prompt: "Prompt",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		const result = applyAuthoritativeProjectState({
			currentState: {
				board: cachedBoard,
				sessions: {
					"task-1": {
						...makeSession("task-1", 100, 100),
						state: "running",
					},
				},
			},
			currentVersion: { projectId: "proj-1", revision: null },
			currentProjectId: "proj-1",
			incomingProjectState: createProjectState(3, createInitialBoardData(), {
				"task-1": {
					...makeSession("task-1", 200, 200),
					state: "awaiting_review",
					reviewReason: "hook",
				},
			}),
			cachedRestore: {
				projectId: "proj-1",
				authoritativeRevision: 3,
			},
		});

		expect(result).not.toBeNull();
		expect(result?.boardAction).toBe("confirm_cache");
		expect(result?.shouldBumpHydrationNonce).toBe(true);
		expect(result?.nextState.board.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(0);
		expect(result?.nextState.board.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe("task-1");
	});
});
