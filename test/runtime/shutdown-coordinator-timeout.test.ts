import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { shutdownRuntimeServer } from "../../src/server/shutdown-coordinator";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";

vi.mock("../../src/state/workspace-state.js", () => ({
	loadWorkspaceState: vi.fn(),
	saveWorkspaceState: vi.fn(),
	listWorkspaceIndexEntries: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: vi.fn().mockResolvedValue({ ok: true, removed: false }),
}));

vi.mock("../../src/core/task-board-mutations.js", () => ({
	updateTaskDependencies: (board: RuntimeBoardData) => board,
}));

vi.mock("../../src/server/workspace-registry.js", () => ({
	collectProjectWorktreeTaskIdsForRemoval: () => new Set<string>(),
}));

function createBoard(inProgressTaskIds: string[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: inProgressTaskIds.map((id) => ({
					id,
					title: null,
					prompt: `Task ${id}`,
					startInPlanMode: false,
					baseRef: "main",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				})),
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function createTerminalManagerStub(taskIds: string[]): TerminalSessionManager {
	const summaries: RuntimeTaskSessionSummary[] = taskIds.map((taskId) => ({
		taskId,
		state: "running" as const,
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	}));
	return {
		stopReconciliation: vi.fn(),
		markInterruptedAndStopAll: vi.fn().mockReturnValue(summaries),
		store: {
			listSummaries: vi.fn().mockReturnValue(summaries),
			getSummary: vi.fn((taskId: string) => summaries.find((s) => s.taskId === taskId) ?? null),
		},
	} as unknown as TerminalSessionManager;
}

describe("shutdown coordinator timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("calls closeRuntimeServer even when cleanup operations hang", async () => {
		vi.useFakeTimers();

		const { loadWorkspaceState, saveWorkspaceState } = await import("../../src/state/workspace-state.js");
		const mockLoadWorkspaceState = vi.mocked(loadWorkspaceState);
		const mockSaveWorkspaceState = vi.mocked(saveWorkspaceState);

		const board = createBoard(["task-1"]);
		mockLoadWorkspaceState.mockResolvedValue({
			repoPath: "/tmp/test-project",
			statePath: "/tmp/test-project/.quarterdeck",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board,
			sessions: {},
			revision: 1,
		});
		// saveWorkspaceState never resolves — simulates hung filesystem I/O
		mockSaveWorkspaceState.mockReturnValue(new Promise(() => {}));

		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();

		const shutdownPromise = shutdownRuntimeServer({
			workspaceRegistry: {
				listManagedWorkspaces: () => [
					{
						workspaceId: "test-workspace",
						workspacePath: "/tmp/test-project",
						terminalManager: createTerminalManagerStub(["task-1"]),
					},
				],
			},
			warn,
			closeRuntimeServer,
		});

		// Advance past the 7s cleanup timeout
		await vi.advanceTimersByTimeAsync(8000);
		await shutdownPromise;

		expect(closeRuntimeServer).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
	});

	it("completes normally when cleanup finishes within timeout", async () => {
		const { loadWorkspaceState, saveWorkspaceState } = await import("../../src/state/workspace-state.js");
		const mockLoadWorkspaceState = vi.mocked(loadWorkspaceState);
		const mockSaveWorkspaceState = vi.mocked(saveWorkspaceState);

		const board = createBoard(["task-1"]);
		mockLoadWorkspaceState.mockResolvedValue({
			repoPath: "/tmp/test-project",
			statePath: "/tmp/test-project/.quarterdeck",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board,
			sessions: {},
			revision: 1,
		});
		mockSaveWorkspaceState.mockResolvedValue(undefined as never);

		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();

		await shutdownRuntimeServer({
			workspaceRegistry: {
				listManagedWorkspaces: () => [
					{
						workspaceId: "test-workspace",
						workspacePath: "/tmp/test-project",
						terminalManager: createTerminalManagerStub(["task-1"]),
					},
				],
			},
			warn,
			closeRuntimeServer,
		});

		expect(closeRuntimeServer).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("timed out"));
	});
});
