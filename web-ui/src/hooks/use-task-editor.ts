import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { addTaskToColumnWithResult, findCardSelection, updateTask } from "@/state/board-state";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import {
	normalizeStoredTaskAutoReviewMode,
	TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
	TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
	TASK_START_IN_PLAN_MODE_STORAGE_KEY,
} from "@/utils/app-utils";
import { slugifyBranchName } from "@/utils/branch-utils";
import { useBooleanLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

interface UseTaskEditorInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	currentProjectId: string | null;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	defaultTaskBranchRef: string;
	/** When true, the default base ref was set via config — overrides last-used-branch memory. */
	isConfigDefaultBaseRef?: boolean;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	queueTaskStartAfterEdit?: (taskId: string) => void;
}

interface OpenEditTaskOptions {
	preserveDetailSelection?: boolean;
}

interface CreateTaskOptions {
	keepDialogOpen?: boolean;
}

export interface UseTaskEditorResult {
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	setNewTaskPrompt: Dispatch<SetStateAction<string>>;
	newTaskImages: TaskImage[];
	setNewTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	newTaskStartInPlanMode: boolean;
	setNewTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewEnabled: boolean;
	setNewTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewMode: TaskAutoReviewMode;
	setNewTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	isNewTaskStartInPlanModeDisabled: boolean;
	newTaskUseWorktree: boolean;
	setNewTaskUseWorktree: Dispatch<SetStateAction<boolean>>;
	createFeatureBranch: boolean;
	setCreateFeatureBranch: Dispatch<SetStateAction<boolean>>;
	branchName: string;
	handleBranchNameEdit: (value: string) => void;
	generateBranchNameFromPrompt: () => Promise<void>;
	isGeneratingBranchName: boolean;
	newTaskBranchRef: string;
	setNewTaskBranchRef: Dispatch<SetStateAction<string>>;
	editingTaskId: string | null;
	editTaskPrompt: string;
	setEditTaskPrompt: Dispatch<SetStateAction<string>>;
	editTaskImages: TaskImage[];
	setEditTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	editTaskStartInPlanMode: boolean;
	setEditTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewEnabled: boolean;
	setEditTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewMode: TaskAutoReviewMode;
	setEditTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	isEditTaskStartInPlanModeDisabled: boolean;
	editTaskBranchRef: string;
	setEditTaskBranchRef: Dispatch<SetStateAction<string>>;
	handleOpenCreateTask: () => void;
	handleCancelCreateTask: () => void;
	handleOpenEditTask: (task: BoardCard, options?: OpenEditTaskOptions) => void;
	handleCancelEditTask: () => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	handleCreateTask: (options?: CreateTaskOptions) => string | null;
	handleCreateTasks: (prompts: string[], options?: CreateTaskOptions) => string[];
	resetTaskEditorState: () => void;
}

export function useTaskEditor({
	board,
	setBoard,
	currentProjectId,
	createTaskBranchOptions,
	defaultTaskBranchRef,
	isConfigDefaultBaseRef,
	setSelectedTaskId,
	queueTaskStartAfterEdit,
}: UseTaskEditorInput): UseTaskEditorResult {
	const configOverridesDefault = isConfigDefaultBaseRef === true;
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskImages, setNewTaskImages] = useState<TaskImage[]>([]);
	const [newTaskStartInPlanMode, setNewTaskStartInPlanMode] = useBooleanLocalStorageValue(
		TASK_START_IN_PLAN_MODE_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewEnabled, setNewTaskAutoReviewEnabled] = useBooleanLocalStorageValue(
		TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewMode, setNewTaskAutoReviewMode] = useRawLocalStorageValue<TaskAutoReviewMode>(
		TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
		"commit",
		normalizeStoredTaskAutoReviewMode,
	);
	const [newTaskUseWorktree, setNewTaskUseWorktree] = useState(true);
	const [createFeatureBranch, setCreateFeatureBranch] = useState(false);
	const [branchName, setBranchName] = useState("");
	const isNewTaskStartInPlanModeDisabled = newTaskAutoReviewEnabled && newTaskAutoReviewMode === "move_to_trash";
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [lastCreatedTaskBranchByProjectId, setLastCreatedTaskBranchByProjectId] = useState<Record<string, string>>({});
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskStartInPlanMode, setEditTaskStartInPlanMode] = useState(false);
	const [editTaskAutoReviewEnabled, setEditTaskAutoReviewEnabled] = useState(false);
	const [editTaskAutoReviewMode, setEditTaskAutoReviewMode] = useState<TaskAutoReviewMode>("commit");
	const isEditTaskStartInPlanModeDisabled = editTaskAutoReviewEnabled && editTaskAutoReviewMode === "move_to_trash";
	const [editTaskBranchRef, setEditTaskBranchRef] = useState("");

	const lastCreatedTaskBranchRef = useMemo(() => {
		if (!currentProjectId) {
			return null;
		}
		return lastCreatedTaskBranchByProjectId[currentProjectId] ?? null;
	}, [currentProjectId, lastCreatedTaskBranchByProjectId]);

	const resolvedDefaultTaskBranchRef = useMemo(() => {
		if (configOverridesDefault) {
			return defaultTaskBranchRef;
		}
		if (
			lastCreatedTaskBranchRef &&
			createTaskBranchOptions.some((option) => option.value === lastCreatedTaskBranchRef)
		) {
			return lastCreatedTaskBranchRef;
		}
		return defaultTaskBranchRef;
	}, [configOverridesDefault, createTaskBranchOptions, defaultTaskBranchRef, lastCreatedTaskBranchRef]);

	useEffect(() => {
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === newTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [createTaskBranchOptions, newTaskBranchRef, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!isInlineTaskCreateOpen) {
			return;
		}
		if (!newTaskBranchRef) {
			setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
		}
	}, [isInlineTaskCreateOpen, newTaskBranchRef, resolvedDefaultTaskBranchRef]);

	const [isGeneratingBranchName, setIsGeneratingBranchName] = useState(false);
	const isGeneratingBranchNameRef = useRef(false);

	// Clear feature branch state when worktree is disabled
	useEffect(() => {
		if (!newTaskUseWorktree && createFeatureBranch) {
			setCreateFeatureBranch(false);
			setBranchName("");
		}
	}, [newTaskUseWorktree, createFeatureBranch]);

	useEffect(() => {
		if (!isNewTaskStartInPlanModeDisabled || !newTaskStartInPlanMode) {
			return;
		}
		setNewTaskStartInPlanMode(false);
	}, [isNewTaskStartInPlanModeDisabled, newTaskStartInPlanMode, setNewTaskStartInPlanMode]);

	useEffect(() => {
		if (!isEditTaskStartInPlanModeDisabled || !editTaskStartInPlanMode) {
			return;
		}
		setEditTaskStartInPlanMode(false);
	}, [editTaskStartInPlanMode, isEditTaskStartInPlanModeDisabled]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === editTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setEditTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [createTaskBranchOptions, editTaskBranchRef, editingTaskId, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const selection = findCardSelection(board, editingTaskId);
		if (!selection || selection.column.id !== "backlog") {
			setEditingTaskId(null);
			setEditTaskPrompt("");
			setEditTaskStartInPlanMode(false);
			setEditTaskAutoReviewEnabled(false);
			setEditTaskAutoReviewMode("commit");
			setEditTaskImages([]);
			setEditTaskBranchRef("");
		}
	}, [board, editingTaskId]);

	const handleBranchNameEdit = useCallback((value: string) => {
		setBranchName(value);
	}, []);

	const generateBranchNameFromPrompt = useCallback(async () => {
		const prompt = newTaskPrompt.trim();
		if (!prompt || !currentProjectId || isGeneratingBranchNameRef.current) {
			return;
		}
		isGeneratingBranchNameRef.current = true;
		setIsGeneratingBranchName(true);
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const result = await trpcClient.workspace.generateBranchName.mutate({ prompt });
			if (result.ok && result.branchName) {
				setBranchName(slugifyBranchName(result.branchName));
			} else {
				showAppToast({ message: "Could not generate branch name", intent: "danger" });
			}
		} catch {
			showAppToast({ message: "Could not generate branch name", intent: "danger" });
		} finally {
			isGeneratingBranchNameRef.current = false;
			setIsGeneratingBranchName(false);
		}
	}, [currentProjectId, newTaskPrompt]);

	const handleOpenCreateTask = useCallback(() => {
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskImages([]);
		setCreateFeatureBranch(false);
		setBranchName("");
		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
		setIsInlineTaskCreateOpen(true);
	}, [resolvedDefaultTaskBranchRef]);

	const handleCancelCreateTask = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		setNewTaskPrompt("");
		setNewTaskImages([]);
		setNewTaskUseWorktree(true);
		setCreateFeatureBranch(false);
		setBranchName("");

		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [resolvedDefaultTaskBranchRef]);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setIsInlineTaskCreateOpen(false);
			setNewTaskPrompt("");
			setNewTaskImages([]);
			const taskPrompt = task.prompt.trim();
			setEditingTaskId(task.id);
			setEditTaskPrompt(taskPrompt);
			setEditTaskImages(task.images ? task.images.map((image) => ({ ...image })) : []);
			setEditTaskStartInPlanMode(task.startInPlanMode);
			setEditTaskAutoReviewEnabled(task.autoReviewEnabled === true);
			setEditTaskAutoReviewMode(resolveTaskAutoReviewMode(task.autoReviewMode));
			const fallbackBranch = task.baseRef || resolvedDefaultTaskBranchRef;
			setEditTaskBranchRef(fallbackBranch);
		},
		[resolvedDefaultTaskBranchRef, setSelectedTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
	}, []);

	const handleSaveEditedTask = useCallback((): string | null => {
		if (!editingTaskId) {
			return null;
		}
		const prompt = editTaskPrompt.trim();
		if (!prompt) {
			return null;
		}
		if (!(editTaskBranchRef || resolvedDefaultTaskBranchRef)) {
			return null;
		}

		const baseRef = editTaskBranchRef || resolvedDefaultTaskBranchRef;
		const savedTaskId = editingTaskId;

		setBoard((currentBoard) => {
			const updated = updateTask(currentBoard, savedTaskId, {
				prompt,
				startInPlanMode: editTaskStartInPlanMode,
				autoReviewEnabled: editTaskAutoReviewEnabled,
				autoReviewMode: editTaskAutoReviewMode,
				images: editTaskImages,
				baseRef,
			});
			return updated.updated ? updated.board : currentBoard;
		});
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		return savedTaskId;
	}, [
		editTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		editTaskBranchRef,
		editTaskPrompt,
		editTaskImages,
		editTaskStartInPlanMode,
		editingTaskId,
		resolvedDefaultTaskBranchRef,
		setBoard,
	]);

	const handleSaveAndStartEditedTask = useCallback(() => {
		const taskId = handleSaveEditedTask();
		if (!taskId) {
			return;
		}
		queueTaskStartAfterEdit?.(taskId);
	}, [handleSaveEditedTask, queueTaskStartAfterEdit]);

	const handleCreateTask = useCallback(
		(options?: CreateTaskOptions): string | null => {
			const prompt = newTaskPrompt.trim();
			if (!prompt) {
				return null;
			}
			if (!(newTaskBranchRef || resolvedDefaultTaskBranchRef)) {
				return null;
			}
			const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
			const created = addTaskToColumnWithResult(board, "backlog", {
				prompt,
				startInPlanMode: newTaskStartInPlanMode,
				autoReviewEnabled: newTaskAutoReviewEnabled,
				autoReviewMode: newTaskAutoReviewMode,
				images: newTaskImages,
				baseRef,
				useWorktree: newTaskUseWorktree,
				branchName: createFeatureBranch && branchName ? branchName : undefined,
			});
			setBoard(created.board);
			if (currentProjectId) {
				setLastCreatedTaskBranchByProjectId((current) => ({
					...current,
					[currentProjectId]: baseRef,
				}));
			}
			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskUseWorktree(true);
			setBranchName("");

			setNewTaskBranchRef(baseRef);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return created.task.id;
		},
		[
			board,
			branchName,
			createFeatureBranch,
			currentProjectId,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskBranchRef,
			newTaskImages,
			newTaskPrompt,
			newTaskStartInPlanMode,
			newTaskUseWorktree,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const handleCreateTasks = useCallback(
		(prompts: string[], options?: CreateTaskOptions): string[] => {
			const validPrompts = prompts.map((p) => p.trim()).filter(Boolean);
			if (validPrompts.length === 0) {
				return [];
			}
			if (!(newTaskBranchRef || resolvedDefaultTaskBranchRef)) {
				return [];
			}
			const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
			const createdTaskIds: string[] = [];
			let updatedBoard = board;
			for (const prompt of validPrompts) {
				const created = addTaskToColumnWithResult(updatedBoard, "backlog", {
					prompt,
					startInPlanMode: newTaskStartInPlanMode,
					autoReviewEnabled: newTaskAutoReviewEnabled,
					autoReviewMode: newTaskAutoReviewMode,
					images: newTaskImages,
					baseRef,
					useWorktree: newTaskUseWorktree,
				});
				updatedBoard = created.board;
				createdTaskIds.push(created.task.id);
			}
			setBoard(updatedBoard);
			if (currentProjectId) {
				setLastCreatedTaskBranchByProjectId((current) => ({
					...current,
					[currentProjectId]: baseRef,
				}));
			}
			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskUseWorktree(true);
			setNewTaskBranchRef(baseRef);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return createdTaskIds;
		},
		[
			board,
			currentProjectId,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskBranchRef,
			newTaskImages,
			newTaskStartInPlanMode,
			newTaskUseWorktree,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const resetTaskEditorState = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setNewTaskImages([]);
		setCreateFeatureBranch(false);
		setBranchName("");
	}, []);

	return {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		setNewTaskAutoReviewMode,
		isNewTaskStartInPlanModeDisabled,
		newTaskUseWorktree,
		setNewTaskUseWorktree,
		createFeatureBranch,
		setCreateFeatureBranch,
		branchName,
		handleBranchNameEdit,
		generateBranchNameFromPrompt,
		isGeneratingBranchName,
		newTaskBranchRef,
		setNewTaskBranchRef,
		editingTaskId,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAutoReviewEnabled,
		setEditTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		setEditTaskAutoReviewMode,
		isEditTaskStartInPlanModeDisabled,
		editTaskBranchRef,
		setEditTaskBranchRef,
		handleOpenCreateTask,
		handleCancelCreateTask,
		handleOpenEditTask,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
	};
}
