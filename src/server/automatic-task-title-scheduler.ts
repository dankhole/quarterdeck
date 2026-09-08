import type { RuntimeBoardCard } from "../core";
import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import type { ProjectBoardCommandScope, ProjectBoardCommandService, ProjectBoardPostCommitListener } from "../state";
import { type AutomaticTitleGenerationRunner, generateTaskTitle as generateTaskTitleWithProvider } from "../title";

const log = createTaggedLogger("automatic-title");
const MAX_CONCURRENT_TITLE_REQUESTS = 3;

type AutomaticTitleCard = Pick<RuntimeBoardCard, "id" | "prompt" | "createdAt">;

export interface AutomaticTaskTitleSchedulerDependencies {
	automaticTitleGeneration: AutomaticTitleGenerationRunner;
	boardCommands: Pick<ProjectBoardCommandService, "setGeneratedTaskTitle">;
	publishTitleUpdated: (input: { projectId: string; taskId: string; title: string }) => Promise<void> | void;
	diagnostics?: Pick<RuntimeDiagnostics, "recordEvent">;
	generateTaskTitle?: (prompt: string) => Promise<string | null>;
}

/**
 * Schedules one runtime-owned automatic title attempt without making the
 * post-commit listener await helper latency. The shared coordinator keeps
 * repeated delivery on the same per-project/task single flight.
 */
export function scheduleAutomaticTaskTitle(
	dependencies: AutomaticTaskTitleSchedulerDependencies,
	projectScope: ProjectBoardCommandScope,
	card: AutomaticTitleCard,
): Promise<void> | null {
	const generation = dependencies.automaticTitleGeneration.runIfIdle(projectScope.projectId, card.id, async () => {
		const title = await (dependencies.generateTaskTitle ?? generateTaskTitleWithProvider)(card.prompt);
		if (!title) {
			dependencies.diagnostics?.recordEvent(
				"task.title_generation_no_result",
				{ promptLength: card.prompt.length },
				{ projectId: projectScope.projectId, taskId: card.id },
				{ level: "warn", essential: true },
			);
			return;
		}

		const result = await dependencies.boardCommands.setGeneratedTaskTitle(
			projectScope,
			card.id,
			card.createdAt,
			title,
		);
		if (!result.acceptedChange) {
			dependencies.diagnostics?.recordEvent(
				"task.title_generation_discarded",
				{},
				{ projectId: projectScope.projectId, taskId: card.id },
				{ essential: false },
			);
			return;
		}

		await dependencies.publishTitleUpdated({
			projectId: projectScope.projectId,
			taskId: card.id,
			title,
		});
		dependencies.diagnostics?.recordEvent(
			"task.title_generation_completed",
			{},
			{ projectId: projectScope.projectId, taskId: card.id },
			{ essential: true },
		);
	});
	if (!generation) {
		return null;
	}

	dependencies.diagnostics?.recordEvent(
		"task.title_generation_scheduled",
		{ promptLength: card.prompt.length },
		{ projectId: projectScope.projectId, taskId: card.id },
		{ essential: true },
	);
	return generation.catch((error) => {
		const errorClass = error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError";
		log.warn("Automatic task title generation failed", {
			projectId: projectScope.projectId,
			taskId: card.id,
			errorClass,
		});
		dependencies.diagnostics?.recordEvent(
			"task.title_generation_failed",
			{ errorClass },
			{ projectId: projectScope.projectId, taskId: card.id },
			{ level: "warn", essential: true },
		);
	});
}

/** Consumes the board writer's one authoritative post-commit effect stream. */
export function createAutomaticTaskTitlePostCommitListener(
	dependencies: AutomaticTaskTitleSchedulerDependencies,
): ProjectBoardPostCommitListener {
	return (event) => {
		const untitledTasks = event.effects.map(({ task }) => ({
			id: task.taskId,
			prompt: task.prompt,
			createdAt: task.createdAt,
		}));
		void (async () => {
			for (let index = 0; index < untitledTasks.length; index += MAX_CONCURRENT_TITLE_REQUESTS) {
				const batch = untitledTasks.slice(index, index + MAX_CONCURRENT_TITLE_REQUESTS);
				await Promise.allSettled(batch.map((task) => scheduleAutomaticTaskTitle(dependencies, event.scope, task)));
			}
		})();
	};
}

const TITLE_REFRESH_INTERVAL_MS = 60_000;
const MAX_RECENT_TITLE_REFRESHES = 256;

/** Completion-driven policy: no polling, retries, or queued work after shutdown. */
export function createAutomaticTaskTitleRefreshListener(dependencies: {
	automaticTitleGeneration: AutomaticTitleGenerationRunner;
	resolveProjectScope: (projectId: string) => ProjectBoardCommandScope | null;
	regenerateTaskTitle: (
		scope: ProjectBoardCommandScope,
		taskId: string,
		options: { automatic: true; isCurrent: () => boolean },
	) => Promise<unknown>;
	now?: () => number;
}) {
	const lastAttempts = new Map<string, number>();
	let active = 0;
	let disposed = false;
	return {
		onTaskReadyForReview(projectId: string, taskId: string): void {
			if (disposed || active >= MAX_CONCURRENT_TITLE_REQUESTS) return;
			const scope = dependencies.resolveProjectScope(projectId);
			if (!scope) return;
			const key = JSON.stringify([projectId, taskId]);
			const now = (dependencies.now ?? Date.now)();
			const previousAttempt = lastAttempts.get(key);
			if (previousAttempt !== undefined && now - previousAttempt < TITLE_REFRESH_INTERVAL_MS) return;
			const generation = dependencies.automaticTitleGeneration.runIfIdle(projectId, taskId, async () => {
				if (disposed) return;
				await dependencies.regenerateTaskTitle(scope, taskId, { automatic: true, isCurrent: () => !disposed });
			});
			if (!generation) return;
			active += 1;
			lastAttempts.delete(key);
			lastAttempts.set(key, now);
			if (lastAttempts.size > MAX_RECENT_TITLE_REFRESHES) {
				const oldest = lastAttempts.keys().next().value;
				if (oldest !== undefined) lastAttempts.delete(oldest);
			}
			void generation
				.catch((error: unknown) => {
					log.warn("Automatic title refresh failed", {
						projectId,
						taskId,
						errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
					});
				})
				.finally(() => {
					active -= 1;
				});
		},
		dispose(): void {
			disposed = true;
			lastAttempts.clear();
		},
	};
}
