import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTaskColumnId, moveTaskToColumn } from "@/state/board-state";
import type { BoardColumnId, BoardData } from "@/types";

interface UseSessionColumnSyncInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	tryProgrammaticCardMove: (
		taskId: string,
		fromColumnId: BoardColumnId,
		toColumnId: BoardColumnId,
		options?: { skipKickoff?: boolean; skipTrashWorkflow?: boolean; skipWorkingChangeWarning?: boolean },
	) => "started" | "blocked" | "unavailable";
	programmaticCardMoveCycle: number;
}

/**
 * Keeps board column positions in sync with server-side session state.
 * Moves cards between in_progress and review when the session state changes.
 *
 * Session lifecycle (crash recovery, auto-restart, startup resume) is
 * handled entirely on the server — this hook only reacts to the resulting
 * state transitions.
 */
export function useSessionColumnSync({
	board,
	setBoard,
	sessions,
	tryProgrammaticCardMove,
	programmaticCardMoveCycle,
}: UseSessionColumnSyncInput): void {
	const previousSessionsRef = useRef<Record<string, RuntimeTaskSessionSummary>>({});

	useEffect(() => {
		setBoard((currentBoard) => {
			let nextBoard = currentBoard;
			const previousSessions = previousSessionsRef.current;
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
				}
			}
			previousSessionsRef.current = { ...sessions };
			return nextBoard;
		});
	}, [board, sessions, programmaticCardMoveCycle, setBoard, tryProgrammaticCardMove]);
}
