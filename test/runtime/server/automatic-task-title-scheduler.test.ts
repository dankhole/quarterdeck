import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeProjectStateResponse } from "../../../src/core";
import type { RuntimeDiagnostics } from "../../../src/diagnostics";
import {
	type AutomaticTaskTitleSchedulerDependencies,
	createAutomaticTaskTitlePostCommitListener,
	scheduleAutomaticTaskTitle,
} from "../../../src/server/automatic-task-title-scheduler";
import { AutomaticTitleGenerationCoordinator, TITLE_GENERATION_UNAVAILABLE_MESSAGE } from "../../../src/title";

function createState(): RuntimeProjectStateResponse {
	const board: RuntimeBoardData = {
		columns: [
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						unstarted: true,
						id: "task-1",
						title: null,
						prompt: "private task prompt",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Trash", cards: [] },
		],
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
	const publishError = vi.fn();
	const dependencies: AutomaticTaskTitleSchedulerDependencies = {
		automaticTitleGeneration: new AutomaticTitleGenerationCoordinator(),
		boardCommands: { setGeneratedTaskTitle },
		publishTitleUpdated,
		publishError,
		diagnostics,
		generateTaskTitle: async (prompt) => ({ title: await generateTaskTitle(prompt) }),
	};
	return { dependencies, diagnostics, publishTitleUpdated, publishError, recordEvent, setGeneratedTaskTitle };
}

const scope = { projectId: "project-1", projectPath: "/project" };
const card = { id: "task-1", prompt: "private task prompt", createdAt: 1 };

describe("automatic task title scheduler", () => {
	it.each(["codex", "claude", "pi", undefined] as const)(
		"uses the shared generator for agent selection %s",
		async (agentId) => {
			const generateTaskTitle = vi.fn(async () => "Remote title");
			const harness = createHarness(generateTaskTitle);
			await scheduleAutomaticTaskTitle(harness.dependencies, scope, { ...card, agentId });
			expect(generateTaskTitle).toHaveBeenCalledWith(card.prompt);
			expect(harness.setGeneratedTaskTitle).toHaveBeenCalledWith(scope, "task-1", 1, "Remote title");
		},
	);

	it("generates a Codex title through post-commit delivery", async () => {
		const generateTaskTitle = vi.fn(async () => "Remote title");
		const harness = createHarness(generateTaskTitle);
		const listener = createAutomaticTaskTitlePostCommitListener(harness.dependencies);
		listener({
			scope,
			commandId: "codex-task",
			revision: 1,
			replayed: false,
			effects: [
				{
					type: "untitled_task_created",
					task: { taskId: card.id, prompt: card.prompt, createdAt: card.createdAt, agentId: "codex" },
				},
			],
		});
		await vi.waitFor(() =>
			expect(harness.setGeneratedTaskTitle).toHaveBeenCalledWith(scope, card.id, card.createdAt, "Remote title"),
		);
		expect(generateTaskTitle).toHaveBeenCalledWith(card.prompt);
	});

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

	it("persists the initial fallback but reports the model failure visibly", async () => {
		const h = createHarness(vi.fn());
		h.dependencies.generateTaskTitle = async () => ({
			title: "Local Title",
			error: TITLE_GENERATION_UNAVAILABLE_MESSAGE,
		});
		await scheduleAutomaticTaskTitle(h.dependencies, scope, card);
		expect(h.setGeneratedTaskTitle).toHaveBeenCalledWith(scope, card.id, card.createdAt, "Local Title");
		expect(h.publishError).toHaveBeenCalledWith({
			projectId: scope.projectId,
			taskId: card.id,
			message: `${TITLE_GENERATION_UNAVAILABLE_MESSAGE} A local title was used instead.`,
		});
		expect(h.recordEvent).toHaveBeenCalledWith(
			"task.title_generation_fallback",
			{},
			{ projectId: scope.projectId, taskId: card.id },
			{ essential: true },
		);
	});

	it("does not notify about a fallback discarded after a concurrent edit", async () => {
		const h = createHarness(vi.fn());
		h.dependencies.generateTaskTitle = async () => ({
			title: "Local Title",
			error: TITLE_GENERATION_UNAVAILABLE_MESSAGE,
		});
		h.setGeneratedTaskTitle.mockResolvedValue({
			state: createState(),
			changed: false,
			acceptedChange: false,
			replayed: false,
		});
		await scheduleAutomaticTaskTitle(h.dependencies, scope, card);
		expect(h.publishError).not.toHaveBeenCalled();
	});

	it("reports a missing result and contains notification delivery failures", async () => {
		const h = createHarness(vi.fn(async () => null));
		await scheduleAutomaticTaskTitle(h.dependencies, scope, card);
		expect(h.publishError).toHaveBeenCalledOnce();
		expect(h.setGeneratedTaskTitle).not.toHaveBeenCalled();
		h.publishError.mockRejectedValue(new Error("private transport error"));
		await expect(scheduleAutomaticTaskTitle(h.dependencies, scope, card)).resolves.toBeUndefined();
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
		expect(harness.publishError).toHaveBeenCalledWith({
			projectId: scope.projectId,
			taskId: card.id,
			message: "Could not generate or save the task title. Try Auto-generate title again.",
		});
		expect(JSON.stringify(harness.publishError.mock.calls)).not.toContain("private persistence details");
		expect(JSON.stringify(harness.recordEvent.mock.calls)).not.toContain("private persistence details");
	});
});
