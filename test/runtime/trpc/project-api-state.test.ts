import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "../../../src/core";
import { TaskResourceOperationCoordinator } from "../../../src/core";
import type { ProjectApiContext } from "../../../src/trpc/project-api-shared";
import {
	createBoardStateSavedEffects,
	createTaskTitleUpdatedEffects,
} from "../../../src/trpc/runtime-mutation-effects";
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
	getTaskRepositoryInfo: vi.fn(),
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

function createUntitledBoard(): RuntimeBoardData {
	const board = createBoard();
	const firstColumn = board.columns[0];
	const firstCard = firstColumn?.cards[0];
	if (!firstColumn || !firstCard) {
		throw new Error("Expected the test board to contain a card.");
	}
	firstColumn.cards[0] = { ...firstCard, title: null };
	return board;
}

function createDeferred<T>() {
	let resolve: ((value: T) => void) | null = null;
	let reject: ((error: unknown) => void) | null = null;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	if (!resolve || !reject) {
		throw new Error("Expected deferred handlers to be assigned.");
	}
	return {
		promise,
		resolve: resolve as (value: T) => void,
		reject: reject as (error: unknown) => void,
	};
}

function createStateOpsHarness(summary = createSummary("task-1")) {
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
				broadcastRuntimeProjectNotificationsUpdated: vi.fn(),
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
			taskResourceOperations: new TaskResourceOperationCoordinator(),
		},
		applyEffects,
	} satisfies ProjectApiContext);

	return { applyEffects, ensureTerminalManagerForProject, stateOps };
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
		const { applyEffects, ensureTerminalManagerForProject, stateOps } = createStateOpsHarness(summary);

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

	it("deduplicates overlapping automatic title requests for the same project task", async () => {
		const board = createUntitledBoard();
		stateMocks.saveProjectState.mockResolvedValue(createSavedState(board));
		const deferredTitle = createDeferred<string | null>();
		titleMocks.generateTaskTitle.mockReturnValue(deferredTitle.promise);
		const { applyEffects, stateOps } = createStateOpsHarness();
		const projectScope = {
			projectId: "project-a",
			projectPath: "/tmp/project-a",
		};

		await Promise.all([
			stateOps.saveState(projectScope, { board, expectedRevision: 1 }),
			stateOps.saveState(projectScope, { board, expectedRevision: 2 }),
		]);

		expect(titleMocks.generateTaskTitle).toHaveBeenCalledTimes(1);

		deferredTitle.resolve("Generated Title");
		await vi.waitFor(() => {
			expect(applyEffects).toHaveBeenCalledWith(
				createTaskTitleUpdatedEffects({
					projectId: "project-a",
					taskId: "task-1",
					title: "Generated Title",
					autoGenerated: true,
				}),
			);
		});

		titleMocks.generateTaskTitle.mockResolvedValue("Retry Title");
		await stateOps.saveState(projectScope, { board, expectedRevision: 3 });
		await vi.waitFor(() => {
			expect(titleMocks.generateTaskTitle).toHaveBeenCalledTimes(2);
		});
	});

	it("keeps automatic title guards scoped by project", async () => {
		const board = createUntitledBoard();
		stateMocks.saveProjectState.mockResolvedValue(createSavedState(board));
		const deferredTitle = createDeferred<string | null>();
		titleMocks.generateTaskTitle.mockReturnValue(deferredTitle.promise);
		const { stateOps } = createStateOpsHarness();

		await Promise.all([
			stateOps.saveState({ projectId: "project-a", projectPath: "/tmp/project-a" }, { board, expectedRevision: 1 }),
			stateOps.saveState({ projectId: "project-b", projectPath: "/tmp/project-b" }, { board, expectedRevision: 1 }),
		]);

		expect(titleMocks.generateTaskTitle).toHaveBeenCalledTimes(2);
		deferredTitle.resolve(null);
	});
});
