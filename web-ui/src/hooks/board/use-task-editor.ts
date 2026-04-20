import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { isBranchRefValid, isPlanModeDisabledByAutoReview } from "@/hooks/board/task-editor";
import {
	createEmptyTaskEditDraft,
	createResetTaskCreateDraft,
	createTaskEditDraft,
	createTaskOnBoard,
	createTasksOnBoard,
	saveEditedTaskToBoard,
} from "@/hooks/board/task-editor-drafts";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskImage } from "@/types";
import {
	normalizeStoredTaskAutoReviewMode,
	TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
	TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
} from "@/utils/app-utils";
import { slugifyBranchName } from "@/utils/branch-utils";
import { useBooleanLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

interface UseTaskEditorInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	currentProjectId: string | null;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	defaultTaskBranchRef: string;
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
	newTaskAutoReviewEnabled: boolean;
	setNewTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewMode: TaskAutoReviewMode;
	setNewTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
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
	setSelectedTaskId,
	queueTaskStartAfterEdit,
}: UseTaskEditorInput): UseTaskEditorResult {
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskImages, setNewTaskImages] = useState<TaskImage[]>([]);
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
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskStartInPlanMode, setEditTaskStartInPlanMode] = useState(false);
	const [editTaskAutoReviewEnabled, setEditTaskAutoReviewEnabled] = useState(false);
	const [editTaskAutoReviewMode, setEditTaskAutoReviewMode] = useState<TaskAutoReviewMode>("commit");
	const isEditTaskStartInPlanModeDisabled = isPlanModeDisabledByAutoReview(
		editTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
	);
	const [editTaskBranchRef, setEditTaskBranchRef] = useState("");

	const resolvedDefaultTaskBranchRef = defaultTaskBranchRef;

	useEffect(() => {
		if (isBranchRefValid(newTaskBranchRef, createTaskBranchOptions)) {
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
		if (!isEditTaskStartInPlanModeDisabled || !editTaskStartInPlanMode) {
			return;
		}
		setEditTaskStartInPlanMode(false);
	}, [editTaskStartInPlanMode, isEditTaskStartInPlanModeDisabled]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		if (isBranchRefValid(editTaskBranchRef, createTaskBranchOptions)) {
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
			const result = await trpcClient.project.generateBranchName.mutate({ prompt });
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
		const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef);
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
		setNewTaskBranchRef(resetCreateDraft.branchRef);
		setIsInlineTaskCreateOpen(true);
	}, [resolvedDefaultTaskBranchRef]);

	const handleCancelCreateTask = useCallback(() => {
		const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef);
		setIsInlineTaskCreateOpen(false);
		setNewTaskPrompt(resetCreateDraft.prompt);
		setNewTaskImages(resetCreateDraft.images);
		setNewTaskUseWorktree(resetCreateDraft.useWorktree);
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
		setNewTaskBranchRef(resetCreateDraft.branchRef);
	}, [resolvedDefaultTaskBranchRef]);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setIsInlineTaskCreateOpen(false);
			setNewTaskPrompt("");
			setNewTaskImages([]);
			const editDraft = createTaskEditDraft(task, resolvedDefaultTaskBranchRef);
			setEditingTaskId(editDraft.editingTaskId);
			setEditTaskPrompt(editDraft.prompt);
			setEditTaskImages(editDraft.images);
			setEditTaskStartInPlanMode(editDraft.startInPlanMode);
			setEditTaskAutoReviewEnabled(editDraft.autoReviewEnabled);
			setEditTaskAutoReviewMode(editDraft.autoReviewMode);
			setEditTaskBranchRef(editDraft.branchRef);
		},
		[resolvedDefaultTaskBranchRef, setSelectedTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		const emptyEditDraft = createEmptyTaskEditDraft();
		setEditingTaskId(emptyEditDraft.editingTaskId);
		setEditTaskPrompt(emptyEditDraft.prompt);
		setEditTaskStartInPlanMode(emptyEditDraft.startInPlanMode);
		setEditTaskAutoReviewEnabled(emptyEditDraft.autoReviewEnabled);
		setEditTaskAutoReviewMode(emptyEditDraft.autoReviewMode);
		setEditTaskImages(emptyEditDraft.images);
		setEditTaskBranchRef(emptyEditDraft.branchRef);
	}, []);

	const handleSaveEditedTask = useCallback((): string | null => {
		const { board: nextBoard, savedTaskId } = saveEditedTaskToBoard({
			board,
			editingTaskId,
			prompt: editTaskPrompt,
			startInPlanMode: editTaskStartInPlanMode,
			autoReviewEnabled: editTaskAutoReviewEnabled,
			autoReviewMode: editTaskAutoReviewMode,
			images: editTaskImages,
			branchRef: editTaskBranchRef,
			defaultBranchRef: resolvedDefaultTaskBranchRef,
		});
		if (!savedTaskId) {
			return null;
		}
		setBoard(nextBoard);
		const emptyEditDraft = createEmptyTaskEditDraft();
		setEditingTaskId(emptyEditDraft.editingTaskId);
		setEditTaskPrompt(emptyEditDraft.prompt);
		setEditTaskAutoReviewEnabled(emptyEditDraft.autoReviewEnabled);
		setEditTaskAutoReviewMode(emptyEditDraft.autoReviewMode);
		setEditTaskImages(emptyEditDraft.images);
		setEditTaskBranchRef(emptyEditDraft.branchRef);
		return savedTaskId;
	}, [
		board,
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
			const { board: nextBoard, createdTaskId } = createTaskOnBoard({
				board,
				prompt: newTaskPrompt,
				startInPlanMode: false,
				autoReviewEnabled: newTaskAutoReviewEnabled,
				autoReviewMode: newTaskAutoReviewMode,
				images: newTaskImages,
				branchRef: newTaskBranchRef,
				defaultBranchRef: resolvedDefaultTaskBranchRef,
				useWorktree: newTaskUseWorktree,
				branchName,
				createFeatureBranch,
			});
			if (!createdTaskId) {
				return null;
			}
			setBoard(nextBoard);
			const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef);
			setNewTaskPrompt(resetCreateDraft.prompt);
			setNewTaskImages(resetCreateDraft.images);
			setNewTaskUseWorktree(resetCreateDraft.useWorktree);
			setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
			setBranchName(resetCreateDraft.branchName);
			setNewTaskBranchRef(resetCreateDraft.branchRef);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return createdTaskId;
		},
		[
			board,
			branchName,
			createFeatureBranch,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskBranchRef,
			newTaskImages,
			newTaskPrompt,
			newTaskUseWorktree,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const handleCreateTasks = useCallback(
		(prompts: string[], options?: CreateTaskOptions): string[] => {
			const { board: nextBoard, createdTaskIds } = createTasksOnBoard({
				board,
				prompts,
				startInPlanMode: false,
				autoReviewEnabled: newTaskAutoReviewEnabled,
				autoReviewMode: newTaskAutoReviewMode,
				images: newTaskImages,
				branchRef: newTaskBranchRef,
				defaultBranchRef: resolvedDefaultTaskBranchRef,
				useWorktree: newTaskUseWorktree,
			});
			if (createdTaskIds.length === 0) {
				return [];
			}
			setBoard(nextBoard);
			const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef);
			setNewTaskPrompt(resetCreateDraft.prompt);
			setNewTaskImages(resetCreateDraft.images);
			setNewTaskUseWorktree(resetCreateDraft.useWorktree);
			setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
			setBranchName(resetCreateDraft.branchName);
			setNewTaskBranchRef(resetCreateDraft.branchRef);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return createdTaskIds;
		},
		[
			board,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskBranchRef,
			newTaskImages,
			newTaskUseWorktree,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const resetTaskEditorState = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		const emptyEditDraft = createEmptyTaskEditDraft();
		const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef);
		setEditingTaskId(emptyEditDraft.editingTaskId);
		setEditTaskPrompt(emptyEditDraft.prompt);
		setEditTaskStartInPlanMode(emptyEditDraft.startInPlanMode);
		setEditTaskAutoReviewEnabled(emptyEditDraft.autoReviewEnabled);
		setEditTaskAutoReviewMode(emptyEditDraft.autoReviewMode);
		setEditTaskImages(emptyEditDraft.images);
		setEditTaskBranchRef(emptyEditDraft.branchRef);
		setNewTaskImages(resetCreateDraft.images);
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
	}, [resolvedDefaultTaskBranchRef]);

	return {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		setNewTaskAutoReviewMode,
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
