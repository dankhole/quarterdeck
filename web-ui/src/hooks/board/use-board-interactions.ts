import type { DropResult } from "@hello-pangea/dnd";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect } from "react";

import { notifyError } from "@/components/app-toaster";
import type { TaskTrashWarningViewModel } from "@/components/task";
import { useBoardDragHandler } from "@/hooks/board/use-board-drag-handler";
import { useLinkedBacklogTaskActions } from "@/hooks/board/use-linked-backlog-task-actions";
import { useProgrammaticCardMoves } from "@/hooks/board/use-programmatic-card-moves";
import { useReviewAutoActions } from "@/hooks/board/use-review-auto-actions";
import { useSessionColumnSync } from "@/hooks/board/use-session-column-sync";
import { showNonIsolatedResumeWarning, useTaskLifecycle } from "@/hooks/board/use-task-lifecycle";
import type { UseTaskSessionsResult } from "@/hooks/board/use-task-sessions";
import { useTaskStart } from "@/hooks/board/use-task-start";
import { type HardDeleteDialogState, type TrashWarningState, useTrashWorkflow } from "@/hooks/board/use-trash-workflow";
import type { RuntimeTaskSessionSummary, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { findCardSelection, updateTask } from "@/state/board-state";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";

interface SelectedBoardCard {
	card: BoardCard;
	column: {
		id: BoardColumnId;
	};
}

interface UseBoardInteractionsInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	selectedCard: SelectedBoardCard | null;
	selectedTaskId: string | null;
	currentProjectId: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
	setIsGitHistoryOpen: Dispatch<SetStateAction<boolean>>;
	stopTaskSession: (taskId: string, options?: { waitForExit?: boolean }) => Promise<void>;
	cleanupTaskWorkspace: (taskId: string) => Promise<unknown>;
	ensureTaskWorkspace: UseTaskSessionsResult["ensureTaskWorkspace"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	showTrashWorktreeNotice: boolean;
	saveTrashWorktreeNoticeDismissed: () => void;
}

export interface UseBoardInteractionsResult {
	handleProgrammaticCardMoveReady: ReturnType<typeof useProgrammaticCardMoves>["handleProgrammaticCardMoveReady"];
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	handleDeleteDependency: (dependencyId: string) => void;
	handleDragEnd: (result: DropResult, options?: { selectDroppedTask?: boolean }) => void;
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	handleCardSelect: (taskId: string) => void;
	handleMoveToTrash: () => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleHardDeleteTrashTask: (taskId: string) => void;
	hardDeleteDialogState: HardDeleteDialogState;
	handleCancelHardDelete: () => void;
	handleConfirmHardDelete: () => void;
	handleRestartTaskSession: (taskId: string) => void;
	handleCancelAutomaticTaskAction: (taskId: string) => void;
	handleOpenClearTrash: () => void;
	handleConfirmClearTrash: () => void;
	moveToTrashLoadingById: Record<string, boolean>;
	trashTaskCount: number;
	trashWarningState: TrashWarningState;
	handleCancelTrashWarning: () => void;
	handleConfirmTrashWarning: () => void;
}

export function useBoardInteractions({
	board,
	setBoard,
	sessions,
	setSessions,
	selectedCard,
	selectedTaskId,
	currentProjectId,
	setSelectedTaskId,
	setIsClearTrashDialogOpen,
	setIsGitHistoryOpen,
	stopTaskSession,
	cleanupTaskWorkspace,
	ensureTaskWorkspace,
	startTaskSession,
	fetchTaskWorkspaceInfo,
	showTrashWorktreeNotice,
	saveTrashWorktreeNoticeDismissed,
}: UseBoardInteractionsInput): UseBoardInteractionsResult {
	const {
		handleProgrammaticCardMoveReady,
		setRequestMoveTaskToTrashHandler,
		tryProgrammaticCardMove,
		consumeProgrammaticCardMove,
		resolvePendingProgrammaticTrashMove,
		waitForProgrammaticCardMoveAvailability,
		resetProgrammaticCardMoves,
		requestMoveTaskToTrashWithAnimation,
		programmaticCardMoveCycle,
	} = useProgrammaticCardMoves();

	// ── Core lifecycle operations ────────────────────────────────────────
	const { kickoffTaskInProgress, resumeTaskFromTrash } = useTaskLifecycle({
		setBoard,
		selectedTaskId,
		ensureTaskWorkspace,
		startTaskSession,
		fetchTaskWorkspaceInfo,
	});

	// ── Backlog task start + animation ───────────────────────────────────
	const {
		handleStartTask,
		handleStartAllBacklogTasks,
		startBacklogTaskWithAnimation,
		resolvePendingProgrammaticStartMove,
		resetPendingStartMoves,
	} = useTaskStart({
		board,
		setBoard,
		selectedCard,
		kickoffTaskInProgress,
		tryProgrammaticCardMove,
		waitForProgrammaticCardMoveAvailability,
	});

	// ── Linked backlog task actions (dependency graph, trash workflow) ───
	const { confirmMoveTaskToTrash, handleCreateDependency, handleDeleteDependency, requestMoveTaskToTrash } =
		useLinkedBacklogTaskActions({
			board,
			setBoard,
			setSelectedTaskId,
			stopTaskSession,
			cleanupTaskWorkspace,
			kickoffTaskInProgress,
			startBacklogTaskWithAnimation,
			waitForBacklogStartAnimationAvailability: waitForProgrammaticCardMoveAvailability,
			onRequestTrashConfirmation: (
				viewModel: TaskTrashWarningViewModel,
				card: BoardCard,
				fromColumnId: BoardColumnId,
				optimisticMoveApplied: boolean,
			) => {
				console.debug("[trash-warning] showing dialog", {
					cardId: card.id,
					fileCount: viewModel.fileCount,
					fromColumnId,
					optimisticMoveApplied,
				});
				setTrashWarningState({ open: true, warning: viewModel, card, fromColumnId, optimisticMoveApplied });
			},
			showTrashWorktreeNotice,
			saveTrashWorktreeNoticeDismissed,
		});

	useEffect(() => {
		setRequestMoveTaskToTrashHandler(requestMoveTaskToTrash);
	}, [requestMoveTaskToTrash, setRequestMoveTaskToTrashHandler]);

	// ── Trash workflow (dialogs, loading, clear, hard delete) ────────────
	const {
		moveToTrashLoadingById,
		trashTaskCount,
		trashWarningState,
		hardDeleteDialogState,
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
	} = useTrashWorkflow({
		board,
		setBoard,
		selectedCard,
		selectedTaskId,
		setSelectedTaskId,
		setSessions,
		setIsClearTrashDialogOpen,
		stopTaskSession,
		cleanupTaskWorkspace,
		resumeTaskFromTrash,
		tryProgrammaticCardMove,
		requestMoveTaskToTrashWithAnimation,
		confirmMoveTaskToTrash,
	});

	// ── Drag and drop ────────────────────────────────────────────────────
	const { handleDragEnd } = useBoardDragHandler({
		board,
		setBoard,
		setSelectedTaskId,
		kickoffTaskInProgress,
		resumeTaskFromTrash,
		resolvePendingProgrammaticStartMove,
		consumeProgrammaticCardMove,
		requestMoveTaskToTrash,
		resolvePendingProgrammaticTrashMove,
	});

	// ── Session → column sync ────────────────────────────────────────────
	// Startup resume is handled server-side (triggered on first UI connection).
	useSessionColumnSync({
		board,
		setBoard,
		sessions,
		tryProgrammaticCardMove,
		programmaticCardMoveCycle,
	});

	// ── Auto-review actions ──────────────────────────────────────────────
	useReviewAutoActions({
		board,
		sessions,
		requestMoveTaskToTrash: requestMoveTaskToTrashWithAnimation,
		resetKey: currentProjectId,
	});

	// ── Remaining small handlers ─────────────────────────────────────────

	const handleCardSelect = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id === "trash") {
				return;
			}
			setSelectedTaskId(taskId);
			setIsGitHistoryOpen(false);
		},
		[board, setIsGitHistoryOpen, setSelectedTaskId],
	);

	const handleRestartTaskSession = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || (selection.column.id !== "in_progress" && selection.column.id !== "review")) {
				return;
			}
			const awaitReview = selection.column.id === "review";
			void (async () => {
				await stopTaskSession(taskId, { waitForExit: true });
				const started = await startTaskSession(selection.card, { resumeConversation: true, awaitReview });
				if (!started.ok) {
					notifyError(started.message ?? "Could not restart task session.");
				} else if (selection.card.useWorktree === false) {
					showNonIsolatedResumeWarning();
				}
			})();
		},
		[board, startTaskSession, stopTaskSession],
	);

	const handleCancelAutomaticTaskAction = useCallback(
		(taskId: string) => {
			setBoard((currentBoard) => {
				const selection = findCardSelection(currentBoard, taskId);
				if (!selection || selection.card.autoReviewEnabled !== true) {
					return currentBoard;
				}
				const updated = updateTask(currentBoard, taskId, {
					prompt: selection.card.prompt,
					startInPlanMode: selection.card.startInPlanMode,
					autoReviewEnabled: false,
					autoReviewMode: resolveTaskAutoReviewMode(selection.card.autoReviewMode),
					baseRef: selection.card.baseRef,
					useWorktree: selection.card.useWorktree,
				});
				return updated.updated ? updated.board : currentBoard;
			});
		},
		[setBoard],
	);

	// ── Reset on project change ──────────────────────────────────────────
	useEffect(() => {
		resetTrashWorkflowState();
		resetPendingStartMoves();
		resetProgrammaticCardMoves();
	}, [currentProjectId, resetPendingStartMoves, resetProgrammaticCardMoves, resetTrashWorkflowState]);

	return {
		handleProgrammaticCardMoveReady,
		confirmMoveTaskToTrash,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		handleRestoreTaskFromTrash,
		handleHardDeleteTrashTask,
		hardDeleteDialogState,
		handleCancelHardDelete,
		handleConfirmHardDelete,
		handleRestartTaskSession,
		handleCancelAutomaticTaskAction,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		moveToTrashLoadingById,
		trashTaskCount,
		trashWarningState,
		handleCancelTrashWarning,
		handleConfirmTrashWarning,
	};
}
