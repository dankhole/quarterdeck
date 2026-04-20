import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
	DEFAULT_PRIMARY_START_ACTION,
	normalizeStoredTaskCreateStartAction,
	parseListItems,
	type TaskCreateStartAction,
} from "@/components/task/task-create-dialog-utils";
import {
	getValidTaskPrompts,
	joinTaskPromptsForSingleMode,
	resolveEffectivePrimaryStartAction,
	resolveTaskCreateDialogCopy,
	resolveTaskCreateHotkeyAction,
	type TaskCreateMode,
} from "@/hooks/board/task-create-dialog";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { TaskImage } from "@/types";
import { useRawLocalStorageValue } from "@/utils/react-use";

interface CreateTaskOptions {
	keepDialogOpen?: boolean;
}

interface UseTaskCreateDialogInput {
	open: boolean;
	prompt: string;
	onPromptChange: (value: string) => void;
	onImagesChange: Dispatch<SetStateAction<TaskImage[]>>;
	onCreate: (options?: CreateTaskOptions) => string | null;
	onCreateAndStart?: (options?: CreateTaskOptions) => string | null;
	onCreateMultiple: (prompts: string[], options?: CreateTaskOptions) => string[];
	onCreateAndStartMultiple?: (prompts: string[], options?: CreateTaskOptions) => string[];
	onCreateStartAndOpen?: (options?: CreateTaskOptions) => string | null;
}

interface UseTaskCreateDialogResult {
	mode: TaskCreateMode;
	createMore: boolean;
	setCreateMore: Dispatch<SetStateAction<boolean>>;
	composerResetKey: number;
	taskPrompts: string[];
	setTaskPrompts: Dispatch<SetStateAction<string[]>>;
	detectedItems: string[];
	validTaskCount: number;
	dialogTitle: string;
	taskCountLabel: string;
	primaryStartAction: TaskCreateStartAction;
	primaryStartLabel: string;
	primaryStartIncludesShift: boolean;
	secondaryStartAction: TaskCreateStartAction;
	secondaryStartLabel: string;
	secondaryStartIncludesShift: boolean;
	handleSplitIntoTasks: () => void;
	handleBackToSingle: () => void;
	handleCreateSingle: () => void;
	handleRunSingleStartAction: (action: TaskCreateStartAction) => void;
	handleCreateAll: () => void;
	handleCreateAndStartAll: () => void;
}

export function useTaskCreateDialog({
	open,
	prompt,
	onPromptChange,
	onImagesChange,
	onCreate,
	onCreateAndStart,
	onCreateMultiple,
	onCreateAndStartMultiple,
	onCreateStartAndOpen,
}: UseTaskCreateDialogInput): UseTaskCreateDialogResult {
	const [mode, setMode] = useState<TaskCreateMode>("single");
	const [createMore, setCreateMore] = useState(false);
	const [composerResetKey, setComposerResetKey] = useState(0);
	const [taskPrompts, setTaskPrompts] = useState<string[]>([]);
	const [storedPrimaryStartAction, setStoredPrimaryStartAction] = useRawLocalStorageValue<TaskCreateStartAction>(
		LocalStorageKey.TaskCreatePrimaryStartAction,
		DEFAULT_PRIMARY_START_ACTION,
		normalizeStoredTaskCreateStartAction,
	);

	const detectedItems = useMemo(() => parseListItems(prompt), [prompt]);
	const validTaskPrompts = useMemo(() => getValidTaskPrompts(taskPrompts), [taskPrompts]);
	const validTaskCount = validTaskPrompts.length;
	const primaryStartAction = useMemo(
		() => resolveEffectivePrimaryStartAction(storedPrimaryStartAction, !!onCreateStartAndOpen),
		[onCreateStartAndOpen, storedPrimaryStartAction],
	);
	const dialogCopy = useMemo(
		() => resolveTaskCreateDialogCopy(mode, validTaskCount, primaryStartAction),
		[mode, primaryStartAction, validTaskCount],
	);

	useEffect(() => {
		if (!open) {
			setMode("single");
			setCreateMore(false);
			setComposerResetKey(0);
			setTaskPrompts([]);
		}
	}, [open]);

	const resetForCreateMore = useCallback(() => {
		onPromptChange("");
		onImagesChange([]);
		setMode("single");
		setTaskPrompts([]);
		setComposerResetKey((current) => current + 1);
	}, [onImagesChange, onPromptChange]);

	const resetAfterSuccessfulCreate = useCallback(
		(createdTaskCount: number) => {
			if (createMore && createdTaskCount > 0) {
				resetForCreateMore();
			}
		},
		[createMore, resetForCreateMore],
	);

	const handleSplitIntoTasks = useCallback(() => {
		setTaskPrompts(detectedItems);
		setMode("multi");
	}, [detectedItems]);

	const handleBackToSingle = useCallback(() => {
		onPromptChange(joinTaskPromptsForSingleMode(taskPrompts));
		setMode("single");
		setTaskPrompts([]);
	}, [onPromptChange, taskPrompts]);

	const handleCreateSingle = useCallback(() => {
		const createdTaskId = onCreate({ keepDialogOpen: createMore });
		resetAfterSuccessfulCreate(createdTaskId ? 1 : 0);
	}, [createMore, onCreate, resetAfterSuccessfulCreate]);

	const handleCreateAndStartSingle = useCallback(() => {
		const createdTaskId = onCreateAndStart?.({ keepDialogOpen: createMore });
		resetAfterSuccessfulCreate(createdTaskId ? 1 : 0);
	}, [createMore, onCreateAndStart, resetAfterSuccessfulCreate]);

	const handleCreateStartAndOpenSingle = useCallback(() => {
		const createdTaskId = onCreateStartAndOpen?.({ keepDialogOpen: createMore });
		resetAfterSuccessfulCreate(createdTaskId ? 1 : 0);
	}, [createMore, onCreateStartAndOpen, resetAfterSuccessfulCreate]);

	const handleRunSingleStartAction = useCallback(
		(action: TaskCreateStartAction) => {
			setStoredPrimaryStartAction(action);
			if (action === "start_and_open") {
				handleCreateStartAndOpenSingle();
				return;
			}
			handleCreateAndStartSingle();
		},
		[handleCreateAndStartSingle, handleCreateStartAndOpenSingle, setStoredPrimaryStartAction],
	);

	const handleCreateAll = useCallback(() => {
		if (validTaskPrompts.length === 0) {
			return;
		}
		const createdTaskIds = onCreateMultiple(validTaskPrompts, { keepDialogOpen: createMore });
		resetAfterSuccessfulCreate(createdTaskIds.length);
	}, [createMore, onCreateMultiple, resetAfterSuccessfulCreate, validTaskPrompts]);

	const handleCreateAndStartAll = useCallback(() => {
		if (validTaskPrompts.length === 0) {
			return;
		}
		const createdTaskIds = onCreateAndStartMultiple?.(validTaskPrompts, { keepDialogOpen: createMore }) ?? [];
		resetAfterSuccessfulCreate(createdTaskIds.length);
	}, [createMore, onCreateAndStartMultiple, resetAfterSuccessfulCreate, validTaskPrompts]);

	useHotkeys(
		"mod+enter, mod+shift+enter, mod+alt+enter",
		(event) => {
			switch (resolveTaskCreateHotkeyAction(mode, event)) {
				case "create_all":
					handleCreateAll();
					return;
				case "start_all":
					handleCreateAndStartAll();
					return;
				case "create_single":
					handleCreateSingle();
					return;
				case "start_and_open_single":
					handleRunSingleStartAction("start_and_open");
					return;
				case "start_single":
					handleRunSingleStartAction("start");
					return;
			}
		},
		{
			enabled: open,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			ignoreEventWhen: (event) => {
				if (!event.defaultPrevented) return false;
				const tag = (event.target as HTMLElement).tagName?.toLowerCase();
				return tag === "textarea" || tag === "input";
			},
			preventDefault: true,
		},
		[open, mode, handleCreateAll, handleCreateAndStartAll, handleCreateSingle, handleRunSingleStartAction],
	);

	return {
		mode,
		createMore,
		setCreateMore,
		composerResetKey,
		taskPrompts,
		setTaskPrompts,
		detectedItems,
		validTaskCount,
		dialogTitle: dialogCopy.dialogTitle,
		taskCountLabel: dialogCopy.taskCountLabel,
		primaryStartAction,
		primaryStartLabel: dialogCopy.primaryStartLabel,
		primaryStartIncludesShift: dialogCopy.primaryStartIncludesShift,
		secondaryStartAction: dialogCopy.secondaryStartAction,
		secondaryStartLabel: dialogCopy.secondaryStartLabel,
		secondaryStartIncludesShift: dialogCopy.secondaryStartIncludesShift,
		handleSplitIntoTasks,
		handleBackToSingle,
		handleCreateSingle,
		handleRunSingleStartAction,
		handleCreateAll,
		handleCreateAndStartAll,
	};
}
