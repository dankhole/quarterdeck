import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import type { TaskLifecycleCommandDraft } from "@/hooks/board/task-lifecycle-operations";
import type { PreparedTaskCreation } from "@/hooks/board/use-task-editor";
import type { UseTaskLifecycleOperationsResult } from "@/hooks/board/use-task-lifecycle-operations";
import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";

interface UseTaskStartActionsInput {
	presentLifecycleBoard: Dispatch<SetStateAction<BoardData>>;
	prepareCreateTaskForLifecycle: (options?: { keepDialogOpen?: boolean }) => PreparedTaskCreation | null;
	executeTaskLifecycle: UseTaskLifecycleOperationsResult["executeTaskLifecycle"];
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
}

export interface UseTaskStartActionsResult {
	handleCreateAndStartTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateStartAndOpenTask: (options?: { keepDialogOpen?: boolean }) => string | null;
}

function presentCreatedTaskInProgress(board: BoardData, task: BoardCard): BoardData {
	if (findCardSelection(board, task.id)) {
		return board;
	}
	return {
		...board,
		columns: board.columns.map((column) =>
			column.id === "in_progress"
				? { ...column, cards: [{ ...task, unstarted: undefined }, ...column.cards] }
				: column,
		),
	};
}

function createAndStartDraft(task: BoardCard): Extract<TaskLifecycleCommandDraft, { kind: "create_and_start" }> {
	return {
		kind: "create_and_start",
		startedAt: task.createdAt,
		task: {
			taskId: task.id,
			title: task.title,
			prompt: task.prompt,
			images: task.images,
			baseRef: task.baseRef,
			agentId: task.agentId,
			codexOptions: task.codexOptions,
			useWorktree: task.useWorktree,
			branch: task.branch ?? undefined,
			pinned: task.pinned,
			createdAt: task.createdAt,
		},
	};
}

export function useTaskStartActions({
	presentLifecycleBoard,
	prepareCreateTaskForLifecycle,
	executeTaskLifecycle,
	setSelectedTaskId,
}: UseTaskStartActionsInput): UseTaskStartActionsResult {
	const handleCreateAndStartTask = useCallback(
		(options?: { keepDialogOpen?: boolean }): string | null => {
			const prepared = prepareCreateTaskForLifecycle(options);
			if (!prepared) {
				return null;
			}
			presentLifecycleBoard((current) => presentCreatedTaskInProgress(current, prepared.task));
			void executeTaskLifecycle(createAndStartDraft(prepared.task));
			return prepared.task.id;
		},
		[executeTaskLifecycle, prepareCreateTaskForLifecycle, presentLifecycleBoard],
	);

	const handleCreateStartAndOpenTask = useCallback(
		(options?: { keepDialogOpen?: boolean }): string | null => {
			const prepared = prepareCreateTaskForLifecycle(options);
			if (!prepared) {
				return null;
			}
			presentLifecycleBoard((current) => presentCreatedTaskInProgress(current, prepared.task));
			void executeTaskLifecycle(createAndStartDraft(prepared.task));
			if (!options?.keepDialogOpen) {
				setSelectedTaskId(prepared.task.id);
			}
			return prepared.task.id;
		},
		[executeTaskLifecycle, prepareCreateTaskForLifecycle, presentLifecycleBoard, setSelectedTaskId],
	);

	return {
		handleCreateAndStartTask,
		handleCreateStartAndOpenTask,
	};
}
