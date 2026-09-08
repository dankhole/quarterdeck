import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeProjectStateResponse } from "../../../src/core";
import type { RuntimeDiagnostics } from "../../../src/diagnostics";
import {
	type AutomaticTaskTitleSchedulerDependencies,
	createAutomaticTaskTitlePostCommitListener,
	createAutomaticTaskTitleRefreshListener,
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
const card = { id: "task-1", prompt: "private task prompt", createdAt: 1 };

describe("automatic task title scheduler", () => {
	it("consumes the authoritative post-commit effect without rescanning board state", async () => {
		const generateTaskTitle = vi.fn(async () => "Generated Title");
		const harness = createHarness(generateTaskTitle);
		const listener = createAutomaticTaskTitlePostCommitListener(harness.dependencies);

		listener({
			scope,
			commandId: "create-task-1",
			revision: 2,
			replayed: false,
			effects: [
				{
					type: "untitled_task_created",
					task: { taskId: "task-1", prompt: card.prompt, createdAt: card.createdAt },
				},
			],
		});

		await vi.waitFor(() => {
			expect(generateTaskTitle).toHaveBeenCalledWith(card.prompt);
			expect(harness.setGeneratedTaskTitle).toHaveBeenCalledWith(scope, "task-1", 1, "Generated Title");
		});
	});

	it("persists and publishes a post-commit-scheduled title with metadata-only diagnostics", async () => {
		const harness = createHarness(vi.fn(async () => "Generated Title"));

		const generation = scheduleAutomaticTaskTitle(harness.dependencies, scope, card);

		expect(generation).not.toBeNull();
		await generation;
		expect(harness.setGeneratedTaskTitle).toHaveBeenCalledWith(scope, "task-1", 1, "Generated Title");
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

	it("deduplicates overlapping post-commit deliveries", async () => {
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

describe("automatic task title refresh listener", () => {
	it("shares initial generation single-flight and scopes its minute cooldown by project and task", async () => {
		const initialTitle = createDeferred<string | null>();
		const harness = createHarness(() => initialTitle.promise);
		const initial = scheduleAutomaticTaskTitle(harness.dependencies, scope, card);
		const regenerateTaskTitle = vi.fn(async () => undefined);
		let now = 0;
		const listener = createAutomaticTaskTitleRefreshListener({
			automaticTitleGeneration: harness.dependencies.automaticTitleGeneration,
			resolveProjectScope: (projectId) =>
				projectId === "missing" ? null : { projectId, projectPath: `/${projectId}` },
			regenerateTaskTitle,
			now: () => now,
		});

		listener.onTaskReadyForReview("project-1", card.id);
		listener.onTaskReadyForReview("project-2", card.id);
		listener.onTaskReadyForReview("missing", card.id);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(regenerateTaskTitle).toHaveBeenCalledExactlyOnceWith(
			{ projectId: "project-2", projectPath: "/project-2" },
			card.id,
			{ automatic: true, isCurrent: expect.any(Function) },
		);

		initialTitle.resolve("Initial title");
		await initial;
		listener.onTaskReadyForReview("project-1", card.id);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(regenerateTaskTitle).toHaveBeenCalledTimes(2);
		now = 59_999;
		listener.onTaskReadyForReview("project-1", card.id);
		listener.onTaskReadyForReview("project-2", card.id);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(regenerateTaskTitle).toHaveBeenCalledTimes(2);
		now = 60_000;
		listener.onTaskReadyForReview("project-1", card.id);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(regenerateTaskTitle).toHaveBeenLastCalledWith(
			{ projectId: "project-1", projectPath: "/project-1" },
			card.id,
			{ automatic: true, isCurrent: expect.any(Function) },
		);
		expect(regenerateTaskTitle).toHaveBeenCalledTimes(3);
		listener.dispose();
	});

	it("limits refreshes to three active helpers without queueing skipped completions", async () => {
		const pending = createDeferred<void>();
		const regenerateTaskTitle = vi.fn<
			Parameters<typeof createAutomaticTaskTitleRefreshListener>[0]["regenerateTaskTitle"]
		>(() => pending.promise);
		const listener = createAutomaticTaskTitleRefreshListener({
			automaticTitleGeneration: new AutomaticTitleGenerationCoordinator(),
			resolveProjectScope: () => scope,
			regenerateTaskTitle,
		});
		for (const taskId of ["task-1", "task-2", "task-3", "task-4"]) {
			listener.onTaskReadyForReview(scope.projectId, taskId);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(regenerateTaskTitle.mock.calls.map((call) => call[1])).toEqual(["task-1", "task-2", "task-3"]);
		pending.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(regenerateTaskTitle).toHaveBeenCalledTimes(3);
		listener.onTaskReadyForReview(scope.projectId, "task-4");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(regenerateTaskTitle).toHaveBeenCalledTimes(4);
		listener.dispose();
	});

	it("invalidates in-flight result publication and rejects new work after disposal", async () => {
		const pending = createDeferred<void>();
		const publish = vi.fn();
		const regenerateTaskTitle = vi.fn<
			Parameters<typeof createAutomaticTaskTitleRefreshListener>[0]["regenerateTaskTitle"]
		>(async (_scope, _taskId, options) => {
			expect(options.isCurrent()).toBe(true);
			await pending.promise;
			if (options.isCurrent()) publish();
		});
		const listener = createAutomaticTaskTitleRefreshListener({
			automaticTitleGeneration: new AutomaticTitleGenerationCoordinator(),
			resolveProjectScope: () => scope,
			regenerateTaskTitle,
		});
		listener.onTaskReadyForReview(scope.projectId, card.id);
		await new Promise<void>((resolve) => setImmediate(resolve));
		listener.dispose();
		pending.resolve();
		listener.onTaskReadyForReview(scope.projectId, "another-task");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(regenerateTaskTitle).toHaveBeenCalledOnce();
		expect(publish).not.toHaveBeenCalled();
	});
});
