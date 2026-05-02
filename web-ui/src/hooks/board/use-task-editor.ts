import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { isBranchRefValid } from "@/hooks/board/task-editor";
import {
	createEmptyTaskEditDraft,
	createResetTaskCreateDraft,
	createTaskEditDraft,
	createTaskOnBoard,
	createTasksOnBoard,
	saveEditedTaskToBoard,
} from "@/hooks/board/task-editor-drafts";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentId } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import type { BoardCard, BoardData, TaskImage } from "@/types";
import { slugifyBranchName } from "@/utils/branch-utils";
import { normalizeTaskAgentId, resolveTaskCreateAgentId } from "@/utils/task-agent-display";

interface UseTaskEditorInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	currentProjectId: string | null;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	defaultTaskBranchRef: string;
	fallbackTaskAgentId: RuntimeAgentId;
	availableTaskAgentIds?: readonly RuntimeAgentId[] | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	queueTaskStartAfterEdit?: (taskId: string) => void;
}

interface OpenEditTaskOptions {
	preserveDetailSelection?: boolean;
}

interface CreateTaskOptions {
	keepDialogOpen?: boolean;
}

function resolveTaskAgentStateAction(
	nextAgentId: SetStateAction<RuntimeAgentId>,
	currentAgentId: RuntimeAgentId,
): RuntimeAgentId {
	if (typeof nextAgentId === "function") {
		return (nextAgentId as (previousAgentId: RuntimeAgentId) => RuntimeAgentId)(currentAgentId);
	}
	return nextAgentId;
}

function readRememberedTaskAgentId(): RuntimeAgentId | null {
	const rawAgentId = readLocalStorageItem(LocalStorageKey.TaskCreateLastAgentId);
	return rawAgentId ? normalizeTaskAgentId(rawAgentId) : null;
}

function resolveRememberedTaskAgentId({
	inSessionAgentId,
	fallbackAgentId,
	availableAgentIds,
}: {
	inSessionAgentId?: RuntimeAgentId | null;
	fallbackAgentId: RuntimeAgentId;
	availableAgentIds?: readonly RuntimeAgentId[] | null;
}): RuntimeAgentId {
	return resolveTaskCreateAgentId({
		rememberedAgentId: inSessionAgentId ?? readRememberedTaskAgentId(),
		fallbackAgentId,
		availableAgentIds,
	});
}

export interface UseTaskEditorResult {
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	setNewTaskPrompt: Dispatch<SetStateAction<string>>;
	newTaskImages: TaskImage[];
	setNewTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	newTaskAgentId: RuntimeAgentId;
	setNewTaskAgentId: Dispatch<SetStateAction<RuntimeAgentId>>;
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
	fallbackTaskAgentId,
	availableTaskAgentIds,
	setSelectedTaskId,
	queueTaskStartAfterEdit,
}: UseTaskEditorInput): UseTaskEditorResult {
	const inSessionRememberedTaskAgentIdRef = useRef<RuntimeAgentId | null>(null);
	const getDefaultTaskAgentId = useCallback(
		() =>
			resolveRememberedTaskAgentId({
				inSessionAgentId: inSessionRememberedTaskAgentIdRef.current,
				fallbackAgentId: fallbackTaskAgentId,
				availableAgentIds: availableTaskAgentIds,
			}),
		[fallbackTaskAgentId, availableTaskAgentIds],
	);
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskImages, setNewTaskImages] = useState<TaskImage[]>([]);
	const [newTaskAgentId, setNewTaskAgentIdState] = useState<RuntimeAgentId>(() =>
		resolveRememberedTaskAgentId({
			fallbackAgentId: fallbackTaskAgentId,
			availableAgentIds: availableTaskAgentIds,
		}),
	);
	const [newTaskUseWorktree, setNewTaskUseWorktree] = useState(true);
	const [createFeatureBranch, setCreateFeatureBranch] = useState(false);
	const [branchName, setBranchName] = useState("");
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskBranchRef, setEditTaskBranchRef] = useState("");

	const resolvedDefaultTaskBranchRef = defaultTaskBranchRef;
	const newTaskAgentIdRef = useRef(newTaskAgentId);
	newTaskAgentIdRef.current = newTaskAgentId;

	const resetNewTaskAgentId = useCallback((agentId: RuntimeAgentId) => {
		newTaskAgentIdRef.current = agentId;
		setNewTaskAgentIdState(agentId);
	}, []);

	const setNewTaskAgentId = useCallback<Dispatch<SetStateAction<RuntimeAgentId>>>(
		(nextAgentId) => {
			const resolvedAgentId = resolveTaskAgentStateAction(nextAgentId, newTaskAgentIdRef.current);
			resetNewTaskAgentId(resolvedAgentId);
			inSessionRememberedTaskAgentIdRef.current = resolvedAgentId;
			writeLocalStorageItem(LocalStorageKey.TaskCreateLastAgentId, resolvedAgentId);
		},
		[resetNewTaskAgentId],
	);

	useEffect(() => {
		if (!isInlineTaskCreateOpen) {
			resetNewTaskAgentId(getDefaultTaskAgentId());
		}
	}, [getDefaultTaskAgentId, isInlineTaskCreateOpen, resetNewTaskAgentId]);

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
		const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef, getDefaultTaskAgentId());
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
		setNewTaskBranchRef(resetCreateDraft.branchRef);
		resetNewTaskAgentId(resetCreateDraft.agentId);
		setIsInlineTaskCreateOpen(true);
	}, [getDefaultTaskAgentId, resetNewTaskAgentId, resolvedDefaultTaskBranchRef]);

	const handleCancelCreateTask = useCallback(() => {
		const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef, getDefaultTaskAgentId());
		setIsInlineTaskCreateOpen(false);
		setNewTaskPrompt(resetCreateDraft.prompt);
		setNewTaskImages(resetCreateDraft.images);
		resetNewTaskAgentId(resetCreateDraft.agentId);
		setNewTaskUseWorktree(resetCreateDraft.useWorktree);
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
		setNewTaskBranchRef(resetCreateDraft.branchRef);
	}, [getDefaultTaskAgentId, resetNewTaskAgentId, resolvedDefaultTaskBranchRef]);

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
			setEditTaskBranchRef(editDraft.branchRef);
		},
		[resolvedDefaultTaskBranchRef, setSelectedTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		const emptyEditDraft = createEmptyTaskEditDraft();
		setEditingTaskId(emptyEditDraft.editingTaskId);
		setEditTaskPrompt(emptyEditDraft.prompt);
		setEditTaskImages(emptyEditDraft.images);
		setEditTaskBranchRef(emptyEditDraft.branchRef);
	}, []);

	const handleSaveEditedTask = useCallback((): string | null => {
		const { board: nextBoard, savedTaskId } = saveEditedTaskToBoard({
			board,
			editingTaskId,
			prompt: editTaskPrompt,
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
		setEditTaskImages(emptyEditDraft.images);
		setEditTaskBranchRef(emptyEditDraft.branchRef);
		return savedTaskId;
	}, [
		board,
		editTaskBranchRef,
		editTaskPrompt,
		editTaskImages,
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
				images: newTaskImages,
				agentId: newTaskAgentId,
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
			const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef, getDefaultTaskAgentId());
			setNewTaskPrompt(resetCreateDraft.prompt);
			setNewTaskImages(resetCreateDraft.images);
			resetNewTaskAgentId(resetCreateDraft.agentId);
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
			getDefaultTaskAgentId,
			newTaskBranchRef,
			newTaskAgentId,
			newTaskImages,
			newTaskPrompt,
			newTaskUseWorktree,
			resetNewTaskAgentId,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const handleCreateTasks = useCallback(
		(prompts: string[], options?: CreateTaskOptions): string[] => {
			const { board: nextBoard, createdTaskIds } = createTasksOnBoard({
				board,
				prompts,
				images: newTaskImages,
				agentId: newTaskAgentId,
				branchRef: newTaskBranchRef,
				defaultBranchRef: resolvedDefaultTaskBranchRef,
				useWorktree: newTaskUseWorktree,
			});
			if (createdTaskIds.length === 0) {
				return [];
			}
			setBoard(nextBoard);
			const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef, getDefaultTaskAgentId());
			setNewTaskPrompt(resetCreateDraft.prompt);
			setNewTaskImages(resetCreateDraft.images);
			resetNewTaskAgentId(resetCreateDraft.agentId);
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
			getDefaultTaskAgentId,
			newTaskAgentId,
			newTaskBranchRef,
			newTaskImages,
			newTaskUseWorktree,
			resetNewTaskAgentId,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const resetTaskEditorState = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		const emptyEditDraft = createEmptyTaskEditDraft();
		const resetCreateDraft = createResetTaskCreateDraft(resolvedDefaultTaskBranchRef, getDefaultTaskAgentId());
		setEditingTaskId(emptyEditDraft.editingTaskId);
		setEditTaskPrompt(emptyEditDraft.prompt);
		setEditTaskImages(emptyEditDraft.images);
		setEditTaskBranchRef(emptyEditDraft.branchRef);
		setNewTaskImages(resetCreateDraft.images);
		resetNewTaskAgentId(resetCreateDraft.agentId);
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
	}, [getDefaultTaskAgentId, resetNewTaskAgentId, resolvedDefaultTaskBranchRef]);

	return {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskAgentId,
		setNewTaskAgentId,
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
