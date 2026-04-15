import type { Dispatch, SetStateAction } from "react";
import { createContext, useContext } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardData, CardSelection } from "@/types";

// ---------------------------------------------------------------------------
// Context value — board data, task sessions, and task selection state.
//
// The value is constructed in App.tsx and provided inline via
// <BoardContext.Provider>. This file owns the context shape and consumer
// hook so child components can read board + session state without prop drilling.
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
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoardContext(): BoardContextValue {
	const ctx = useContext(BoardContext);
	if (!ctx) {
		throw new Error("useBoardContext must be used within a BoardContext.Provider");
	}
	return ctx;
}
