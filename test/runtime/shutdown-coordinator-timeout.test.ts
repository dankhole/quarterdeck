import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core";
import { shutdownRuntimeServer } from "../../src/server";
import type { TerminalSessionManager } from "../../src/terminal";
import { createTestTaskSessionSummary } from "../utilities/task-session-factory";

vi.mock("../../src/state/project-state.js", () => ({
	loadProjectState: vi.fn(),
	saveProjectSessions: vi.fn(),
	listProjectIndexEntries: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/terminal/orphan-cleanup.js", () => ({
	killOrphanedAgentProcesses: vi.fn().mockResolvedValue(undefined),
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
	const summaries: RuntimeTaskSessionSummary[] = taskIds.map((taskId) =>
		createTestTaskSessionSummary({
			taskId,
			state: "running",
			agentId: "codex",
			sessionLaunchPath: `/tmp/${taskId}`,
			pid: 1234,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
		}),
	);
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

		const { loadProjectState, saveProjectSessions } = await import("../../src/state/project-state.js");
		const mockLoadProjectState = vi.mocked(loadProjectState);
		const mockSaveProjectSessions = vi.mocked(saveProjectSessions);

		const board = createBoard(["task-1"]);
		mockLoadProjectState.mockResolvedValue({
			repoPath: "/tmp/test-project",
			statePath: "/tmp/test-project/.quarterdeck",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board,
			sessions: {},
			revision: 1,
		});
		// saveProjectSessions never resolves — simulates hung filesystem I/O
		mockSaveProjectSessions.mockReturnValue(new Promise(() => {}));

		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();

		const shutdownPromise = shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{
						projectId: "test-project",
						projectPath: "/tmp/test-project",
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
		const { loadProjectState, saveProjectSessions } = await import("../../src/state/project-state.js");
		const mockLoadProjectState = vi.mocked(loadProjectState);
		const mockSaveProjectSessions = vi.mocked(saveProjectSessions);

		const board = createBoard(["task-1"]);
		mockLoadProjectState.mockResolvedValue({
			repoPath: "/tmp/test-project",
			statePath: "/tmp/test-project/.quarterdeck",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board,
			sessions: {},
			revision: 1,
		});
		mockSaveProjectSessions.mockResolvedValue({} as never);

		const closeRuntimeServer = vi.fn().mockResolvedValue(undefined);
		const warn = vi.fn();

		await shutdownRuntimeServer({
			projectRegistry: {
				listManagedProjects: () => [
					{
						projectId: "test-project",
						projectPath: "/tmp/test-project",
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
