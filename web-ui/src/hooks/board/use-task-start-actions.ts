import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import type { TaskLifecycleCommandDraft } from "@/hooks/board/task-lifecycle-operations";
import type { PreparedTaskCreation } from "@/hooks/board/use-task-editor";
import type { UseTaskLifecycleOperationsResult } from "@/hooks/board/use-task-lifecycle-operations";
import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";

interface UseTaskStartActionsInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	prepareCreateTaskForLifecycle: (options?: { keepDialogOpen?: boolean }) => PreparedTaskCreation | null;
	prepareCreateTasksForLifecycle: (
		prompts: string[],
		options?: { keepDialogOpen?: boolean },
	) => PreparedTaskCreation[];
	executeTaskLifecycle: UseTaskLifecycleOperationsResult["executeTaskLifecycle"];
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
}

export interface UseTaskStartActionsResult {
	handleCreateAndStartTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateAndStartTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	handleCreateStartAndOpenTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleStartTaskFromBoard: (taskId: string) => void;
	handleStartAllBacklogTasksFromBoard: () => void;
}

export function getStartableBacklogTaskIds(board: BoardData): string[] {
	const allBacklogTasks = new Set<string>();
	const allInProgressTasks = new Set<string>();
	const startableTaskIds: string[] = [];

	const backlogCards = board.columns.find((column) => column.id === "backlog")?.cards;
	const inProgressTasks = board.columns.find((column) => column.id === "in_progress")?.cards;

	backlogCards?.forEach((card) => {
		allBacklogTasks.add(card.id);
	});
	inProgressTasks?.forEach((card) => {
		allInProgressTasks.add(card.id);
	});

	backlogCards?.forEach((card) => {
		const dependency = board.dependencies.find((d) => d.fromTaskId === card.id);
		const isChildTaskInBacklog = dependency && allBacklogTasks.has(dependency.toTaskId);
		const isChildTaskInProgress = dependency && allInProgressTasks.has(dependency.toTaskId);

		if (!isChildTaskInBacklog && !isChildTaskInProgress) {
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
			column.id === "in_progress" ? { ...column, cards: [task, ...column.cards] } : column,
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
			agentId: task.agentId === "claude" || task.agentId === "codex" ? task.agentId : undefined,
			useWorktree: task.useWorktree,
			branch: task.branch ?? undefined,
			pinned: task.pinned,
			createdAt: task.createdAt,
		},
	};
}

export function useTaskStartActions({
	board,
	setBoard,
	prepareCreateTaskForLifecycle,
	prepareCreateTasksForLifecycle,
	executeTaskLifecycle,
	handleStartTask,
	handleStartAllBacklogTasks,
	setSelectedTaskId,
}: UseTaskStartActionsInput): UseTaskStartActionsResult {
	const startBacklogTasks = useCallback(
		(taskIds: string[]) => {
			const backlogTaskIds = [...new Set(taskIds.filter((taskId) => taskId.trim().length > 0))].filter((taskId) => {
				const selection = findCardSelection(board, taskId);
				return selection?.column.id === "backlog";
			});

			if (backlogTaskIds.length === 0) {
				return;
			}

			if (backlogTaskIds.length === 1) {
				const firstTaskId = backlogTaskIds[0];
				if (!firstTaskId) {
					return;
				}
				handleStartTask(firstTaskId);
				return;
			}
			handleStartAllBacklogTasks(backlogTaskIds);
		},
		[board, handleStartAllBacklogTasks, handleStartTask],
	);

	const handleStartTaskFromBoard = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				handleStartTask(taskId);
				return;
			}
			startBacklogTasks([taskId]);
		},
		[board, handleStartTask, startBacklogTasks],
	);

	const handleStartAllBacklogTasksFromBoard = useCallback(() => {
		const backlogTaskIds = getStartableBacklogTaskIds(board);

		if (backlogTaskIds.length === 0) {
			return;
		}
		startBacklogTasks(backlogTaskIds);
	}, [board, startBacklogTasks]);

	const handleCreateAndStartTask = useCallback(
		(options?: { keepDialogOpen?: boolean }): string | null => {
			const prepared = prepareCreateTaskForLifecycle(options);
			if (!prepared) {
				return null;
			}
			setBoard((current) => presentCreatedTaskInProgress(current, prepared.task));
			void executeTaskLifecycle(createAndStartDraft(prepared.task));
			return prepared.task.id;
		},
		[executeTaskLifecycle, prepareCreateTaskForLifecycle, setBoard],
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
					setBoard((current) => presentCreatedTaskInProgress(current, task));
					await executeTaskLifecycle(createAndStartDraft(task));
				}
			})();
			return prepared.map(({ task }) => task.id);
		},
		[executeTaskLifecycle, prepareCreateTasksForLifecycle, setBoard],
	);

	const handleCreateStartAndOpenTask = useCallback(
		(options?: { keepDialogOpen?: boolean }): string | null => {
			const prepared = prepareCreateTaskForLifecycle(options);
			if (!prepared) {
				return null;
			}
			setBoard((current) => presentCreatedTaskInProgress(current, prepared.task));
			void executeTaskLifecycle(createAndStartDraft(prepared.task));
			if (!options?.keepDialogOpen) {
				setSelectedTaskId(prepared.task.id);
			}
			return prepared.task.id;
		},
		[executeTaskLifecycle, prepareCreateTaskForLifecycle, setBoard, setSelectedTaskId],
	);

	return {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		handleStartAllBacklogTasksFromBoard,
	};
}
