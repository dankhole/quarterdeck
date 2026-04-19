import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
	findTrashTaskIds,
	type HardDeleteDialogState,
	INITIAL_HARD_DELETE_DIALOG_STATE,
	INITIAL_TRASH_WARNING_STATE,
	type TrashWarningState,
} from "@/hooks/board/trash-workflow";
import type { UseTaskLifecycleResult } from "@/hooks/board/use-task-lifecycle";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { clearColumnTasks, findCardSelection, moveTaskToColumn, removeTask } from "@/state/board-state";
import { clearTaskWorktreeInfo } from "@/stores/project-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

export type { HardDeleteDialogState, TrashWarningState } from "@/hooks/board/trash-workflow";
export { INITIAL_HARD_DELETE_DIALOG_STATE, INITIAL_TRASH_WARNING_STATE } from "@/hooks/board/trash-workflow";

interface SelectedBoardCard {
	card: BoardCard;
	column: {
		id: BoardColumnId;
	};
}

interface UseTrashWorkflowInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	selectedCard: SelectedBoardCard | null;
	selectedTaskId: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
	stopTaskSession: (taskId: string, options?: { waitForExit?: boolean }) => Promise<void>;
	cleanupTaskWorktree: (taskId: string) => Promise<unknown>;
	resumeTaskFromTrash: UseTaskLifecycleResult["resumeTaskFromTrash"];
	tryProgrammaticCardMove: (
		taskId: string,
		fromColumnId: BoardColumnId,
		toColumnId: BoardColumnId,
		options?: { skipKickoff?: boolean; skipTrashWorkflow?: boolean; skipWorkingChangeWarning?: boolean },
	) => "started" | "blocked" | "unavailable";
	requestMoveTaskToTrashWithAnimation: (taskId: string, fromColumnId: BoardColumnId) => Promise<void>;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
}

export interface UseTrashWorkflowResult {
	moveToTrashLoadingById: Record<string, boolean>;
	trashTaskCount: number;
	trashWarningState: TrashWarningState;
	hardDeleteDialogState: HardDeleteDialogState;
	setTaskMoveToTrashLoading: (taskId: string, isLoading: boolean) => void;
	handleMoveToTrash: () => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleHardDeleteTrashTask: (taskId: string) => void;
	handleCancelHardDelete: () => void;
	handleConfirmHardDelete: () => void;
	handleOpenClearTrash: () => void;
	handleConfirmClearTrash: () => void;
	handleCancelTrashWarning: () => void;
	handleConfirmTrashWarning: () => void;
	setTrashWarningState: Dispatch<SetStateAction<TrashWarningState>>;
	resetTrashWorkflowState: () => void;
}

export function useTrashWorkflow({
	board,
	setBoard,
	selectedCard,
	selectedTaskId,
	setSelectedTaskId,
	setSessions,
	setIsClearTrashDialogOpen,
	stopTaskSession,
	cleanupTaskWorktree,
	resumeTaskFromTrash,
	tryProgrammaticCardMove,
	requestMoveTaskToTrashWithAnimation,
	confirmMoveTaskToTrash,
}: UseTrashWorkflowInput): UseTrashWorkflowResult {
	const moveToTrashLoadingByIdRef = useRef<Record<string, true>>({});
	const [moveToTrashLoadingById, setMoveToTrashLoadingById] = useState<Record<string, boolean>>({});
	const [trashWarningState, setTrashWarningState] = useState<TrashWarningState>(INITIAL_TRASH_WARNING_STATE);
	const trashWarningConfirmedRef = useRef(false);
	const [hardDeleteDialogState, setHardDeleteDialogState] = useState<HardDeleteDialogState>(
		INITIAL_HARD_DELETE_DIALOG_STATE,
	);
	const hardDeleteConfirmedRef = useRef(false);

	const trashTaskIds = useMemo(() => findTrashTaskIds(board), [board.columns]);
	const trashTaskCount = trashTaskIds.length;

	const setTaskMoveToTrashLoading = useCallback((taskId: string, isLoading: boolean) => {
		if (isLoading) {
			moveToTrashLoadingByIdRef.current[taskId] = true;
			setMoveToTrashLoadingById((current) => {
				if (current[taskId]) {
					return current;
				}
				return {
					...current,
					[taskId]: true,
				};
			});
			return;
		}

		delete moveToTrashLoadingByIdRef.current[taskId];
		setMoveToTrashLoadingById((current) => {
			if (!current[taskId]) {
				return current;
			}
			const next = { ...current };
			delete next[taskId];
			return next;
		});
	}, []);

	const handleMoveToTrash = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		if (moveToTrashLoadingByIdRef.current[selectedCard.card.id] || trashWarningState.open) {
			return;
		}
		setTaskMoveToTrashLoading(selectedCard.card.id, true);
		void requestMoveTaskToTrashWithAnimation(selectedCard.card.id, selectedCard.column.id).finally(() => {
			setTaskMoveToTrashLoading(selectedCard.card.id, false);
		});
	}, [requestMoveTaskToTrashWithAnimation, selectedCard, setTaskMoveToTrashLoading, trashWarningState.open]);

	const handleMoveReviewCardToTrash = useCallback(
		(taskId: string) => {
			if (moveToTrashLoadingByIdRef.current[taskId] || trashWarningState.open) {
				return;
			}
			const selection = findCardSelection(board, taskId);
			const fromColumnId = selection?.column.id ?? "review";
			setTaskMoveToTrashLoading(taskId, true);
			void requestMoveTaskToTrashWithAnimation(taskId, fromColumnId).finally(() => {
				setTaskMoveToTrashLoading(taskId, false);
			});
		},
		[board, requestMoveTaskToTrashWithAnimation, setTaskMoveToTrashLoading, trashWarningState.open],
	);

	const handleRestoreTaskFromTrash = useCallback(
		(taskId: string) => {
			const programmaticMoveAttempt = tryProgrammaticCardMove(taskId, "trash", "review");
			if (programmaticMoveAttempt === "started") {
				return;
			}

			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "trash") {
				return;
			}

			const moved = moveTaskToColumn(board, taskId, "review", { insertAtTop: true });
			if (!moved.moved) {
				return;
			}
			setBoard(moved.board);
			const movedSelection = findCardSelection(moved.board, taskId);
			if (!movedSelection) {
				return;
			}
			void resumeTaskFromTrash(movedSelection.card, taskId, { optimisticMoveApplied: true });
		},
		[board, resumeTaskFromTrash, setBoard, tryProgrammaticCardMove],
	);

	const executeHardDelete = useCallback(
		(taskId: string) => {
			let didRemove = false;
			setBoard((currentBoard) => {
				const selection = findCardSelection(currentBoard, taskId);
				if (!selection || selection.column.id !== "trash") {
					return currentBoard;
				}
				const result = removeTask(currentBoard, taskId);
				if (!result.removed) {
					return currentBoard;
				}
				didRemove = true;
				return result.board;
			});
			if (!didRemove) {
				return;
			}

			setSessions((currentSessions) => {
				const nextSessions = { ...currentSessions };
				delete nextSessions[taskId];
				return nextSessions;
			});
			setSelectedTaskId((current) => {
				if (current === taskId) {
					clearTaskWorktreeInfo(taskId);
					return null;
				}
				return current;
			});

			void (async () => {
				await stopTaskSession(taskId, { waitForExit: true });
				await cleanupTaskWorktree(taskId);
			})();
		},
		[cleanupTaskWorktree, setBoard, setSelectedTaskId, setSessions, stopTaskSession],
	);

	const handleHardDeleteTrashTask = useCallback(
		(taskId: string) => {
			const card = board.columns.flatMap((col) => col.cards).find((c) => c.id === taskId);
			setHardDeleteDialogState({
				open: true,
				taskId,
				taskTitle: card?.title ?? null,
			});
		},
		[board.columns],
	);

	const handleCancelHardDelete = useCallback(() => {
		// Radix AlertDialog fires onOpenChange(false) after confirm — the ref guard
		// prevents the cancel handler from resetting state after confirm already ran.
		if (hardDeleteConfirmedRef.current) {
			hardDeleteConfirmedRef.current = false;
			return;
		}
		setHardDeleteDialogState(INITIAL_HARD_DELETE_DIALOG_STATE);
	}, []);

	const handleConfirmHardDelete = useCallback(() => {
		if (!hardDeleteDialogState.open || !hardDeleteDialogState.taskId) {
			return;
		}
		hardDeleteConfirmedRef.current = true;
		const { taskId } = hardDeleteDialogState;
		setHardDeleteDialogState(INITIAL_HARD_DELETE_DIALOG_STATE);
		executeHardDelete(taskId);
	}, [executeHardDelete, hardDeleteDialogState]);

	const handleOpenClearTrash = useCallback(() => {
		if (trashTaskCount === 0) {
			return;
		}
		setIsClearTrashDialogOpen(true);
	}, [setIsClearTrashDialogOpen, trashTaskCount]);

	const handleConfirmClearTrash = useCallback(() => {
		const taskIds = [...trashTaskIds];
		setIsClearTrashDialogOpen(false);
		if (taskIds.length === 0) {
			return;
		}

		setBoard((currentBoard) => clearColumnTasks(currentBoard, "trash").board);
		setSessions((currentSessions) => {
			const nextSessions = { ...currentSessions };
			for (const taskId of taskIds) {
				delete nextSessions[taskId];
			}
			return nextSessions;
		});
		if (selectedTaskId && taskIds.includes(selectedTaskId)) {
			setSelectedTaskId(null);
			clearTaskWorktreeInfo(selectedTaskId);
		}

		void (async () => {
			await Promise.all(
				taskIds.map(async (taskId) => {
					await stopTaskSession(taskId, { waitForExit: true });
					await cleanupTaskWorktree(taskId);
				}),
			);
		})();
	}, [
		cleanupTaskWorktree,
		selectedTaskId,
		setBoard,
		setIsClearTrashDialogOpen,
		setSelectedTaskId,
		setSessions,
		stopTaskSession,
		trashTaskIds,
	]);

	const handleCancelTrashWarning = useCallback(() => {
		// When the user clicks confirm, Radix AlertDialog fires onOpenChange(false) which triggers
		// this cancel handler with a stale closure (React state hasn't re-rendered yet). The ref
		// lets us detect that confirm already ran and skip the revert.
		if (trashWarningConfirmedRef.current) {
			console.debug("[trash-warning] cancel skipped — confirm already in progress (ref guard)");
			trashWarningConfirmedRef.current = false;
			return;
		}
		const { card, fromColumnId, optimisticMoveApplied } = trashWarningState;
		console.debug("[trash-warning] cancel handler fired", {
			open: trashWarningState.open,
			cardId: card?.id ?? null,
			fromColumnId,
			optimisticMoveApplied,
		});
		if (trashWarningState.open && card && fromColumnId && optimisticMoveApplied) {
			console.debug("[trash-warning] reverting optimistic move", { cardId: card.id, fromColumnId });
			setBoard((currentBoard) => {
				const reverted = moveTaskToColumn(currentBoard, card.id, fromColumnId);
				return reverted.moved ? reverted.board : currentBoard;
			});
		}
		setTrashWarningState(INITIAL_TRASH_WARNING_STATE);
	}, [setBoard, trashWarningState]);

	const handleConfirmTrashWarning = useCallback(() => {
		if (!trashWarningState.open || !trashWarningState.card) {
			console.debug("[trash-warning] confirm handler bailed — no open state or card");
			return;
		}
		const { card } = trashWarningState;
		console.debug("[trash-warning] confirm handler — trashing card", { cardId: card.id });
		trashWarningConfirmedRef.current = true;
		setTrashWarningState(INITIAL_TRASH_WARNING_STATE);
		void confirmMoveTaskToTrash(card).then(
			() => console.debug("[trash-warning] confirmMoveTaskToTrash resolved", { cardId: card.id }),
			(err) => console.error("[trash-warning] confirmMoveTaskToTrash failed", { cardId: card.id, err }),
		);
	}, [confirmMoveTaskToTrash, trashWarningState]);

	const resetTrashWorkflowState = useCallback(() => {
		moveToTrashLoadingByIdRef.current = {};
		setMoveToTrashLoadingById({});
		setIsClearTrashDialogOpen(false);
		setTrashWarningState(INITIAL_TRASH_WARNING_STATE);
		setHardDeleteDialogState(INITIAL_HARD_DELETE_DIALOG_STATE);
	}, [setIsClearTrashDialogOpen]);

	return {
		moveToTrashLoadingById,
		trashTaskCount,
		trashWarningState,
		hardDeleteDialogState,
		setTaskMoveToTrashLoading,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		handleRestoreTaskFromTrash,
		handleHardDeleteTrashTask,
		handleCancelHardDelete,
		handleConfirmHardDelete,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		handleCancelTrashWarning,
		handleConfirmTrashWarning,
		setTrashWarningState,
		resetTrashWorkflowState,
	};
}
