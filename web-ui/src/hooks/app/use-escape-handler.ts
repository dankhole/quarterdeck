import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import type { CardSelection } from "@/types";
import { useWindowEvent } from "@/utils/react-use";

interface UseEscapeHandlerInput {
	isGitHistoryOpen: boolean;
	setIsGitHistoryOpen: Dispatch<SetStateAction<boolean>>;
	selectedCard: CardSelection | null;
	setSelectedTaskId: (id: string | null) => void;
}

/**
 * Unified Escape key handler:
 * 1. If git history is open → close it
 * 2. If a task is selected (and not typing) → deselect it
 */
export function useEscapeHandler({
	isGitHistoryOpen,
	setIsGitHistoryOpen,
	selectedCard,
	setSelectedTaskId,
}: UseEscapeHandlerInput): void {
	const handleEscapeKeydown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			// Skip if inside a dialog
			if (event.target instanceof Element && event.target.closest("[role='dialog']")) return;

			// 1. Git history open → close it (home or task context)
			if (isGitHistoryOpen) {
				event.preventDefault();
				setIsGitHistoryOpen(false);
				return;
			}

			const isTyping =
				event.target instanceof HTMLElement &&
				(event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable);
			if (isTyping) return;

			// 2. Task selected → deselect
			if (selectedCard) {
				event.preventDefault();
				setSelectedTaskId(null);
				return;
			}
		},
		[isGitHistoryOpen, selectedCard, setIsGitHistoryOpen, setSelectedTaskId],
	);
	useWindowEvent("keydown", handleEscapeKeydown);
}
