import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { type UseTaskEditorResult, useTaskEditor, useTaskSessions } from "@/hooks/board";
import { useTaskBranchOptions } from "@/hooks/git";
import { useDetailTaskNavigation } from "@/hooks/project";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
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
	ensureTaskWorktree: ReturnType<typeof useTaskSessions>["ensureTaskWorktree"];
	startTaskSession: ReturnType<typeof useTaskSessions>["startTaskSession"];
	cleanupTaskWorktree: ReturnType<typeof useTaskSessions>["cleanupTaskWorktree"];
	fetchTaskWorktreeInfo: ReturnType<typeof useTaskSessions>["fetchTaskWorktreeInfo"];
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
	resetBoardUiState: () => void;
	pendingTaskStartAfterEditId: string | null;
	clearPendingTaskStartAfterEditId: () => void;

	// --- Task branch options ---
	createTaskBranchOptions: Array<{ value: string; label: string }>;

	// --- Derived loading flags ---
	isInitialRuntimeLoad: boolean;
	isAwaitingProjectSnapshot: boolean;
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
	children: ReactNode;
}

export function BoardProvider({ board, setBoard, sessions, setSessions, children }: BoardProviderProps): ReactNode {
	const {
		currentProjectId,
		projects,
		streamedProjectState,
		hasReceivedSnapshot,
		streamError,
		projectPath,
		projectGit,
	} = useProjectContext();
	const { configDefaultBaseRef } = useProjectRuntimeContext();

	// --- useDetailTaskNavigation ---
	const { selectedTaskId, selectedCard, setSelectedTaskId } = useDetailTaskNavigation({
		board,
		currentProjectId,
		isBoardHydrated: hasReceivedSnapshot,
	});

	// --- Derived loading flags ---
	const isInitialRuntimeLoad =
		!hasReceivedSnapshot && currentProjectId === null && projects.length === 0 && !streamError;
	const isAwaitingProjectSnapshot = currentProjectId !== null && streamedProjectState === null;
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);

	// --- useTaskSessions ---
	const {
		upsertSession,
		ensureTaskWorktree,
		startTaskSession,
		stopTaskSession,
		sendTaskSessionInput,
		cleanupTaskWorktree,
		fetchTaskWorktreeInfo,
	} = useTaskSessions({
		currentProjectId,
		setSessions,
		onWorkingDirectoryResolved: (taskId, workingDirectory) => {
			setBoard((current) => {
				const result = reconcileTaskWorkingDirectory(current, taskId, workingDirectory, projectPath);
				return result.updated ? result.board : current;
			});
		},
	});

	// --- useTaskBranchOptions ---
	const { createTaskBranchOptions, defaultTaskBranchRef } = useTaskBranchOptions({
		projectGit,
		configDefaultBaseRef,
	});

	// --- queueTaskStartAfterEdit ---
	const queueTaskStartAfterEdit = useCallback(
		(taskId: string) => {
			setPendingTaskStartAfterEditId(taskId);
		},
		[setPendingTaskStartAfterEditId],
	);

	const clearPendingTaskStartAfterEditId = useCallback(() => {
		setPendingTaskStartAfterEditId(null);
	}, []);

	// --- useTaskEditor ---
	const taskEditor = useTaskEditor({
		board,
		setBoard,
		currentProjectId,
		createTaskBranchOptions,
		defaultTaskBranchRef,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});
	const { handleCreateTask, handleCreateTasks, resetTaskEditorState, handleCancelCreateTask } = taskEditor;

	const resetBoardUiState = useCallback(() => {
		resetTaskEditorState();
		setPendingTaskStartAfterEditId(null);
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
			ensureTaskWorktree,
			startTaskSession,
			cleanupTaskWorktree,
			fetchTaskWorktreeInfo,
			sendTaskSessionInput,
			stopTaskSession,
			taskEditor,
			handleCreateTask,
			handleCreateTasks,
			handleCancelCreateTask,
			resetBoardUiState,
			pendingTaskStartAfterEditId,
			clearPendingTaskStartAfterEditId,
			createTaskBranchOptions,
			isInitialRuntimeLoad,
			isAwaitingProjectSnapshot,
		}),
		[
			board,
			sessions,
			upsertSession,
			selectedTaskId,
			selectedCard,
			setSelectedTaskId,
			setSessions,
			ensureTaskWorktree,
			startTaskSession,
			cleanupTaskWorktree,
			fetchTaskWorktreeInfo,
			sendTaskSessionInput,
			stopTaskSession,
			taskEditor,
			handleCreateTask,
			handleCreateTasks,
			handleCancelCreateTask,
			resetBoardUiState,
			pendingTaskStartAfterEditId,
			clearPendingTaskStartAfterEditId,
			createTaskBranchOptions,
			isInitialRuntimeLoad,
			isAwaitingProjectSnapshot,
		],
	);

	return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}
