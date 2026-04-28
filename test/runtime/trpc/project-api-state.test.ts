import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "../../../src/core";
import type { ProjectApiContext } from "../../../src/trpc/project-api-shared";
import { createBoardStateSavedEffects } from "../../../src/trpc/runtime-mutation-effects";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const stateMocks = vi.hoisted(() => ({
	saveProjectState: vi.fn(),
	ProjectStateConflictError: class extends Error {},
}));

const titleMocks = vi.hoisted(() => ({
	generateTaskTitle: vi.fn(),
}));

vi.mock("../../../src/state/project-state.js", () => ({
	loadProjectState: vi.fn(),
	saveProjectState: stateMocks.saveProjectState,
	ProjectStateConflictError: stateMocks.ProjectStateConflictError,
}));

vi.mock("../../../src/title/title-generator.js", () => ({
	generateTaskTitle: titleMocks.generateTaskTitle,
	generateBranchName: vi.fn(),
}));

vi.mock("../../../src/workdir/task-worktree.js", () => ({
	deleteTaskWorktree: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorktreeInfo: vi.fn(),
}));

import { createStateOps } from "../../../src/trpc/project-api-state";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: "Task One",
						prompt: "Do the thing",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
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

function createSummary(taskId: string): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: "awaiting_review",
		agentId: "codex",
		sessionLaunchPath: "/tmp/project-a",
		pid: null,
		startedAt: 100,
		updatedAt: 200,
		lastOutputAt: 200,
		reviewReason: "hook",
	});
}

function createSavedState(board: RuntimeBoardData): RuntimeProjectStateResponse {
	return {
		repoPath: "/tmp/project-a",
		statePath: "/tmp/project-a/.quarterdeck",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board,
		sessions: { "task-1": createSummary("task-1") },
		revision: 2,
	};
}

describe("createStateOps.saveState", () => {
	beforeEach(() => {
		stateMocks.saveProjectState.mockReset();
		titleMocks.generateTaskTitle.mockReset();
	});

	it("persists authoritative sessions from the terminal manager store", async () => {
		const board = createBoard();
		const summary = createSummary("task-1");
		stateMocks.saveProjectState.mockResolvedValue(createSavedState(board));

		const ensureTerminalManagerForProject = vi.fn(async () => ({
			store: {
				listSummaries: vi.fn(() => [summary]),
			},
		}));
		const applyEffects = vi.fn();

		const stateOps = createStateOps({
			deps: {
				terminals: {
					getTerminalManagerForProject: vi.fn(() => null),
					ensureTerminalManagerForProject:
						ensureTerminalManagerForProject as unknown as ProjectApiContext["deps"]["terminals"]["ensureTerminalManagerForProject"],
				},
				broadcaster: {
					broadcastRuntimeProjectStateUpdated: vi.fn(),
					broadcastRuntimeProjectsUpdated: vi.fn(async () => undefined),
					broadcastTaskTitleUpdated: vi.fn(),
					setFocusedTask: vi.fn(),
					setDocumentVisible: vi.fn(),
					requestTaskRefresh: vi.fn(),
					requestHomeRefresh: vi.fn(),
				},
				data: {
					buildProjectStateSnapshot: vi.fn(),
				},
			},
			applyEffects,
		} satisfies ProjectApiContext);

		await stateOps.saveState(
			{
				projectId: "project-a",
				projectPath: "/tmp/project-a",
			},
			{
				board,
				expectedRevision: 1,
			},
		);

		expect(ensureTerminalManagerForProject).toHaveBeenCalledWith("project-a", "/tmp/project-a");
		expect(stateMocks.saveProjectState).toHaveBeenCalledWith("/tmp/project-a", {
			board,
			sessions: {
				"task-1": summary,
			},
			expectedRevision: 1,
		});
		expect(applyEffects).toHaveBeenCalledWith(
			createBoardStateSavedEffects({
				projectId: "project-a",
				projectPath: "/tmp/project-a",
			}),
		);
	});
});
