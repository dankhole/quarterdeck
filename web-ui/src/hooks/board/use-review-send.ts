import { canSendTaskQuickReply, TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";

export interface ReviewSendResult {
	ok: boolean;
	message?: string;
}

interface UseReviewSendInput {
	projectId: string | null;
	taskId: string;
	taskCreatedAt: number;
	summary: RuntimeTaskSessionSummary | null;
	sendInput: (taskId: string, text: string, options: SendTerminalInputOptions) => Promise<ReviewSendResult>;
}

const STALE_TARGET_MESSAGE =
	"The selected task or agent changed. Check the agent before resending; your draft is saved.";
const UNCONFIRMED_MESSAGE = "Delivery could not be confirmed. Check the agent before resending.";
// Operational admission belongs to the browser window, not a comparison draft or
// mounted viewer. Unmount cannot release a request that is still being delivered.
const pendingTargets = new Set<string>();

/** Submit one review to one native agent prompt, without following a replacement session. */
export function useReviewSend({
	projectId,
	taskId,
	taskCreatedAt,
	summary,
	sendInput,
}: UseReviewSendInput): (text: string) => Promise<ReviewSendResult> {
	const sessionInstanceId = summary?.sessionInstanceId ?? null;
	const target = useMemo(
		() => ({ projectId, taskId, taskCreatedAt, sessionInstanceId }),
		[projectId, taskId, taskCreatedAt, sessionInstanceId],
	);
	const currentRef = useRef<{ target: typeof target; summary: RuntimeTaskSessionSummary | null } | null>(null);
	useLayoutEffect(() => {
		currentRef.current = { target, summary };
		return () => {
			currentRef.current = null;
		};
	}, [target, summary]);

	return useCallback(
		async (text: string): Promise<ReviewSendResult> => {
			const current = currentRef.current;
			if (!current || current.target !== target) return { ok: false, message: STALE_TARGET_MESSAGE };
			if (
				!projectId ||
				!sessionInstanceId ||
				current.summary?.taskId !== taskId ||
				!canSendTaskQuickReply(current.summary)
			) {
				return { ok: false, message: "The agent is not ready for a review reply. Your draft is saved." };
			}
			if (!text.trim()) return { ok: false, message: "Enter review comments before sending." };
			if (text.length > TASK_QUICK_REPLY_MAX_LENGTH) {
				return {
					ok: false,
					message: `The complete review exceeds ${TASK_QUICK_REPLY_MAX_LENGTH.toLocaleString()} characters, including file and line context. Shorten the review before sending.`,
				};
			}
			const targetKey = JSON.stringify([projectId, taskId, target.taskCreatedAt, sessionInstanceId]);
			if (pendingTargets.has(targetKey)) {
				return {
					ok: false,
					message: "Another review is being sent to this agent. Wait for it to finish; your draft is saved.",
				};
			}
			pendingTargets.add(targetKey);
			let result: ReviewSendResult;
			try {
				// The runtime validates this exact native session, then bracket-pastes the
				// complete text and submits in one coordinated, acknowledged request.
				result = await sendInput(taskId, text, {
					intent: "submit",
					appendNewline: true,
					preferTerminal: false,
					replyToSessionInstanceId: sessionInstanceId,
				});
			} catch {
				result = { ok: false, message: UNCONFIRMED_MESSAGE };
			} finally {
				pendingTargets.delete(targetKey);
			}
			// Delivery belongs to the captured draft even after navigation or unmount.
			// Preserve its acknowledgement so the store can clear only that snapshot;
			// callers fence any navigation separately, never by rewriting delivery truth.
			return result.ok ? { ok: true } : { ok: false, message: result.message ?? UNCONFIRMED_MESSAGE };
		},
		[projectId, taskId, sessionInstanceId, target, sendInput],
	);
}
