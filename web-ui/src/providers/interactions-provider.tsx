import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import {
	type UseBoardInteractionsResult,
	type UseTaskStartActionsResult,
	useBoardInteractions,
	useTaskStartActions,
} from "@/hooks/board";
import { useBoardContext } from "@/providers/board-provider";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import { useTaskEditorContext } from "@/providers/task-editor-provider";
import { findCardSelection } from "@/state/board-state";

// ---------------------------------------------------------------------------
// Context value — board interactions: drag/drop, trash workflow, task
// lifecycle (start/stop/restart), task start actions, and clear-trash
// dialog state.
//
// The value is constructed in <InteractionsProvider> and provided via
// <InteractionsContext.Provider>. Child components read interaction state
// via useInteractionsContext() without prop drilling.
// ---------------------------------------------------------------------------

export interface InteractionsContextValue {
	// --- useBoardInteractions ---
	handleProgrammaticCardMoveReady: UseBoardInteractionsResult["handleProgrammaticCardMoveReady"];
	handleCreateDependency: UseBoardInteractionsResult["handleCreateDependency"];
	handleDeleteDependency: UseBoardInteractionsResult["handleDeleteDependency"];
	handleDragEnd: UseBoardInteractionsResult["handleDragEnd"];
	handleStartTask: UseBoardInteractionsResult["handleStartTask"];
	handleStartAllBacklogTasks: UseBoardInteractionsResult["handleStartAllBacklogTasks"];
	handleCardSelect: UseBoardInteractionsResult["handleCardSelect"];
	handleMoveReviewCardToTrash: UseBoardInteractionsResult["handleMoveReviewCardToTrash"];
	handleRestoreTaskFromTrash: UseBoardInteractionsResult["handleRestoreTaskFromTrash"];
	handleHardDeleteTrashTask: UseBoardInteractionsResult["handleHardDeleteTrashTask"];
	hardDeleteDialogState: UseBoardInteractionsResult["hardDeleteDialogState"];
	handleCancelHardDelete: UseBoardInteractionsResult["handleCancelHardDelete"];
	handleConfirmHardDelete: UseBoardInteractionsResult["handleConfirmHardDelete"];
	handleRestartTaskSession: UseBoardInteractionsResult["handleRestartTaskSession"];
	handleOpenClearTrash: UseBoardInteractionsResult["handleOpenClearTrash"];
	handleConfirmClearTrash: UseBoardInteractionsResult["handleConfirmClearTrash"];
	moveToTrashLoadingById: UseBoardInteractionsResult["moveToTrashLoadingById"];
	trashTaskCount: UseBoardInteractionsResult["trashTaskCount"];
	trashWarningState: UseBoardInteractionsResult["trashWarningState"];
	handleCancelTrashWarning: UseBoardInteractionsResult["handleCancelTrashWarning"];
	handleConfirmTrashWarning: UseBoardInteractionsResult["handleConfirmTrashWarning"];

	// --- useTaskStartActions ---
	handleCreateAndStartTask: UseTaskStartActionsResult["handleCreateAndStartTask"];
	handleCreateAndStartTasks: UseTaskStartActionsResult["handleCreateAndStartTasks"];
	handleCreateStartAndOpenTask: UseTaskStartActionsResult["handleCreateStartAndOpenTask"];
	handleStartTaskFromBoard: UseTaskStartActionsResult["handleStartTaskFromBoard"];
	handleStartAllBacklogTasksFromBoard: UseTaskStartActionsResult["handleStartAllBacklogTasksFromBoard"];

	// --- Clear-trash dialog state (consumed by DialogProvider) ---
	isClearTrashDialogOpen: boolean;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
}

export const InteractionsContext = createContext<InteractionsContextValue | null>(null);

export function useInteractionsContext(): InteractionsContextValue {
	const ctx = useContext(InteractionsContext);
	if (!ctx) {
		throw new Error("useInteractionsContext must be used within an InteractionsContext.Provider");
	}
	return ctx;
}

// ---------------------------------------------------------------------------
// Provider component — calls useBoardInteractions, useTaskStartActions, and
// owns the clear-trash dialog state. Reads board/session data from
// BoardContext and project-level inputs from ProjectContext.
//
// Must render inside BoardContext.Provider and ProjectContext.Provider.
// Must render above DialogProvider (which reads isClearTrashDialogOpen).
// ---------------------------------------------------------------------------

export interface InteractionsProviderProps {
	children: ReactNode;
}

export function InteractionsProvider({ children }: InteractionsProviderProps): ReactNode {
	const {
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard,
		selectedTaskId,
		setSelectedTaskId,
		stopTaskSession,
		ensureTaskWorktree,
		startTaskSession,
		fetchTaskWorktreeInfo,
		cleanupTaskWorktree,
	} = useBoardContext();
	const { taskEditor, pendingTaskStartAfterEditId, clearPendingTaskStartAfterEditId } = useTaskEditorContext();
	const { handleCreateTask, handleCreateTasks } = taskEditor;

	const { currentProjectId } = useProjectContext();
	const { showTrashWorktreeNotice, saveTrashWorktreeNoticeDismissed } = useProjectRuntimeContext();
	const { closeGitHistory } = useSurfaceNavigationContext();

	const [isClearTrashDialogOpen, setIsClearTrashDialogOpen] = useState(false);

	const {
		handleProgrammaticCardMoveReady,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleCardSelect,
		handleMoveReviewCardToTrash,
		handleRestoreTaskFromTrash,
		handleHardDeleteTrashTask,
		hardDeleteDialogState,
		handleCancelHardDelete,
		handleConfirmHardDelete,
		handleRestartTaskSession,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		moveToTrashLoadingById,
		trashTaskCount,
		trashWarningState,
		handleCancelTrashWarning,
		handleConfirmTrashWarning,
	} = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard,
		selectedTaskId,
		currentProjectId,
		setSelectedTaskId,
		setIsClearTrashDialogOpen,
		closeGitHistory,
		stopTaskSession,
		cleanupTaskWorktree,
		ensureTaskWorktree,
		startTaskSession,
		fetchTaskWorktreeInfo,
		showTrashWorktreeNotice,
		saveTrashWorktreeNoticeDismissed,
	});

	const {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		handleStartAllBacklogTasksFromBoard,
	} = useTaskStartActions({
		board,
		handleCreateTask,
		handleCreateTasks,
		handleStartTask,
		handleStartAllBacklogTasks,
		setSelectedTaskId,
	});

	const pendingEditedTaskColumnId = useMemo(() => {
		if (!pendingTaskStartAfterEditId) {
			return null;
		}
		return findCardSelection(board, pendingTaskStartAfterEditId)?.column.id ?? null;
	}, [board, pendingTaskStartAfterEditId]);

	useEffect(() => {
		if (!pendingTaskStartAfterEditId || pendingEditedTaskColumnId !== "backlog") {
			return;
		}
		handleStartTask(pendingTaskStartAfterEditId);
		clearPendingTaskStartAfterEditId();
	}, [clearPendingTaskStartAfterEditId, handleStartTask, pendingEditedTaskColumnId, pendingTaskStartAfterEditId]);

	const value = useMemo<InteractionsContextValue>(
		() => ({
			handleProgrammaticCardMoveReady,
			handleCreateDependency,
			handleDeleteDependency,
			handleDragEnd,
			handleStartTask,
			handleStartAllBacklogTasks,
			handleCardSelect,
			handleMoveReviewCardToTrash,
			handleRestoreTaskFromTrash,
			handleHardDeleteTrashTask,
			hardDeleteDialogState,
			handleCancelHardDelete,
			handleConfirmHardDelete,
			handleRestartTaskSession,
			handleOpenClearTrash,
			handleConfirmClearTrash,
			moveToTrashLoadingById,
			trashTaskCount,
			trashWarningState,
			handleCancelTrashWarning,
			handleConfirmTrashWarning,
			handleCreateAndStartTask,
			handleCreateAndStartTasks,
			handleCreateStartAndOpenTask,
			handleStartTaskFromBoard,
			handleStartAllBacklogTasksFromBoard,
			isClearTrashDialogOpen,
			setIsClearTrashDialogOpen,
		}),
		[
			handleProgrammaticCardMoveReady,
			handleCreateDependency,
			handleDeleteDependency,
			handleDragEnd,
			handleStartTask,
			handleStartAllBacklogTasks,
			handleCardSelect,
			handleMoveReviewCardToTrash,
			handleRestoreTaskFromTrash,
			handleHardDeleteTrashTask,
			hardDeleteDialogState,
			handleCancelHardDelete,
			handleConfirmHardDelete,
			handleRestartTaskSession,
			handleOpenClearTrash,
			handleConfirmClearTrash,
			moveToTrashLoadingById,
			trashTaskCount,
			trashWarningState,
			handleCancelTrashWarning,
			handleConfirmTrashWarning,
			handleCreateAndStartTask,
			handleCreateAndStartTasks,
			handleCreateStartAndOpenTask,
			handleStartTaskFromBoard,
			handleStartAllBacklogTasksFromBoard,
			isClearTrashDialogOpen,
		],
	);

	return <InteractionsContext.Provider value={value}>{children}</InteractionsContext.Provider>;
}
