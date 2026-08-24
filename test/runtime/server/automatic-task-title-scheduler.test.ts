import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeProjectStateResponse } from "../../../src/core";
import type { RuntimeDiagnostics } from "../../../src/diagnostics";
import {
	type AutomaticTaskTitleSchedulerDependencies,
	scheduleAutomaticTaskTitle,
} from "../../../src/server/automatic-task-title-scheduler";
import { AutomaticTitleGenerationCoordinator } from "../../../src/title";

function createState(): RuntimeProjectStateResponse {
	const board: RuntimeBoardData = {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt: "private task prompt",
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
	return {
		repoPath: "/project",
		statePath: "/state/project",
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		board,
		sessions: {},
		revision: 2,
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

function createHarness(generateTaskTitle: (prompt: string) => Promise<string | null>) {
	const recordEvent = vi.fn();
	const diagnostics = {
		recordEvent,
	} as unknown as Pick<RuntimeDiagnostics, "recordEvent">;
	const setGeneratedTaskTitle = vi.fn(async () => ({
		state: createState(),
		changed: true,
		acceptedChange: true,
		replayed: false,
	}));
	const publishTitleUpdated = vi.fn();
	const dependencies: AutomaticTaskTitleSchedulerDependencies = {
		automaticTitleGeneration: new AutomaticTitleGenerationCoordinator(),
		boardCommands: { setGeneratedTaskTitle },
		publishTitleUpdated,
		diagnostics,
		generateTaskTitle,
	};
	return { dependencies, diagnostics, publishTitleUpdated, recordEvent, setGeneratedTaskTitle };
}

const scope = { projectId: "project-1", projectPath: "/project" };
const card = { id: "task-1", prompt: "private task prompt" };

describe("automatic task title scheduler", () => {
	it("persists and publishes a lifecycle-scheduled title with metadata-only diagnostics", async () => {
		const harness = createHarness(vi.fn(async () => "Generated Title"));

		const generation = scheduleAutomaticTaskTitle(harness.dependencies, scope, card);

		expect(generation).not.toBeNull();
		await generation;
		expect(harness.setGeneratedTaskTitle).toHaveBeenCalledWith(scope, "task-1", "Generated Title");
		expect(harness.publishTitleUpdated).toHaveBeenCalledWith({
			projectId: "project-1",
			taskId: "task-1",
			title: "Generated Title",
		});
		expect(harness.diagnostics.recordEvent).toHaveBeenCalledWith(
			"task.title_generation_scheduled",
			{ promptLength: card.prompt.length },
			{ projectId: "project-1", taskId: "task-1" },
			{ essential: true },
		);
		expect(harness.diagnostics.recordEvent).toHaveBeenCalledWith(
			"task.title_generation_completed",
			{},
			{ projectId: "project-1", taskId: "task-1" },
			{ essential: true },
		);
		expect(JSON.stringify(harness.recordEvent.mock.calls)).not.toContain(card.prompt);
	});

	it("deduplicates overlapping lifecycle and board-command requests", async () => {
		const deferred = createDeferred<string | null>();
		const generateTaskTitle = vi.fn(() => deferred.promise);
		const harness = createHarness(generateTaskTitle);

		const first = scheduleAutomaticTaskTitle(harness.dependencies, scope, card);
		const duplicate = scheduleAutomaticTaskTitle(harness.dependencies, scope, card);

		expect(first).not.toBeNull();
		expect(duplicate).toBeNull();
		deferred.resolve("Generated Once");
		await first;
		expect(generateTaskTitle).toHaveBeenCalledOnce();
		expect(harness.setGeneratedTaskTitle).toHaveBeenCalledOnce();
	});

	it("surfaces unexpected persistence failures without rejecting fire-and-forget callers", async () => {
		const harness = createHarness(vi.fn(async () => "Generated Title"));
		harness.setGeneratedTaskTitle.mockRejectedValue(new TypeError("private persistence details"));

		await expect(scheduleAutomaticTaskTitle(harness.dependencies, scope, card)).resolves.toBeUndefined();
		expect(harness.diagnostics.recordEvent).toHaveBeenCalledWith(
			"task.title_generation_failed",
			{ errorClass: "TypeError" },
			{ projectId: "project-1", taskId: "task-1" },
			{ level: "warn", essential: true },
		);
		expect(JSON.stringify(harness.recordEvent.mock.calls)).not.toContain("private persistence details");
	});
});
