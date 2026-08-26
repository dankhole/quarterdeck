import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeProjectStateResponse } from "../../../src/core";
import type { ProjectApiContext } from "../../../src/trpc/project-api-shared";
import { createStateOps } from "../../../src/trpc/project-api-state";
import {
	createBoardCommandCommittedEffects,
	createTaskTitleUpdatedEffects,
} from "../../../src/trpc/runtime-mutation-effects";

vi.mock("../../../src/title/title-generator.js", () => ({
	generateTaskTitle: vi.fn(),
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

function createHarness(board = createBoard()) {
	const applyEffects = vi.fn();
	const buildProjectStateSnapshot = vi.fn(async () => createState(board));
	const executeBatch = vi.fn(async () => ({
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
			boardCommands: { executeBatch, executeClientBatch: executeBatch },
		},
		applyEffects,
	} as unknown as ProjectApiContext;
	return {
		applyEffects,
		buildProjectStateSnapshot,
		executeBatch,
		stateOps: createStateOps(context),
	};
}

const scope = { projectId: "project-a", projectPath: "/tmp/project-a" };

describe("createStateOps runtime board ownership", () => {
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
