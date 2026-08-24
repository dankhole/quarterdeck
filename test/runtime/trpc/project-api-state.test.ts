import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeProjectStateResponse } from "../../../src/core";
import { AutomaticTitleGenerationCoordinator } from "../../../src/title";
import type { ProjectApiContext } from "../../../src/trpc/project-api-shared";
import { createStateOps } from "../../../src/trpc/project-api-state";
import {
	createBoardCommandCommittedEffects,
	createTaskTitleUpdatedEffects,
} from "../../../src/trpc/runtime-mutation-effects";

const titleMocks = vi.hoisted(() => ({
	generateTaskTitle: vi.fn(),
}));

vi.mock("../../../src/title/title-generator.js", () => ({
	generateTaskTitle: titleMocks.generateTaskTitle,
	generateBranchName: vi.fn(),
}));

vi.mock("../../../src/workdir/task-worktree.js", () => ({
	archiveTaskWorktreeForTrash: vi.fn(),
	deleteTaskWorktree: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskRepositoryInfo: vi.fn(),
}));

function createBoard(title: string | null = "Task One"): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title,
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

function createState(board: RuntimeBoardData, revision = 2): RuntimeProjectStateResponse {
	return {
		repoPath: "/tmp/project-a",
		statePath: "/tmp/state/project-a",
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		board,
		sessions: {},
		revision,
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

function createHarness(board = createBoard(), automaticTitleGeneration = new AutomaticTitleGenerationCoordinator()) {
	const applyEffects = vi.fn();
	const buildProjectStateSnapshot = vi.fn(async () => createState(board));
	const executeBatch = vi.fn(async () => ({
		state: createState(board),
		changed: true,
		acceptedChange: true,
		replayed: false,
	}));
	const setGeneratedTaskTitle = vi.fn(async () => ({
		state: createState(board),
		changed: true,
		acceptedChange: true,
		replayed: false,
	}));
	const context = {
		deps: {
			terminals: {
				getTerminalManagerForProject: vi.fn(() => null),
				ensureTerminalManagerForProject: vi.fn(),
			},
			broadcaster: {
				broadcastRuntimeProjectStateUpdated: vi.fn(),
				broadcastRuntimeProjectNotificationsUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				broadcastTaskTitleUpdated: vi.fn(),
				setFocusedTask: vi.fn(),
				setDocumentVisible: vi.fn(),
				requestTaskRefresh: vi.fn(),
				requestHomeRefresh: vi.fn(),
			},
			data: { buildProjectStateSnapshot },
			boardCommands: { executeBatch, executeClientBatch: executeBatch, setGeneratedTaskTitle },
			automaticTitleGeneration,
		},
		applyEffects,
	} as unknown as ProjectApiContext;
	return {
		applyEffects,
		buildProjectStateSnapshot,
		executeBatch,
		setGeneratedTaskTitle,
		stateOps: createStateOps(context),
	};
}

const scope = { projectId: "project-a", projectPath: "/tmp/project-a" };

describe("createStateOps runtime board ownership", () => {
	beforeEach(() => {
		titleMocks.generateTaskTitle.mockReset();
	});

	it("delegates browser commands to the runtime authority and emits non-duplicate side effects", async () => {
		const { applyEffects, executeBatch, stateOps } = createHarness();
		const input = {
			commandId: "browser:1",
			expectedRevision: 1,
			commands: [{ kind: "delete_tasks" as const, taskIds: ["missing-task"] }],
		};

		await stateOps.applyBoardCommands(scope, input);

		expect(executeBatch).toHaveBeenCalledWith(scope, input);
		expect(applyEffects).toHaveBeenCalledWith(createBoardCommandCommittedEffects(scope));
	});

	it("deduplicates overlapping automatic title generation and persists the winner", async () => {
		const board = createBoard(null);
		const deferredTitle = createDeferred<string | null>();
		titleMocks.generateTaskTitle.mockReturnValue(deferredTitle.promise);
		const { applyEffects, setGeneratedTaskTitle, stateOps } = createHarness(board);
		const first = stateOps.applyBoardCommands(scope, {
			commandId: "browser:1",
			expectedRevision: 1,
			commands: [{ kind: "reorder_task", taskId: "task-1", columnId: "backlog", targetIndex: 0 }],
		});
		const second = stateOps.applyBoardCommands(scope, {
			commandId: "browser:2",
			expectedRevision: 2,
			commands: [{ kind: "reorder_task", taskId: "task-1", columnId: "backlog", targetIndex: 0 }],
		});

		await Promise.all([first, second]);
		expect(titleMocks.generateTaskTitle).toHaveBeenCalledTimes(1);

		deferredTitle.resolve("Generated Title");
		await vi.waitFor(() => {
			expect(setGeneratedTaskTitle).toHaveBeenCalledWith(scope, "task-1", "Generated Title");
			expect(applyEffects).toHaveBeenCalledWith(
				createTaskTitleUpdatedEffects({
					projectId: "project-a",
					taskId: "task-1",
					title: "Generated Title",
					autoGenerated: true,
				}),
			);
		});
	});

	it("deduplicates automatic title generation across request-scoped state ops", async () => {
		const board = createBoard(null);
		const deferredTitle = createDeferred<string | null>();
		titleMocks.generateTaskTitle.mockReturnValue(deferredTitle.promise);
		const automaticTitleGeneration = new AutomaticTitleGenerationCoordinator();
		const first = createHarness(board, automaticTitleGeneration);
		const second = createHarness(board, automaticTitleGeneration);

		await Promise.all([
			first.stateOps.applyBoardCommands(scope, {
				commandId: "browser:1",
				expectedRevision: 1,
				commands: [{ kind: "reorder_task", taskId: "task-1", columnId: "backlog", targetIndex: 0 }],
			}),
			second.stateOps.applyBoardCommands(scope, {
				commandId: "browser:2",
				expectedRevision: 2,
				commands: [{ kind: "reorder_task", taskId: "task-1", columnId: "backlog", targetIndex: 0 }],
			}),
		]);

		expect(titleMocks.generateTaskTitle).toHaveBeenCalledTimes(1);
		deferredTitle.resolve("Generated Title");
		await vi.waitFor(() => {
			expect(first.setGeneratedTaskTitle).toHaveBeenCalledWith(scope, "task-1", "Generated Title");
		});
	});

	it("persists manual title updates before publishing the lightweight update", async () => {
		const { applyEffects, executeBatch, stateOps } = createHarness();

		await expect(stateOps.updateTaskTitle(scope, "task-1", "Renamed")).resolves.toBe(true);

		expect(executeBatch).toHaveBeenCalledWith(
			scope,
			expect.objectContaining({
				commands: [expect.objectContaining({ kind: "patch_task", taskId: "task-1", title: "Renamed" })],
			}),
		);
		expect(applyEffects).toHaveBeenCalledWith(
			createTaskTitleUpdatedEffects({ projectId: "project-a", taskId: "task-1", title: "Renamed" }),
		);
	});
});
