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
import { usePreferenceStorageEffect } from "@/hooks/settings/use-preference-storage-effect";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentId, RuntimeClaudeOptions, RuntimeCodexOptions, RuntimePiOptions } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import type { BoardCard, BoardData, TaskImage } from "@/types";
import { slugifyBranchName } from "@/utils/branch-utils";
import { normalizeTaskAgentId, resolveTaskCreateAgentId } from "@/utils/task-agent-display";

interface UseTaskEditorInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	currentProjectId: string | null;
	readOnly?: boolean;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	defaultTaskBranchRef: string;
	defaultUseWorktree?: boolean;
	folderOnly?: boolean;
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

export interface PreparedTaskCreation {
	task: BoardCard;
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
	newTaskCodexOptions: RuntimeCodexOptions | undefined;
	newTaskPiOptions: RuntimePiOptions | undefined;
	setNewTaskCodexOptions: Dispatch<SetStateAction<RuntimeCodexOptions | undefined>>;
	setNewTaskPiOptions: Dispatch<SetStateAction<RuntimePiOptions | undefined>>;
	newTaskClaudeOptions: RuntimeClaudeOptions | undefined;
	setNewTaskClaudeOptions: Dispatch<SetStateAction<RuntimeClaudeOptions | undefined>>;
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
	prepareCreateTaskForLifecycle: (options?: CreateTaskOptions) => PreparedTaskCreation | null;
	resetTaskEditorState: () => void;
}

export function useTaskEditor({
	board,
	setBoard,
	currentProjectId,
	readOnly = false,
	createTaskBranchOptions,
	defaultTaskBranchRef,
	defaultUseWorktree = true,
	folderOnly = false,
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
	const [newTaskCodexOptions, setNewTaskCodexOptions] = useState<RuntimeCodexOptions>();
	const [newTaskPiOptions, setNewTaskPiOptions] = useState<RuntimePiOptions>();
	const [newTaskClaudeOptions, setNewTaskClaudeOptions] = useState<RuntimeClaudeOptions>();
	const [draftUseWorktree, setNewTaskUseWorktree] = useState(!folderOnly && defaultUseWorktree);
	const newTaskUseWorktree = !folderOnly && draftUseWorktree;
	const [createFeatureBranch, setCreateFeatureBranch] = useState(false);
	const [branchName, setBranchName] = useState("");
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskBranchRef, setEditTaskBranchRef] = useState("");

	const resolvedDefaultTaskBranchRef = folderOnly ? "" : defaultTaskBranchRef;
	const resolvedDefaultUseWorktree = !folderOnly && defaultUseWorktree;
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

	usePreferenceStorageEffect(LocalStorageKey.TaskCreateLastAgentId, () => {
		inSessionRememberedTaskAgentIdRef.current = readRememberedTaskAgentId();
		if (!isInlineTaskCreateOpen) resetNewTaskAgentId(getDefaultTaskAgentId());
	});

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
		if (selection?.column.id !== "review" || !selection.card.unstarted) {
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
		if (readOnly || !prompt || !currentProjectId || isGeneratingBranchNameRef.current) {
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
	}, [currentProjectId, newTaskPrompt, readOnly]);

	const handleOpenCreateTask = useCallback(() => {
		if (readOnly) return;
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskImages([]);
		const resetCreateDraft = createResetTaskCreateDraft(
			resolvedDefaultTaskBranchRef,
			getDefaultTaskAgentId(),
			resolvedDefaultUseWorktree,
		);
		setNewTaskUseWorktree(resetCreateDraft.useWorktree);
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
		setNewTaskBranchRef(resetCreateDraft.branchRef);
		resetNewTaskAgentId(resetCreateDraft.agentId);
		setNewTaskCodexOptions(undefined);
		setNewTaskPiOptions(undefined);
		setNewTaskClaudeOptions(undefined);
		setIsInlineTaskCreateOpen(true);
	}, [getDefaultTaskAgentId, readOnly, resetNewTaskAgentId, resolvedDefaultTaskBranchRef, resolvedDefaultUseWorktree]);

	const handleCancelCreateTask = useCallback(() => {
		const resetCreateDraft = createResetTaskCreateDraft(
			resolvedDefaultTaskBranchRef,
			getDefaultTaskAgentId(),
			resolvedDefaultUseWorktree,
		);
		setNewTaskCodexOptions(undefined);
		setNewTaskPiOptions(undefined);
		setNewTaskClaudeOptions(undefined);
		setIsInlineTaskCreateOpen(false);
		setNewTaskPrompt(resetCreateDraft.prompt);
		setNewTaskImages(resetCreateDraft.images);
		resetNewTaskAgentId(resetCreateDraft.agentId);
		setNewTaskUseWorktree(resetCreateDraft.useWorktree);
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
		setNewTaskBranchRef(resetCreateDraft.branchRef);
	}, [getDefaultTaskAgentId, resetNewTaskAgentId, resolvedDefaultTaskBranchRef, resolvedDefaultUseWorktree]);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (readOnly) return;
			const selection = findCardSelection(board, task.id);
			if (selection?.column.id !== "review" || !selection.card.unstarted) return;
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setNewTaskCodexOptions(undefined);
			setNewTaskPiOptions(undefined);
			setNewTaskClaudeOptions(undefined);
			setIsInlineTaskCreateOpen(false);
			setNewTaskPrompt("");
			setNewTaskImages([]);
			const editDraft = createTaskEditDraft(task, resolvedDefaultTaskBranchRef);
			setEditingTaskId(editDraft.editingTaskId);
			setEditTaskPrompt(editDraft.prompt);
			setEditTaskImages(editDraft.images);
			setEditTaskBranchRef(editDraft.branchRef);
		},
		[board, readOnly, resolvedDefaultTaskBranchRef, setSelectedTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		const emptyEditDraft = createEmptyTaskEditDraft();
		setEditingTaskId(emptyEditDraft.editingTaskId);
		setEditTaskPrompt(emptyEditDraft.prompt);
		setEditTaskImages(emptyEditDraft.images);
		setEditTaskBranchRef(emptyEditDraft.branchRef);
	}, []);

	const handleSaveEditedTask = useCallback((): string | null => {
		if (readOnly) return null;
		const { board: nextBoard, savedTaskId } = saveEditedTaskToBoard({
			board,
			editingTaskId,
			prompt: editTaskPrompt,
			images: editTaskImages,
			branchRef: editTaskBranchRef,
			defaultBranchRef: resolvedDefaultTaskBranchRef,
			folderOnly,
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
		folderOnly,
		editTaskBranchRef,
		editTaskPrompt,
		editTaskImages,
		editingTaskId,
		readOnly,
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

	const resetCreateEditorAfterSubmit = useCallback(
		(options?: CreateTaskOptions) => {
			const resetCreateDraft = createResetTaskCreateDraft(
				resolvedDefaultTaskBranchRef,
				getDefaultTaskAgentId(),
				resolvedDefaultUseWorktree,
			);
			setNewTaskPrompt(resetCreateDraft.prompt);
			setNewTaskImages(resetCreateDraft.images);
			resetNewTaskAgentId(resetCreateDraft.agentId);
			setNewTaskUseWorktree(resetCreateDraft.useWorktree);
			setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
			setBranchName(resetCreateDraft.branchName);
			setNewTaskBranchRef(resetCreateDraft.branchRef);
			if (!options?.keepDialogOpen) {
				setNewTaskCodexOptions(undefined);
				setNewTaskPiOptions(undefined);
				setNewTaskClaudeOptions(undefined);
				setIsInlineTaskCreateOpen(false);
			}
		},
		[getDefaultTaskAgentId, resetNewTaskAgentId, resolvedDefaultTaskBranchRef, resolvedDefaultUseWorktree],
	);

	const handleCreateTask = useCallback(
		(options?: CreateTaskOptions): string | null => {
			if (readOnly) return null;
			const { board: nextBoard, createdTaskId } = createTaskOnBoard({
				board,
				prompt: newTaskPrompt,
				images: newTaskImages,
				agentId: newTaskAgentId,
				codexOptions: newTaskCodexOptions,
				piOptions: newTaskPiOptions,
				claudeOptions: newTaskClaudeOptions,
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
			resetCreateEditorAfterSubmit(options);
			return createdTaskId;
		},
		[
			board,
			branchName,
			createFeatureBranch,
			newTaskBranchRef,
			newTaskAgentId,
			newTaskCodexOptions,
			newTaskPiOptions,
			newTaskClaudeOptions,
			newTaskImages,
			newTaskPrompt,
			newTaskUseWorktree,
			readOnly,
			resetCreateEditorAfterSubmit,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const handleCreateTasks = useCallback(
		(prompts: string[], options?: CreateTaskOptions): string[] => {
			if (readOnly) return [];
			const { board: nextBoard, createdTaskIds } = createTasksOnBoard({
				board,
				prompts,
				images: newTaskImages,
				agentId: newTaskAgentId,
				codexOptions: newTaskCodexOptions,
				piOptions: newTaskPiOptions,
				claudeOptions: newTaskClaudeOptions,
				branchRef: newTaskBranchRef,
				defaultBranchRef: resolvedDefaultTaskBranchRef,
				useWorktree: newTaskUseWorktree,
			});
			if (createdTaskIds.length === 0) {
				return [];
			}
			setBoard(nextBoard);
			resetCreateEditorAfterSubmit(options);
			return createdTaskIds;
		},
		[
			board,
			newTaskAgentId,
			newTaskCodexOptions,
			newTaskPiOptions,
			newTaskClaudeOptions,
			newTaskBranchRef,
			newTaskImages,
			newTaskUseWorktree,
			readOnly,
			resetCreateEditorAfterSubmit,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const prepareCreateTaskForLifecycle = useCallback(
		(options?: CreateTaskOptions): PreparedTaskCreation | null => {
			if (readOnly) return null;
			const { createdTask } = createTaskOnBoard({
				board,
				prompt: newTaskPrompt,
				images: newTaskImages,
				agentId: newTaskAgentId,
				codexOptions: newTaskCodexOptions,
				piOptions: newTaskPiOptions,
				claudeOptions: newTaskClaudeOptions,
				branchRef: newTaskBranchRef,
				defaultBranchRef: resolvedDefaultTaskBranchRef,
				useWorktree: newTaskUseWorktree,
				branchName,
				createFeatureBranch,
			});
			if (!createdTask) {
				return null;
			}
			resetCreateEditorAfterSubmit(options);
			return { task: createdTask };
		},
		[
			board,
			branchName,
			createFeatureBranch,
			newTaskAgentId,
			newTaskCodexOptions,
			newTaskPiOptions,
			newTaskClaudeOptions,
			newTaskBranchRef,
			newTaskImages,
			newTaskPrompt,
			newTaskUseWorktree,
			readOnly,
			resetCreateEditorAfterSubmit,
			resolvedDefaultTaskBranchRef,
		],
	);

	const resetTaskEditorState = useCallback(() => {
		setNewTaskCodexOptions(undefined);
		setNewTaskPiOptions(undefined);
		setNewTaskClaudeOptions(undefined);
		setIsInlineTaskCreateOpen(false);
		const emptyEditDraft = createEmptyTaskEditDraft();
		const resetCreateDraft = createResetTaskCreateDraft(
			resolvedDefaultTaskBranchRef,
			getDefaultTaskAgentId(),
			resolvedDefaultUseWorktree,
		);
		setEditingTaskId(emptyEditDraft.editingTaskId);
		setEditTaskPrompt(emptyEditDraft.prompt);
		setEditTaskImages(emptyEditDraft.images);
		setEditTaskBranchRef(emptyEditDraft.branchRef);
		setNewTaskImages(resetCreateDraft.images);
		resetNewTaskAgentId(resetCreateDraft.agentId);
		setNewTaskUseWorktree(resetCreateDraft.useWorktree);
		setCreateFeatureBranch(resetCreateDraft.createFeatureBranch);
		setBranchName(resetCreateDraft.branchName);
	}, [getDefaultTaskAgentId, resetNewTaskAgentId, resolvedDefaultTaskBranchRef, resolvedDefaultUseWorktree]);

	return {
		isInlineTaskCreateOpen: !readOnly && isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskAgentId,
		setNewTaskAgentId,
		newTaskCodexOptions,
		newTaskPiOptions,
		newTaskClaudeOptions,
		setNewTaskCodexOptions,
		setNewTaskPiOptions,
		setNewTaskClaudeOptions,
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
		editingTaskId: readOnly ? null : editingTaskId,
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
		prepareCreateTaskForLifecycle,
		resetTaskEditorState,
	};
}
