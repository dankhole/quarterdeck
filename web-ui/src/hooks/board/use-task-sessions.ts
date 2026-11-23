// Frontend facade for task-scoped runtime data-plane actions. Durable task
// lifecycle changes belong to useTaskLifecycleOperations; this hook only
// merges summaries, sends agent input, and reads task context.

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

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
	upsertSession: (projectId: string, summary: RuntimeTaskSessionSummary) => void;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options: SendTerminalInputOptions,
	) => Promise<SendTaskSessionInputResult>;
	fetchTaskWorktreeInfo: (task: BoardCard) => Promise<RuntimeTaskRepositoryInfoResponse | null>;
}

export function useTaskSessions({ currentProjectId, setSessions }: UseTaskSessionsInput): UseTaskSessionsResult {
	// Fence retained async callbacks before passive terminal cleanup can publish summaries.
	const projectScope = useMemo(() => ({ projectId: currentProjectId }), [currentProjectId]);
	const activeProjectScopeRef = useRef<typeof projectScope | null>(projectScope);
	const activeProjectIdRef = useRef(currentProjectId);
	useLayoutEffect(() => {
		activeProjectScopeRef.current = projectScope;
		activeProjectIdRef.current = currentProjectId;
		return () => {
			activeProjectScopeRef.current = null;
			activeProjectIdRef.current = null;
		};
	}, [currentProjectId, projectScope]);

	/*
		This merge needs to stay monotonic. An older hydrated or cached summary
		must not replace a newer live session identity, or terminal consumers can
		bounce between instances and clear visible output.
	*/
	const upsertSession = useCallback(
		(projectId: string, summary: RuntimeTaskSessionSummary) => {
			if (!projectId || projectId !== activeProjectIdRef.current) return;
			let warningToShow: string | null = null;
			setSessions((current) => {
				// Recheck when React applies a queued update, after any navigation.
				if (projectId !== activeProjectIdRef.current) return current;
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
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			if (activeProjectScopeRef.current !== projectScope) {
				return { ok: false, message: "Project changed before input could be sent." };
			}
			const appendNewline = options.appendNewline ?? true;
			const controller =
				options.preferTerminal === false || options.replyToSessionInstanceId
					? null
					: getTerminalController(taskId, { projectId: currentProjectId });
			if (options.asAgentDraft) {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Controls can escape the bracketed paste or act as keys.
				if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text.replace(/\r\n/g, "\n"))) {
					return {
						ok: false,
						message: "Remove terminal control characters from the prompt shortcut and try again.",
					};
				}
				// The runtime fallback sends raw text, even when mode is paste.
				if (!controller?.paste(text, { asAgentDraft: true })) {
					return {
						ok: false,
						message: "Open the task's agent terminal and wait for it to accept input, then try again.",
					};
				}
				controller.focus?.();
				return { ok: true };
			}
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
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.sendTaskSessionInput.mutate({
					taskId,
					text,
					appendNewline,
					intent: options.intent,
					replyToSessionInstanceId: options.replyToSessionInstanceId,
				});
				if (activeProjectScopeRef.current !== projectScope) {
					return { ok: false, message: "Project changed before input delivery was confirmed." };
				}
				if (!payload.ok) {
					return { ok: false, message: payload.error || "Task session input failed." };
				}
				if (payload.summary) {
					upsertSession(currentProjectId, payload.summary);
				}
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					message: options.replyToSessionInstanceId
						? "Delivery could not be confirmed. Check the agent before resending."
						: toErrorMessage(error),
				};
			}
		},
		[currentProjectId, projectScope, upsertSession],
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
