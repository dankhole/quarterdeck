import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useMemo, useRef } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	formatCardDetailSidePanelPercent,
	resolveCardDetailBranchPillLabel,
	resolveCardDetailFileBrowserScope,
} from "@/hooks/board/card-detail-view";
import { useBranchActions, useFileBrowserData, useScopeContext } from "@/hooks/git";
import { useBoardContext } from "@/providers/board-provider";
import { useGitContext } from "@/providers/git-provider";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { useStableCardActions } from "@/state/card-actions-context";
import {
	useHomeGitSummaryValue,
	useTaskWorktreeInfoValue,
	useTaskWorktreeSnapshotValue,
} from "@/stores/project-metadata-store";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import type { CardSelection } from "@/types";

interface UseCardDetailViewInput {
	selection: CardSelection;
	currentProjectId: string | null;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	sidebar: "projects" | "task_column" | "commit" | null;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
}

export function useCardDetailView({
	selection,
	currentProjectId,
	sidePanelRatio,
	setSidePanelRatio,
	sidebar,
	skipTaskCheckoutConfirmation,
	skipHomeCheckoutConfirmation,
}: UseCardDetailViewInput) {
	const { board, sessions: taskSessions, upsertSession: onSessionSummary, sendTaskSessionInput } = useBoardContext();
	const {
		isGitHistoryOpen,
		handleToggleGitHistory: onToggleGitHistory,
		pendingCompareNavigation,
		clearPendingCompareNavigation: onCompareNavigationConsumed,
		openGitCompare: onOpenGitCompare,
		pendingFileNavigation,
		clearPendingFileNavigation: onFileNavigationConsumed,
		navigateToFile,
		navigateToGitView,
		runGitAction,
	} = useGitContext();
	const { startDrag: startSidePanelResize } = useResizeDrag();
	const { onCancelAutomaticTaskAction } = useStableCardActions();
	const detailLayoutRef = useRef<HTMLDivElement | null>(null);
	const mainRowRef = useRef<HTMLDivElement | null>(null);

	const handleSidePanelSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = detailLayoutRef.current;
			if (!container) return;
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startRatio = sidePanelRatio;
			startSidePanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					setSidePanelRatio(startRatio + deltaRatio);
				},
				onEnd: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					setSidePanelRatio(startRatio + deltaRatio);
				},
			});
		},
		[setSidePanelRatio, sidePanelRatio, startSidePanelResize],
	);

	const taskWorktreeInfo = useTaskWorktreeInfoValue(selection.card.id, selection.card.baseRef);
	const taskWorktreeSnapshot = useTaskWorktreeSnapshotValue(selection.card.id);
	const homeGitSummary = useHomeGitSummaryValue();

	const {
		scopeMode: taskScopeMode,
		resolvedScope: taskResolvedScope,
		returnToContextual: taskReturnToContextual,
		selectBranchView: taskSelectBranchView,
	} = useScopeContext({
		selectedTaskId: selection.card.id,
		selectedCard: selection.card,
		currentProjectId,
	});

	const taskBranchActions = useBranchActions({
		projectId: currentProjectId,
		board,
		selectBranchView: taskSelectBranchView,
		homeGitSummary,
		taskBranch: taskWorktreeInfo?.branch ?? selection.card.branch ?? null,
		taskChangedFiles: taskWorktreeSnapshot?.changedFiles ?? 0,
		skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation,
		taskId: selection.card.id,
		baseRef: selection.card.baseRef,
		onCheckoutSuccess: taskReturnToContextual,
		onConflictDetected: navigateToGitView,
	});

	const fileBrowserScope = useMemo(() => resolveCardDetailFileBrowserScope(taskResolvedScope), [taskResolvedScope]);

	const fileBrowserData = useFileBrowserData({
		projectId: currentProjectId,
		taskId: fileBrowserScope.taskId,
		baseRef: fileBrowserScope.baseRef,
		ref: fileBrowserScope.ref,
	});

	const pillBranchLabel = useMemo(
		() =>
			resolveCardDetailBranchPillLabel({
				resolvedScope: taskResolvedScope,
				branch: taskWorktreeInfo?.branch,
				isDetached: taskWorktreeInfo?.isDetached,
				headCommit: taskWorktreeInfo?.headCommit,
				fallbackBranch: selection.card.branch,
			}),
		[
			selection.card.branch,
			taskResolvedScope,
			taskWorktreeInfo?.branch,
			taskWorktreeInfo?.headCommit,
			taskWorktreeInfo?.isDetached,
		],
	);

	const taskId = selection.card.id;

	const handleAddToTerminal = useCallback(
		async (text: string) => {
			const result = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!result.ok) {
				showAppToast({
					intent: "danger",
					message: result.message ?? "Could not paste review comments into the terminal.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput, taskId],
	);

	const handleSendToTerminal = useCallback(
		async (text: string) => {
			const result = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!result.ok) {
				showAppToast({
					intent: "danger",
					message: result.message ?? "Could not paste review comments into the terminal.",
					timeout: 7000,
				});
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
			const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
			if (!submitted.ok) {
				showAppToast({
					intent: "danger",
					message: submitted.message ?? "Could not submit review comments.",
					timeout: 7000,
				});
				return;
			}
			getTerminalController(taskId)?.focus?.();
		},
		[sendTaskSessionInput, taskId],
	);

	return {
		board,
		taskSessions,
		onSessionSummary,
		onCancelAutomaticTaskAction,
		detailLayoutRef,
		mainRowRef,
		handleSidePanelSeparatorMouseDown,
		taskWorktreeInfo,
		taskWorktreeSnapshot,
		homeGitSummary,
		taskScopeMode,
		taskResolvedScope,
		taskReturnToContextual,
		taskBranchActions,
		fileBrowserData,
		pillBranchLabel,
		handleAddToTerminal,
		handleSendToTerminal,
		sidePanelPercent: formatCardDetailSidePanelPercent(sidePanelRatio),
		isTaskSidePanelOpen: sidebar === "task_column" || sidebar === "commit",
		isTaskTerminalEnabled: selection.column.id === "in_progress" || selection.column.id === "review",
		isGitHistoryOpen,
		onToggleGitHistory,
		pendingCompareNavigation,
		onCompareNavigationConsumed,
		onOpenGitCompare,
		pendingFileNavigation,
		onFileNavigationConsumed,
		navigateToFile,
		navigateToGitView,
		runGitAction,
	};
}

export type UseCardDetailViewResult = ReturnType<typeof useCardDetailView>;
