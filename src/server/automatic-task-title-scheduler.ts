import type { RuntimeBoardCard, RuntimeProjectStateResponse } from "../core";
import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import type { RuntimeDiagnostics } from "../diagnostics";
import type { ProjectBoardCommandScope, ProjectBoardCommandService } from "../state";
import { type AutomaticTitleGenerationRunner, generateTaskTitle as generateTaskTitleWithProvider } from "../title";

const log = createTaggedLogger("automatic-title");
const MAX_CONCURRENT_TITLE_REQUESTS = 3;

type AutomaticTitleCard = Pick<RuntimeBoardCard, "id" | "prompt">;

export interface AutomaticTaskTitleSchedulerDependencies {
	automaticTitleGeneration: AutomaticTitleGenerationRunner;
	boardCommands: Pick<ProjectBoardCommandService, "setGeneratedTaskTitle">;
	publishTitleUpdated: (input: { projectId: string; taskId: string; title: string }) => Promise<void> | void;
	diagnostics?: Pick<RuntimeDiagnostics, "recordEvent">;
	generateTaskTitle?: (prompt: string) => Promise<string | null>;
}

/**
 * Schedules one runtime-owned automatic title attempt without making the
 * caller await helper latency. The shared coordinator keeps browser command
 * flushes and lifecycle creation on the same per-project/task single flight.
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

		const result = await dependencies.boardCommands.setGeneratedTaskTitle(projectScope, card.id, title);
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

/** Preserve the existing bounded scan used after browser board commands. */
export function scheduleAutomaticTaskTitles(
	dependencies: AutomaticTaskTitleSchedulerDependencies,
	projectScope: ProjectBoardCommandScope,
	state: Pick<RuntimeProjectStateResponse, "board">,
): void {
	const untitledCards = state.board.columns.flatMap((column) => column.cards.filter((card) => card.title === null));
	if (untitledCards.length === 0) {
		return;
	}

	void (async () => {
		for (let index = 0; index < untitledCards.length; index += MAX_CONCURRENT_TITLE_REQUESTS) {
			const batch = untitledCards.slice(index, index + MAX_CONCURRENT_TITLE_REQUESTS);
			await Promise.allSettled(batch.map((card) => scheduleAutomaticTaskTitle(dependencies, projectScope, card)));
		}
	})();
}
