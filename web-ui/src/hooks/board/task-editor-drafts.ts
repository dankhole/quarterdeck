import { isTaskSaveValid, resolveEffectiveBaseRef } from "@/hooks/board/task-editor";
import type { RuntimeAgentId } from "@/runtime/types";
import { addTaskToColumnWithResult, updateTask } from "@/state/board-state";
import type { BoardCard, BoardData, TaskImage } from "@/types";

export interface TaskCreateDraftReset {
	prompt: string;
	images: TaskImage[];
	useWorktree: boolean;
	createFeatureBranch: boolean;
	branchName: string;
	branchRef: string;
	agentId: RuntimeAgentId;
}

export interface TaskEditDraftState {
	editingTaskId: string | null;
	prompt: string;
	images: TaskImage[];
	branchRef: string;
}

export function createResetTaskCreateDraft(defaultBranchRef: string, agentId: RuntimeAgentId): TaskCreateDraftReset {
	return {
		prompt: "",
		images: [],
		useWorktree: true,
		createFeatureBranch: false,
		branchName: "",
		branchRef: defaultBranchRef,
		agentId,
	};
}

export function createEmptyTaskEditDraft(): TaskEditDraftState {
	return {
		editingTaskId: null,
		prompt: "",
		images: [],
		branchRef: "",
	};
}

export function createTaskEditDraft(task: BoardCard, defaultBranchRef: string): TaskEditDraftState {
	return {
		editingTaskId: task.id,
		prompt: task.prompt.trim(),
		images: task.images ? task.images.map((image) => ({ ...image })) : [],
		branchRef: task.baseRef || defaultBranchRef,
	};
}

export function saveEditedTaskToBoard({
	board,
	editingTaskId,
	prompt,
	images,
	branchRef,
	defaultBranchRef,
}: {
	board: BoardData;
	editingTaskId: string | null;
	prompt: string;
	images: TaskImage[];
	branchRef: string;
	defaultBranchRef: string;
}): { board: BoardData; savedTaskId: string | null } {
	if (!editingTaskId || !isTaskSaveValid(prompt, branchRef, defaultBranchRef)) {
		return { board, savedTaskId: null };
	}

	const trimmedPrompt = prompt.trim();
	const baseRef = resolveEffectiveBaseRef(branchRef, defaultBranchRef);
	const updated = updateTask(board, editingTaskId, {
		prompt: trimmedPrompt,
		images,
		baseRef,
	});

	return {
		board: updated.updated ? updated.board : board,
		savedTaskId: editingTaskId,
	};
}

export function createTaskOnBoard({
	board,
	prompt,
	images,
	branchRef,
	defaultBranchRef,
	useWorktree,
	branchName,
	createFeatureBranch,
	agentId,
}: {
	board: BoardData;
	prompt: string;
	images: TaskImage[];
	branchRef: string;
	defaultBranchRef: string;
	useWorktree: boolean;
	branchName: string;
	createFeatureBranch: boolean;
	agentId: RuntimeAgentId;
}): { board: BoardData; createdTaskId: string | null; baseRef: string } {
	if (!isTaskSaveValid(prompt, branchRef, defaultBranchRef)) {
		return { board, createdTaskId: null, baseRef: resolveEffectiveBaseRef(branchRef, defaultBranchRef) };
	}

	const trimmedPrompt = prompt.trim();
	const baseRef = resolveEffectiveBaseRef(branchRef, defaultBranchRef);
	const created = addTaskToColumnWithResult(board, "backlog", {
		prompt: trimmedPrompt,
		images,
		baseRef,
		agentId,
		useWorktree,
		branchName: createFeatureBranch && branchName ? branchName : undefined,
	});

	return {
		board: created.board,
		createdTaskId: created.task.id,
		baseRef,
	};
}

export function createTasksOnBoard({
	board,
	prompts,
	images,
	branchRef,
	defaultBranchRef,
	useWorktree,
	agentId,
}: {
	board: BoardData;
	prompts: string[];
	images: TaskImage[];
	branchRef: string;
	defaultBranchRef: string;
	useWorktree: boolean;
	agentId: RuntimeAgentId;
}): { board: BoardData; createdTaskIds: string[]; baseRef: string } {
	const validPrompts = prompts.map((prompt) => prompt.trim()).filter(Boolean);
	const baseRef = resolveEffectiveBaseRef(branchRef, defaultBranchRef);
	if (validPrompts.length === 0 || !baseRef) {
		return { board, createdTaskIds: [], baseRef };
	}

	let updatedBoard = board;
	const createdTaskIds: string[] = [];
	for (const prompt of validPrompts) {
		const created = addTaskToColumnWithResult(updatedBoard, "backlog", {
			prompt,
			images,
			baseRef,
			agentId,
			useWorktree,
		});
		updatedBoard = created.board;
		createdTaskIds.push(created.task.id);
	}

	return {
		board: updatedBoard,
		createdTaskIds,
		baseRef,
	};
}
