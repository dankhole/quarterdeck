import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import type { TaskLifecycleCommandDraft } from "@/hooks/board/task-lifecycle-operations";
import type { PreparedTaskCreation } from "@/hooks/board/use-task-editor";
import type { UseTaskLifecycleOperationsResult } from "@/hooks/board/use-task-lifecycle-operations";
import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";

interface UseTaskStartActionsInput {
	board: BoardData;
	presentLifecycleBoard: Dispatch<SetStateAction<BoardData>>;
	prepareCreateTaskForLifecycle: (options?: { keepDialogOpen?: boolean }) => PreparedTaskCreation | null;
	prepareCreateTasksForLifecycle: (
		prompts: string[],
		options?: { keepDialogOpen?: boolean },
	) => PreparedTaskCreation[];
	executeTaskLifecycle: UseTaskLifecycleOperationsResult["executeTaskLifecycle"];
	handleStartTask: (taskId: string) => void;
	handleStartAllUnstartedTasks: (taskIds?: string[]) => void;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
}

export interface UseTaskStartActionsResult {
	handleCreateAndStartTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateAndStartTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	handleCreateStartAndOpenTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleStartTaskFromBoard: (taskId: string) => void;
	handleStartAllUnstartedTasksFromBoard: () => void;
}

export function getStartableUnstartedTaskIds(board: BoardData): string[] {
	const allUnstartedTasks = new Set<string>();
	const allInProgressTasks = new Set<string>();
	const startableTaskIds: string[] = [];

	const unstartedCards = board.columns
		.find((column) => column.id === "review")
		?.cards.filter((card) => card.unstarted);
	const inProgressTasks = board.columns.find((column) => column.id === "in_progress")?.cards;

	unstartedCards?.forEach((card) => {
		allUnstartedTasks.add(card.id);
	});
	inProgressTasks?.forEach((card) => {
		allInProgressTasks.add(card.id);
	});

	unstartedCards?.forEach((card) => {
		const dependency = board.dependencies.find((d) => d.fromTaskId === card.id);
		const isChildTaskUnstarted = dependency && allUnstartedTasks.has(dependency.toTaskId);
		const isChildTaskInProgress = dependency && allInProgressTasks.has(dependency.toTaskId);

		if (!isChildTaskUnstarted && !isChildTaskInProgress) {
			startableTaskIds.push(card.id);
		}
	});

	return startableTaskIds;
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
	board,
	presentLifecycleBoard,
	prepareCreateTaskForLifecycle,
	prepareCreateTasksForLifecycle,
	executeTaskLifecycle,
	handleStartTask,
	handleStartAllUnstartedTasks,
	setSelectedTaskId,
}: UseTaskStartActionsInput): UseTaskStartActionsResult {
	const startUnstartedTasks = useCallback(
		(taskIds: string[]) => {
			const unstartedTaskIds = [...new Set(taskIds.filter((taskId) => taskId.trim().length > 0))].filter(
				(taskId) => {
					const selection = findCardSelection(board, taskId);
					return selection?.column.id === "review" && selection.card.unstarted === true;
				},
			);

			if (unstartedTaskIds.length === 0) {
				return;
			}

			if (unstartedTaskIds.length === 1) {
				const firstTaskId = unstartedTaskIds[0];
				if (!firstTaskId) {
					return;
				}
				handleStartTask(firstTaskId);
				return;
			}
			handleStartAllUnstartedTasks(unstartedTaskIds);
		},
		[board, handleStartAllUnstartedTasks, handleStartTask],
	);

	const handleStartTaskFromBoard = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "review" || !selection.card.unstarted) {
				handleStartTask(taskId);
				return;
			}
			startUnstartedTasks([taskId]);
		},
		[board, handleStartTask, startUnstartedTasks],
	);

	const handleStartAllUnstartedTasksFromBoard = useCallback(() => {
		const unstartedTaskIds = getStartableUnstartedTaskIds(board);

		if (unstartedTaskIds.length === 0) {
			return;
		}
		startUnstartedTasks(unstartedTaskIds);
	}, [board, startUnstartedTasks]);

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

	const handleCreateAndStartTasks = useCallback(
		(prompts: string[], options?: { keepDialogOpen?: boolean }): string[] => {
			const prepared = prepareCreateTasksForLifecycle(prompts, options);
			if (prepared.length === 0) {
				return [];
			}
			void (async () => {
				// Each create-and-start consumes two durable board revisions. Run the
				// batch in order so every operation begins from the state returned by
				// the previous one instead of racing on a shared expected revision.
				for (const { task } of prepared) {
					presentLifecycleBoard((current) => presentCreatedTaskInProgress(current, task));
					await executeTaskLifecycle(createAndStartDraft(task));
				}
			})();
			return prepared.map(({ task }) => task.id);
		},
		[executeTaskLifecycle, prepareCreateTasksForLifecycle, presentLifecycleBoard],
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
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		handleStartAllUnstartedTasksFromBoard,
	};
}
