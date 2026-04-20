import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveBoardCardViewModel } from "@/hooks/board/board-card";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getProjectPath, useTaskWorktreeSnapshotValue } from "@/stores/project-metadata-store";
import type { BoardCard, BoardColumnId } from "@/types";

interface UseBoardCardInput {
	card: BoardCard;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	showSummaryOnCards: boolean;
	uncommittedChangesOnCardsEnabled: boolean;
	onRestartSession?: (taskId: string) => void;
}

export function useBoardCard({
	card,
	columnId,
	sessionSummary,
	showSummaryOnCards,
	uncommittedChangesOnCardsEnabled,
	onRestartSession,
}: UseBoardCardInput) {
	const [isHovered, setIsHovered] = useState(false);
	const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [isRestartDelayElapsed, setIsRestartDelayElapsed] = useState(false);
	const reviewWorktreeSnapshot = useTaskWorktreeSnapshotValue(card.id);
	const workspacePath = getProjectPath();

	const viewModel = useMemo(
		() =>
			resolveBoardCardViewModel({
				card,
				columnId,
				sessionSummary,
				reviewWorktreeSnapshot: reviewWorktreeSnapshot ?? undefined,
				workspacePath,
				showSummaryOnCards,
				uncommittedChangesOnCardsEnabled,
				isRestartDelayElapsed,
				hasRestartSessionHandler: Boolean(onRestartSession),
			}),
		[
			card,
			columnId,
			sessionSummary,
			reviewWorktreeSnapshot,
			workspacePath,
			showSummaryOnCards,
			uncommittedChangesOnCardsEnabled,
			isRestartDelayElapsed,
			onRestartSession,
		],
	);

	useEffect(() => {
		if (!viewModel.isSessionDead) {
			setIsRestartDelayElapsed(false);
			return;
		}
		const timer = setTimeout(() => setIsRestartDelayElapsed(true), 1_000);
		return () => clearTimeout(timer);
	}, [viewModel.isSessionDead]);

	const openTitleEditor = useCallback(() => setIsEditingTitle(true), []);
	const closeTitleEditor = useCallback(() => setIsEditingTitle(false), []);

	return {
		reviewWorktreeSnapshot,
		isHovered,
		setIsHovered,
		hoverTimerRef,
		isEditingTitle,
		openTitleEditor,
		closeTitleEditor,
		...viewModel,
	};
}
