import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createContext, useContext, useMemo } from "react";
import { useTaskLifecycleOperations, useTaskSessions } from "@/hooks/board";
import { useDetailTaskNavigation } from "@/hooks/project";
import {
	useProjectNavigationContext,
	useProjectRuntimeStreamContext,
	useProjectSyncContext,
} from "@/providers/project-provider";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardData, CardSelection } from "@/types";

// ---------------------------------------------------------------------------
// Context value — board data, task sessions, task selection, and derived
// loading flags.
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
	fetchTaskWorktreeInfo: ReturnType<typeof useTaskSessions>["fetchTaskWorktreeInfo"];
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	taskLifecycle: ReturnType<typeof useTaskLifecycleOperations>;

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
// BoardProvider — runs board-scoped hooks (task navigation, task sessions)
// and provides BoardContext.
// ---------------------------------------------------------------------------

interface BoardProviderProps {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	children: ReactNode;
}

export function BoardProvider({ board, sessions, setSessions, children }: BoardProviderProps): ReactNode {
	const { currentProjectId, projects } = useProjectNavigationContext();
	const { streamedProjectState, hasReceivedSnapshot, streamError } = useProjectRuntimeStreamContext();
	const { setBoard, flushBoardCommands, getAuthoritativeRevision, applyLifecycleProjectState, refreshProjectState } =
		useProjectSyncContext();

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

	// --- useTaskSessions ---
	const { upsertSession, sendTaskSessionInput, fetchTaskWorktreeInfo } = useTaskSessions({
		currentProjectId,
		setSessions,
	});
	const taskLifecycle = useTaskLifecycleOperations({
		currentProjectId,
		flushBoardCommands,
		getAuthoritativeRevision,
		applyLifecycleProjectState,
		refreshProjectState,
	});

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
			fetchTaskWorktreeInfo,
			sendTaskSessionInput,
			taskLifecycle,
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
			fetchTaskWorktreeInfo,
			sendTaskSessionInput,
			taskLifecycle,
			isInitialRuntimeLoad,
			isAwaitingProjectSnapshot,
		],
	);

	return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}
