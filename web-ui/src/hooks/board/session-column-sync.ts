import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTaskColumnId, moveTaskToColumn } from "@/state/board-state";
import type { BoardData } from "@/types";

export interface SessionColumnProjectionMove {
	taskId: string;
	fromColumnId: "in_progress" | "review";
	toColumnId: "in_progress" | "review";
	skipKickoff: boolean;
}

export interface SessionColumnProjectionResult {
	board: BoardData;
	changed: boolean;
	moves: SessionColumnProjectionMove[];
}

export function resolveSessionColumnProjectionMove(
	board: BoardData,
	summary: Pick<RuntimeTaskSessionSummary, "taskId" | "state">,
): SessionColumnProjectionMove | null {
	const columnId = getTaskColumnId(board, summary.taskId);
	if (summary.state === "awaiting_review" && columnId === "in_progress") {
		return {
			taskId: summary.taskId,
			fromColumnId: "in_progress",
			toColumnId: "review",
			skipKickoff: false,
		};
	}
	if (summary.state === "running" && columnId === "review") {
		return {
			taskId: summary.taskId,
			fromColumnId: "review",
			toColumnId: "in_progress",
			skipKickoff: true,
		};
	}
	return null;
}

export function projectBoardWithSessionColumns(
	board: BoardData,
	summaries: Iterable<Pick<RuntimeTaskSessionSummary, "taskId" | "state">>,
): SessionColumnProjectionResult {
	let nextBoard = board;
	const moves: SessionColumnProjectionMove[] = [];

	for (const summary of summaries) {
		const move = resolveSessionColumnProjectionMove(nextBoard, summary);
		if (!move) {
			continue;
		}
		const moved = moveTaskToColumn(nextBoard, move.taskId, move.toColumnId, {
			insertAtTop: true,
		});
		if (!moved.moved) {
			continue;
		}
		nextBoard = moved.board;
		moves.push(move);
	}

	return {
		board: nextBoard,
		changed: moves.length > 0,
		moves,
	};
}
