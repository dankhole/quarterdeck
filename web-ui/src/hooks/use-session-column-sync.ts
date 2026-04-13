import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { showNonIsolatedResumeWarning } from "@/hooks/use-task-lifecycle";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTaskColumnId, moveTaskToColumn } from "@/state/board-state";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

interface UseSessionColumnSyncInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	currentProjectId: string | null;
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	stopTaskSession: (taskId: string, options?: { waitForExit?: boolean }) => Promise<void>;
	tryProgrammaticCardMove: (
		taskId: string,
		fromColumnId: BoardColumnId,
		toColumnId: BoardColumnId,
		options?: { skipKickoff?: boolean; skipTrashWorkflow?: boolean; skipWorkingChangeWarning?: boolean },
	) => "started" | "blocked" | "unavailable";
	programmaticCardMoveCycle: number;
}

export function useSessionColumnSync({
	board,
	setBoard,
	sessions,
	setSelectedTaskId,
	currentProjectId,
	startTaskSession,
	stopTaskSession,
	tryProgrammaticCardMove,
	programmaticCardMoveCycle,
}: UseSessionColumnSyncInput): void {
	const previousSessionsRef = useRef<Record<string, RuntimeTaskSessionSummary>>({});

	// ── Session state → column sync ─────────────────────────────────────
	useEffect(() => {
		setBoard((currentBoard) => {
			let nextBoard = currentBoard;
			const previousSessions = previousSessionsRef.current;
			const blockedInterruptedTaskIds = new Set<string>();
			for (const summary of Object.values(sessions)) {
				const previous = previousSessions[summary.taskId];
				if (previous && previous.updatedAt > summary.updatedAt) {
					continue;
				}
				const columnId = getTaskColumnId(nextBoard, summary.taskId);
				if (summary.state === "awaiting_review" && columnId === "in_progress") {
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "review");
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "review", { insertAtTop: true });
					if (moved.moved) {
						nextBoard = moved.board;
					}
					continue;
				}
				if (summary.state === "running" && columnId === "review") {
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "in_progress", {
						skipKickoff: true,
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "in_progress", { insertAtTop: true });
					if (moved.moved) {
						nextBoard = moved.board;
					}
					continue;
				}
				if (
					summary.state === "interrupted" &&
					previous?.state !== "interrupted" &&
					columnId &&
					columnId !== "trash"
				) {
					const nextTaskId = getNextDetailTaskIdAfterTrashMove(nextBoard, summary.taskId);
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "trash", {
						skipTrashWorkflow: true,
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						if (programmaticMoveAttempt === "blocked") {
							blockedInterruptedTaskIds.add(summary.taskId);
						}
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === summary.taskId ? nextTaskId : currentSelectedTaskId,
						);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "trash", { insertAtTop: true });
					if (moved.moved) {
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === summary.taskId ? nextTaskId : currentSelectedTaskId,
						);
						nextBoard = moved.board;
					}
				}
			}
			const nextPreviousSessions = { ...sessions };
			for (const taskId of blockedInterruptedTaskIds) {
				const previousSession = previousSessions[taskId];
				if (previousSession) {
					nextPreviousSessions[taskId] = previousSession;
					continue;
				}
				delete nextPreviousSessions[taskId];
			}
			previousSessionsRef.current = nextPreviousSessions;
			return nextBoard;
		});
	}, [programmaticCardMoveCycle, sessions, setBoard, setSelectedTaskId, tryProgrammaticCardMove]);

	// ── Crash recovery auto-restart ─────────────────────────────────────
	// After a server crash, sessions that were running are hydrated as
	// "interrupted" in their original columns (in_progress / review).
	// Graceful shutdown moves tasks to trash, so interrupted + active column
	// is a reliable crash-recovery signal. Auto-restart each with --continue.
	const crashRecoveryAttemptedRef = useRef<string | null>(null);
	useEffect(() => {
		// Run once per project. Reset when project changes.
		if (crashRecoveryAttemptedRef.current === currentProjectId) {
			return;
		}
		// Wait until workspace data has arrived — on cold start, currentProjectId
		// can be set before board/sessions are populated. An empty sessions object
		// means the workspace state hasn't loaded yet; skip without setting the ref
		// so we re-check on the next render when data is available. If the board
		// has cards but sessions is empty, the project has tasks that were never
		// started — nothing to recover, so set the ref to avoid re-checking.
		if (Object.keys(sessions).length === 0) {
			if (board.columns.some((c) => c.cards.length > 0)) {
				crashRecoveryAttemptedRef.current = currentProjectId;
			}
			return;
		}
		const crashRecoveredTasks: Array<{ card: BoardCard; columnId: BoardColumnId }> = [];
		for (const column of board.columns) {
			if (column.id !== "in_progress" && column.id !== "review") {
				continue;
			}
			for (const card of column.cards) {
				const session = sessions[card.id];
				if (session?.state === "interrupted" && session.reviewReason === "interrupted") {
					crashRecoveredTasks.push({ card, columnId: column.id });
				}
			}
		}
		if (crashRecoveredTasks.length === 0) {
			crashRecoveryAttemptedRef.current = currentProjectId;
			return;
		}
		crashRecoveryAttemptedRef.current = currentProjectId;
		const count = crashRecoveredTasks.length;
		showAppToast({
			intent: "primary",
			message: `Resuming ${count} session${count > 1 ? "s" : ""} after crash\u2026`,
			timeout: 4000,
		});
		for (const { card, columnId } of crashRecoveredTasks) {
			const awaitReview = columnId === "review";
			void (async () => {
				try {
					await stopTaskSession(card.id, { waitForExit: true });
					const result = await startTaskSession(card, { resumeConversation: true, awaitReview });
					if (!result.ok) {
						notifyError(`Could not resume "${card.title}": ${result.message ?? "unknown error"}`);
					} else if (card.useWorktree === false) {
						showNonIsolatedResumeWarning();
					}
				} catch {
					notifyError(`Failed to resume "${card.title}".`);
				}
			})();
		}
	}, [board, sessions, currentProjectId, startTaskSession, stopTaskSession]);

	// Reset previousSessionsRef when project changes.
	useEffect(() => {
		previousSessionsRef.current = {};
	}, [currentProjectId]);
}
