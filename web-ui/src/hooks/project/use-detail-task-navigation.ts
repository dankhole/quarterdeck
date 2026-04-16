import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findCardSelection } from "@/state/board-state";
import type { BoardData, CardSelection } from "@/types";
import { buildTaskSearchParam, parseTaskIdFromSearch } from "@/utils/app-utils";
import { useWindowEvent } from "@/utils/react-use";

interface UseDetailTaskNavigationInput {
	board: BoardData;
	currentProjectId: string | null;
	/** True once the board has received its initial state from the server. */
	isBoardHydrated: boolean;
}

export interface UseDetailTaskNavigationResult {
	selectedTaskId: string | null;
	selectedCard: CardSelection | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Manages task detail selection with browser URL integration.
 *
 * - Stores the selected task ID in `?task=<id>` search param
 * - Uses `pushState` when opening a task (so browser back closes it)
 * - Uses `replaceState` when clearing (deselecting doesn't add history)
 * - Listens to `popstate` so browser back/forward buttons work
 * - Clears selection when the selected task no longer exists in the board
 * - Clears selection on project switch
 */
export function useDetailTaskNavigation({
	board,
	currentProjectId,
	isBoardHydrated,
}: UseDetailTaskNavigationInput): UseDetailTaskNavigationResult {
	const [selectedTaskId, setSelectedTaskIdRaw] = useState<string | null>(() => {
		if (typeof window === "undefined") return null;
		return parseTaskIdFromSearch(window.location.search);
	});
	const previousProjectIdRef = useRef<string | null | undefined>(undefined);

	const selectedCard = useMemo(() => {
		if (!selectedTaskId) return null;
		return findCardSelection(board, selectedTaskId);
	}, [board, selectedTaskId]);

	// Clear selection when the card no longer exists in the board.
	// Guard: skip until the board has been hydrated from the server, otherwise
	// the initial empty board would immediately clear a task ID parsed from the URL.
	useEffect(() => {
		if (!isBoardHydrated) return;
		if (selectedTaskId && !selectedCard) {
			setSelectedTaskIdRaw(null);
		}
	}, [isBoardHydrated, selectedTaskId, selectedCard]);

	// Clear selection on project switch.
	useEffect(() => {
		const previousProjectId = previousProjectIdRef.current;
		previousProjectIdRef.current = currentProjectId;
		if (previousProjectId === undefined) return;
		if (previousProjectId === currentProjectId) return;
		setSelectedTaskIdRaw(null);
	}, [currentProjectId]);

	// Sync URL when selectedTaskId changes.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const currentTaskIdInUrl = parseTaskIdFromSearch(window.location.search);
		if (currentTaskIdInUrl === selectedTaskId) return;

		const nextSearch = buildTaskSearchParam(window.location.search, selectedTaskId);
		const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;

		if (selectedTaskId && !currentTaskIdInUrl) {
			// Opening a task — push so browser back closes it.
			window.history.pushState(window.history.state, "", nextUrl);
		} else {
			// Clearing or changing — replace to avoid history clutter.
			window.history.replaceState(window.history.state, "", nextUrl);
		}
	}, [selectedTaskId]);

	// Listen for browser back/forward.
	const handlePopState = useCallback(() => {
		if (typeof window === "undefined") return;
		setSelectedTaskIdRaw(parseTaskIdFromSearch(window.location.search));
	}, []);
	useWindowEvent("popstate", handlePopState);

	return {
		selectedTaskId,
		selectedCard,
		setSelectedTaskId: setSelectedTaskIdRaw,
	};
}
