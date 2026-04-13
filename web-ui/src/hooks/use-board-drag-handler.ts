import type { DropResult } from "@hello-pangea/dnd";
import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import type { UseTaskLifecycleResult } from "@/hooks/use-task-lifecycle";
import { applyDragResult, findCardSelection } from "@/state/board-state";
import type { ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardColumnId, BoardData } from "@/types";

interface ProgrammaticCardMoveBehavior {
	skipKickoff?: boolean;
	skipTrashWorkflow?: boolean;
	skipWorkingChangeWarning?: boolean;
}

interface UseBoardDragHandlerInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	kickoffTaskInProgress: UseTaskLifecycleResult["kickoffTaskInProgress"];
	resumeTaskFromTrash: UseTaskLifecycleResult["resumeTaskFromTrash"];
	resolvePendingProgrammaticStartMove: (taskId: string, started: boolean) => void;
	consumeProgrammaticCardMove: (taskId: string) => {
		behavior?: ProgrammaticCardMoveBehavior;
		programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight;
	};
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: { optimisticMoveApplied?: boolean; skipWorkingChangeWarning?: boolean },
	) => Promise<void>;
	resolvePendingProgrammaticTrashMove: (taskId: string) => void;
}

export interface UseBoardDragHandlerResult {
	handleDragEnd: (result: DropResult, options?: { selectDroppedTask?: boolean }) => void;
	handleDetailTaskDragEnd: (result: DropResult) => void;
}

export function useBoardDragHandler({
	board,
	setBoard,
	setSelectedTaskId,
	kickoffTaskInProgress,
	resumeTaskFromTrash,
	resolvePendingProgrammaticStartMove,
	consumeProgrammaticCardMove,
	requestMoveTaskToTrash,
	resolvePendingProgrammaticTrashMove,
}: UseBoardDragHandlerInput): UseBoardDragHandlerResult {
	const handleDragEnd = useCallback(
		(result: DropResult, options?: { selectDroppedTask?: boolean }) => {
			if (options?.selectDroppedTask && result.type.startsWith("CARD") && result.destination) {
				setSelectedTaskId(result.draggableId);
			}
			const { behavior: programmaticMoveBehavior, programmaticCardMoveInFlight } = consumeProgrammaticCardMove(
				result.draggableId,
			);

			const applied = applyDragResult(board, result, { programmaticCardMoveInFlight });

			const moveEvent = applied.moveEvent;
			if (!moveEvent) {
				resolvePendingProgrammaticStartMove(result.draggableId, false);
				setBoard(applied.board);
				return;
			}

			if (moveEvent.toColumnId === "trash") {
				setBoard(applied.board);
				if (programmaticMoveBehavior?.skipTrashWorkflow) {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
					return;
				}
				const requestPromise = requestMoveTaskToTrash(moveEvent.taskId, moveEvent.fromColumnId, {
					optimisticMoveApplied: true,
					skipWorkingChangeWarning: programmaticMoveBehavior?.skipWorkingChangeWarning,
				});
				void requestPromise.finally(() => {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
				});
				return;
			}

			if (moveEvent.fromColumnId === "trash" && moveEvent.toColumnId === "review") {
				setBoard(applied.board);
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (!movedSelection) {
					return;
				}
				void resumeTaskFromTrash(movedSelection.card, moveEvent.taskId, { optimisticMoveApplied: true });
				return;
			}

			setBoard(applied.board);

			if (
				moveEvent.toColumnId === "in_progress" &&
				moveEvent.fromColumnId === "backlog" &&
				!programmaticMoveBehavior?.skipKickoff
			) {
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (movedSelection) {
					void kickoffTaskInProgress(movedSelection.card, moveEvent.taskId, moveEvent.fromColumnId)
						.then((started) => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, started);
						})
						.catch(() => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
						});
					return;
				}
				resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
				return;
			}
			resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
		},
		[
			board,
			consumeProgrammaticCardMove,
			kickoffTaskInProgress,
			requestMoveTaskToTrash,
			resumeTaskFromTrash,
			resolvePendingProgrammaticStartMove,
			resolvePendingProgrammaticTrashMove,
			setBoard,
			setSelectedTaskId,
		],
	);

	const handleDetailTaskDragEnd = useCallback(
		(result: DropResult) => {
			handleDragEnd(result);
		},
		[handleDragEnd],
	);

	return { handleDragEnd, handleDetailTaskDragEnd };
}
