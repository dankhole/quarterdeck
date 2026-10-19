import { useCallback } from "react";
import { useBoardContext } from "@/providers/board-provider";
import { useInteractionsContext } from "@/providers/interactions-provider";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { CardSelection } from "@/types";

export interface TaskTerminalState {
	onSessionSummary: (projectId: string, summary: RuntimeTaskSessionSummary) => void;
	isTaskTerminalEnabled: boolean;
	isSessionProcessless: boolean;
	pendingSessionLabel: string | null;
	onResumeSession: () => void;
}

export function useTaskTerminalState(selection: CardSelection): TaskTerminalState {
	const { sessions, upsertSession, taskLifecycle } = useBoardContext();
	const { handleRestartTaskSession } = useInteractionsContext();
	const taskId = selection.card.id;
	const summary = sessions[taskId];
	const isTaskTerminalEnabled =
		!selection.card.unstarted && (selection.column.id === "in_progress" || selection.column.id === "review");
	const isSessionProcessless = isTaskTerminalEnabled && summary?.pid === null;
	const pendingSessionLabel = taskLifecycle.pendingTaskLifecycleById[taskId]?.label ?? null;
	const onResumeSession = useCallback(() => {
		if (isSessionProcessless && !pendingSessionLabel) handleRestartTaskSession(taskId);
	}, [handleRestartTaskSession, isSessionProcessless, pendingSessionLabel, taskId]);

	return {
		onSessionSummary: upsertSession,
		isTaskTerminalEnabled,
		isSessionProcessless,
		pendingSessionLabel,
		onResumeSession,
	};
}
