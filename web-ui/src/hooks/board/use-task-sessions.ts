// Frontend facade for task-scoped runtime data-plane actions. Durable task
// lifecycle changes belong to useTaskLifecycleOperations; this hook only
// merges summaries, sends agent input, and reads task context.

import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskRepositoryInfoResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard } from "@/types";
import { selectNewestTaskSessionSummary } from "@/utils/session-summary-utils";
import { toErrorMessage } from "@/utils/to-error-message";

interface UseTaskSessionsInput {
	currentProjectId: string | null;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
}

interface SendTaskSessionInputResult {
	ok: boolean;
	message?: string;
}

export interface UseTaskSessionsResult {
	upsertSession: (summary: RuntimeTaskSessionSummary) => void;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options: SendTerminalInputOptions,
	) => Promise<SendTaskSessionInputResult>;
	fetchTaskWorktreeInfo: (task: BoardCard) => Promise<RuntimeTaskRepositoryInfoResponse | null>;
}

export function useTaskSessions({ currentProjectId, setSessions }: UseTaskSessionsInput): UseTaskSessionsResult {
	/*
		This merge needs to stay monotonic. An older hydrated or cached summary
		must not replace a newer live session identity, or terminal consumers can
		bounce between instances and clear visible output.
	*/
	const upsertSession = useCallback(
		(summary: RuntimeTaskSessionSummary) => {
			let warningToShow: string | null = null;
			setSessions((current) => {
				const previousSummary = current[summary.taskId] ?? null;
				const newestSummary = selectNewestTaskSessionSummary(previousSummary, summary);
				if (newestSummary !== summary) {
					return current;
				}
				if (newestSummary.warningMessage && newestSummary.warningMessage !== previousSummary?.warningMessage) {
					warningToShow = newestSummary.warningMessage;
				}
				return {
					...current,
					[summary.taskId]: newestSummary,
				};
			});
			if (warningToShow) {
				showAppToast({ intent: "warning", message: warningToShow }, `warning:${summary.taskId}`);
			}
		},
		[setSessions],
	);

	const sendTaskSessionInput = useCallback(
		async (taskId: string, text: string, options: SendTerminalInputOptions): Promise<SendTaskSessionInputResult> => {
			const appendNewline = options.appendNewline ?? true;
			const controller = options.preferTerminal === false ? null : getTerminalController(taskId);
			if (controller) {
				const sent = appendNewline
					? (options.mode === "paste" ? controller.paste(text) : controller.input(text)) && controller.input("\r")
					: options.mode === "paste"
						? controller.paste(text)
						: controller.input(text);
				if (sent) {
					return { ok: true };
				}
			}
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.sendTaskSessionInput.mutate({
					taskId,
					text,
					appendNewline,
					intent: options.intent,
				});
				if (!payload.ok) {
					return { ok: false, message: payload.error || "Task session input failed." };
				}
				if (payload.summary) {
					upsertSession(payload.summary);
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: toErrorMessage(error) };
			}
		},
		[currentProjectId, upsertSession],
	);

	const fetchTaskWorktreeInfo = useCallback(
		async (task: BoardCard): Promise<RuntimeTaskRepositoryInfoResponse | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				return await trpcClient.project.getTaskContext.query({
					taskId: task.id,
					baseRef: task.baseRef,
				});
			} catch (error) {
				notifyError(toErrorMessage(error));
				return null;
			}
		},
		[currentProjectId],
	);

	return { upsertSession, sendTaskSessionInput, fetchTaskWorktreeInfo };
}
