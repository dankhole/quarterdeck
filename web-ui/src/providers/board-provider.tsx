import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo } from "react";

import { useDetailTaskNavigation } from "@/hooks/use-detail-task-navigation";
import { useTaskBranchOptions } from "@/hooks/use-task-branch-options";
import { type UseTaskEditorResult, useTaskEditor } from "@/hooks/use-task-editor";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { useProjectContext } from "@/providers/project-provider";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { reconcileTaskWorkingDirectory } from "@/state/board-state";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardData, CardSelection } from "@/types";

// ---------------------------------------------------------------------------
// Context value — board data, task sessions, task selection, task editor,
// branch options, and derived loading flags.
// ---------------------------------------------------------------------------

export interface BoardContextValue {
	// --- Board data ---
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;

	// --- Task sessions ---
	sessions: Record<string, RuntimeTaskSessionSummary>;
	upsertSession: (summary: RuntimeTaskSessionSummary) => void;

	// --- Task selection ---
	selectedTaskId: string | null;
	selectedCard: CardSelection | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;

	// --- Task session actions ---
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	ensureTaskWorkspace: ReturnType<typeof useTaskSessions>["ensureTaskWorkspace"];
	startTaskSession: ReturnType<typeof useTaskSessions>["startTaskSession"];
	cleanupTaskWorkspace: ReturnType<typeof useTaskSessions>["cleanupTaskWorkspace"];
	fetchTaskWorkspaceInfo: ReturnType<typeof useTaskSessions>["fetchTaskWorkspaceInfo"];
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	stopTaskSession: (taskId: string, options?: { waitForExit?: boolean }) => Promise<void>;

	// --- Task editor ---
	taskEditor: UseTaskEditorResult;
	handleCreateTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	handleCancelCreateTask: () => void;

	// --- Task branch options ---
	createTaskBranchOptions: Array<{ value: string; label: string }>;

	// --- Derived loading flags ---
	isInitialRuntimeLoad: boolean;
	isAwaitingWorkspaceSnapshot: boolean;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoardContext(): BoardContextValue {
	const ctx = useContext(BoardContext);
	if (!ctx) {
		throw new Error("useBoardContext must be used within a BoardContext.Provider");
	}
	return ctx;
}

// ---------------------------------------------------------------------------
// BoardProvider — runs board-scoped hooks (task navigation, task sessions,
// task editor, branch options) and provides BoardContext.
// ---------------------------------------------------------------------------

interface BoardProviderProps {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	setPendingTaskStartAfterEditId: Dispatch<SetStateAction<string | null>>;
	taskEditorResetRef: React.MutableRefObject<() => void>;
	children: ReactNode;
}

export function BoardProvider({
	board,
	setBoard,
	sessions,
	setSessions,
	setPendingTaskStartAfterEditId,
	taskEditorResetRef,
	children,
}: BoardProviderProps): ReactNode {
	const {
		currentProjectId,
		projects,
		streamedWorkspaceState,
		hasReceivedSnapshot,
		streamError,
		configDefaultBaseRef,
		workspacePath,
		workspaceGit,
	} = useProjectContext();

	// --- useDetailTaskNavigation ---
	const { selectedTaskId, selectedCard, setSelectedTaskId } = useDetailTaskNavigation({
		board,
		currentProjectId,
		isBoardHydrated: hasReceivedSnapshot,
	});

	// --- Derived loading flags ---
	const isInitialRuntimeLoad =
		!hasReceivedSnapshot && currentProjectId === null && projects.length === 0 && !streamError;
	const isAwaitingWorkspaceSnapshot = currentProjectId !== null && streamedWorkspaceState === null;

	// --- useTaskSessions ---
	const {
		upsertSession,
		ensureTaskWorkspace,
		startTaskSession,
		stopTaskSession,
		sendTaskSessionInput,
		cleanupTaskWorkspace,
		fetchTaskWorkspaceInfo,
	} = useTaskSessions({
		currentProjectId,
		setSessions,
		onWorkingDirectoryResolved: (taskId, workingDirectory) => {
			setBoard((current) => {
				const result = reconcileTaskWorkingDirectory(current, taskId, workingDirectory, workspacePath);
				return result.updated ? result.board : current;
			});
		},
	});

	// --- useTaskBranchOptions ---
	const { createTaskBranchOptions, defaultTaskBranchRef, isConfigDefaultBaseRef } = useTaskBranchOptions({
		workspaceGit,
		configDefaultBaseRef,
	});

	// --- queueTaskStartAfterEdit ---
	const queueTaskStartAfterEdit = useCallback(
		(taskId: string) => {
			setPendingTaskStartAfterEditId(taskId);
		},
		[setPendingTaskStartAfterEditId],
	);

	// --- useTaskEditor ---
	const taskEditor = useTaskEditor({
		board,
		setBoard,
		currentProjectId,
		createTaskBranchOptions,
		defaultTaskBranchRef,
		isConfigDefaultBaseRef,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});
	const { handleCreateTask, handleCreateTasks, resetTaskEditorState, handleCancelCreateTask } = taskEditor;

	// --- taskEditorResetRef sync ---
	useEffect(() => {
		taskEditorResetRef.current = resetTaskEditorState;
	}, [resetTaskEditorState]);

	// --- Context value ---
	const value = useMemo<BoardContextValue>(
		() => ({
			board,
			setBoard,
			sessions,
			upsertSession,
			selectedTaskId,
			selectedCard,
			setSelectedTaskId,
			setSessions,
			ensureTaskWorkspace,
			startTaskSession,
			cleanupTaskWorkspace,
			fetchTaskWorkspaceInfo,
			sendTaskSessionInput,
			stopTaskSession,
			taskEditor,
			handleCreateTask,
			handleCreateTasks,
			handleCancelCreateTask,
			createTaskBranchOptions,
			isInitialRuntimeLoad,
			isAwaitingWorkspaceSnapshot,
		}),
		[
			board,
			sessions,
			upsertSession,
			selectedTaskId,
			selectedCard,
			setSelectedTaskId,
			setSessions,
			ensureTaskWorkspace,
			startTaskSession,
			cleanupTaskWorkspace,
			fetchTaskWorkspaceInfo,
			sendTaskSessionInput,
			stopTaskSession,
			taskEditor,
			handleCreateTask,
			handleCreateTasks,
			handleCancelCreateTask,
			createTaskBranchOptions,
			isInitialRuntimeLoad,
			isAwaitingWorkspaceSnapshot,
		],
	);

	return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}
