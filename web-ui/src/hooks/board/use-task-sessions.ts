// Frontend facade for task-scoped runtime actions.
// It owns how the board and detail view start, stop, resize, and route task
// sessions across PTY-backed agents.
import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { resolveTaskStartGeometry } from "@/hooks/board/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskSessionSummary,
	RuntimeTaskWorktreeInfoResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "@/runtime/types";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard } from "@/types";
import { createClientLogger } from "@/utils/client-logger";
import { selectNewestTaskSessionSummary } from "@/utils/session-summary-utils";
import { toErrorMessage } from "@/utils/to-error-message";

const log = createClientLogger("task-session");

interface UseTaskSessionsInput {
	currentProjectId: string | null;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	/** Called after startTaskSession resolves the working directory so the caller can persist it on the card. */
	onWorkingDirectoryResolved?: (taskId: string, workingDirectory: string) => void;
}

interface EnsureTaskWorktreeResult {
	ok: boolean;
	message?: string;
	response?: Extract<RuntimeWorktreeEnsureResponse, { ok: true }>;
}

interface SendTaskSessionInputResult {
	ok: boolean;
	message?: string;
}

interface StartTaskSessionResult {
	ok: boolean;
	message?: string;
	summary?: RuntimeTaskSessionSummary;
}

interface StartTaskSessionOptions {
	resumeConversation?: boolean;
	awaitReview?: boolean;
}

export interface UseTaskSessionsResult {
	upsertSession: (summary: RuntimeTaskSessionSummary) => void;
	ensureTaskWorktree: (task: BoardCard) => Promise<EnsureTaskWorktreeResult>;
	startTaskSession: (task: BoardCard, options?: StartTaskSessionOptions) => Promise<StartTaskSessionResult>;
	stopTaskSession: (taskId: string, options?: { waitForExit?: boolean }) => Promise<void>;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<SendTaskSessionInputResult>;
	cleanupTaskWorktree: (taskId: string) => Promise<RuntimeWorktreeDeleteResponse | null>;
	fetchTaskWorktreeInfo: (task: BoardCard) => Promise<RuntimeTaskWorktreeInfoResponse | null>;
}

export function useTaskSessions({
	currentProjectId,
	setSessions,
	onWorkingDirectoryResolved,
}: UseTaskSessionsInput): UseTaskSessionsResult {
	/*
		This merge needs to stay monotonic.

		We chased a nasty terminal bug where Home and Detail panes would appear to
		clear themselves right after starting a task or shell command. The actual
		sequence was:

		1. A new live session started and the terminal correctly saw a new startedAt.
		2. usePersistentTerminalSession reset the xterm instance for the new session.
		3. A stale summary from an older interrupted session was replayed back into
		   React state from project hydration or the persistent terminal cache.
		4. That older summary overwrote the newer running one.
		5. The UI then bounced between old and new session identities, causing extra
		   cleanup, remount, and reset cycles that looked like the terminal output
		   had vanished.

		Because of that, every task/session summary write here must prefer the
		newest summary and ignore older ones. If this ever becomes a plain
		last-write-wins assignment again, the "terminal randomly clears out"
		regression is very likely to come back.
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
				// Surface server-side warnings as toasts when they first appear.
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

	// Ensures a worktree exists for a task (used by restore-from-trash).
	// Must pass task.branch so ensureTaskWorktreeIfDoesntExist can do branch-aware checkout.
	// The other path to that function is startTaskSession (runtime-api.ts), which reads
	// branch from persisted board state server-side instead.
	const ensureTaskWorktree = useCallback(
		async (task: BoardCard): Promise<EnsureTaskWorktreeResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.project.ensureWorktree.mutate({
					taskId: task.id,
					baseRef: task.baseRef,
					branch: task.branch ?? null,
				});
				if (!payload.ok) {
					return {
						ok: false,
						message: payload.error ?? "Worktree setup failed.",
					};
				}
				return { ok: true, response: payload };
			} catch (error) {
				const message = toErrorMessage(error);
				return { ok: false, message };
			}
		},
		[currentProjectId],
	);

	const startTaskSession = useCallback(
		async (task: BoardCard, options?: StartTaskSessionOptions): Promise<StartTaskSessionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			log.debug("startTaskSession trpc call", {
				taskId: task.id,
				resumeConversation: options?.resumeConversation ?? false,
				awaitReview: options?.awaitReview ?? false,
				useWorktree: task.useWorktree,
				hasPrompt: !options?.resumeConversation && task.prompt.trim().length > 0,
			});
			try {
				const kickoffPrompt = options?.resumeConversation ? "" : task.prompt.trim();
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const geometry = await resolveTaskStartGeometry({
					taskId: task.id,
					viewportWidth: window.innerWidth,
					viewportHeight: window.innerHeight,
				});
				const payload = await trpcClient.runtime.startTaskSession.mutate({
					taskId: task.id,
					prompt: kickoffPrompt,
					images: options?.resumeConversation ? undefined : task.images,
					startInPlanMode: options?.resumeConversation ? undefined : task.startInPlanMode,
					resumeConversation: options?.resumeConversation,
					awaitReview: options?.awaitReview,
					baseRef: task.baseRef,
					useWorktree: task.useWorktree,
					cols: geometry.cols,
					rows: geometry.rows,
				});
				log.debug("startTaskSession trpc resolved", {
					taskId: task.id,
					ok: payload.ok,
					error: payload.ok ? null : (payload.error ?? null),
					summaryState: payload.summary?.state ?? null,
					summaryAgentId: payload.summary?.agentId ?? null,
					summaryPid: payload.summary?.pid ?? null,
					summaryResumeSessionId: payload.summary?.resumeSessionId ?? null,
				});
				if (!payload.ok || !payload.summary) {
					return {
						ok: false,
						message: payload.error ?? "Task session start failed.",
					};
				}
				upsertSession(payload.summary);
				// The server resolves the working directory but no longer persists
				// it — the client caches it on the card through its normal persist.
				if (payload.summary.sessionLaunchPath) {
					onWorkingDirectoryResolved?.(task.id, payload.summary.sessionLaunchPath);
				}
				return { ok: true, summary: payload.summary };
			} catch (error) {
				const message = toErrorMessage(error);
				log.warn("startTaskSession trpc rejected", { taskId: task.id, error: message });
				return { ok: false, message };
			}
		},
		[currentProjectId, onWorkingDirectoryResolved, upsertSession],
	);

	const stopTaskSession = useCallback(
		async (taskId: string, options?: { waitForExit?: boolean }): Promise<void> => {
			if (!currentProjectId) {
				return;
			}
			log.debug("stopTaskSession trpc call", {
				taskId,
				waitForExit: options?.waitForExit ?? false,
			});
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const response = await trpcClient.runtime.stopTaskSession.mutate({
					taskId,
					waitForExit: options?.waitForExit,
				});
				log.debug("stopTaskSession trpc resolved", {
					taskId,
					ok: response.ok,
					state: response.summary?.state ?? null,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.warn("stopTaskSession trpc rejected", { taskId, error: message });
				// Ignore stop errors during cleanup.
			}
		},
		[currentProjectId],
	);

	const sendTaskSessionInput = useCallback(
		async (taskId: string, text: string, options?: SendTerminalInputOptions): Promise<SendTaskSessionInputResult> => {
			const appendNewline = options?.appendNewline ?? true;
			const controller = options?.preferTerminal === false ? null : getTerminalController(taskId);
			if (controller) {
				const sent =
					options?.mode === "paste"
						? !appendNewline && controller.paste(text)
						: controller.input(appendNewline ? `${text}\n` : text);
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
				});
				if (!payload.ok) {
					const errorMessage = payload.error || "Task session input failed.";
					return { ok: false, message: errorMessage };
				}
				if (payload.summary) {
					upsertSession(payload.summary);
				}
				return { ok: true };
			} catch (error) {
				const message = toErrorMessage(error);
				return { ok: false, message };
			}
		},
		[currentProjectId, upsertSession],
	);

	const cleanupTaskWorktree = useCallback(
		async (taskId: string): Promise<RuntimeWorktreeDeleteResponse | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.project.deleteWorktree.mutate({ taskId });
				if (!payload.ok) {
					const message = payload.error ?? "Could not clean up task worktree.";
					log.error("cleanupTaskWorktree failed", { taskId, error: message });
					return null;
				}
				return payload;
			} catch (error) {
				const message = toErrorMessage(error);
				log.error("cleanupTaskWorktree failed", { taskId, error: message });
				return null;
			}
		},
		[currentProjectId],
	);

	const fetchTaskWorktreeInfo = useCallback(
		async (task: BoardCard): Promise<RuntimeTaskWorktreeInfoResponse | null> => {
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
				const message = toErrorMessage(error);
				notifyError(message);
				return null;
			}
		},
		[currentProjectId],
	);

	return {
		upsertSession,
		ensureTaskWorktree,
		startTaskSession,
		stopTaskSession,
		sendTaskSessionInput,
		cleanupTaskWorktree,
		fetchTaskWorktreeInfo,
	};
}
