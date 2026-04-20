import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef } from "react";

import { resolveSessionColumnProjectionMove } from "@/hooks/board/session-column-sync";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { moveTaskToColumn } from "@/state/board-state";
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
				const move = resolveSessionColumnProjectionMove(nextBoard, summary);
				if (!move) {
					continue;
				}
				const programmaticMoveAttempt = tryProgrammaticCardMove(
					move.taskId,
					move.fromColumnId,
					move.toColumnId,
					move.skipKickoff ? { skipKickoff: true } : undefined,
				);
				if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
					continue;
				}
				const moved = moveTaskToColumn(nextBoard, move.taskId, move.toColumnId, { insertAtTop: true });
				if (moved.moved) {
					nextBoard = moved.board;
				}
			}
			previousSessionsRef.current = { ...sessions };
			return nextBoard;
		});
	}, [board, sessions, programmaticCardMoveCycle, setBoard, tryProgrammaticCardMove]);
}
