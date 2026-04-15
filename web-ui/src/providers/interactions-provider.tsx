import { createContext, useContext } from "react";

import type { UseBoardInteractionsResult } from "@/hooks/use-board-interactions";
import type { UseTaskStartActionsResult } from "@/hooks/use-task-start-actions";

// ---------------------------------------------------------------------------
// Context value — board interactions: drag/drop, trash workflow, task
// lifecycle (start/stop/restart), and task start actions.
//
// The value is constructed in App.tsx and provided inline via
// <InteractionsContext.Provider>. This file owns the context shape and
// consumer hook so child components can read interaction state without
// prop drilling.
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
	handleCancelAutomaticTaskAction: UseBoardInteractionsResult["handleCancelAutomaticTaskAction"];
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
}

export const InteractionsContext = createContext<InteractionsContextValue | null>(null);

export function useInteractionsContext(): InteractionsContextValue {
	const ctx = useContext(InteractionsContext);
	if (!ctx) {
		throw new Error("useInteractionsContext must be used within an InteractionsContext.Provider");
	}
	return ctx;
}
