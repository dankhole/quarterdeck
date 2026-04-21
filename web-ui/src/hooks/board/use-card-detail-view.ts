import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
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
import { useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
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

export interface CardDetailViewLayoutState {
	detailLayoutRef: RefObject<HTMLDivElement>;
	mainRowRef: RefObject<HTMLDivElement>;
	handleSidePanelSeparatorMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
	sidePanelPercent: string;
	isTaskSidePanelOpen: boolean;
}

export interface CardDetailViewSidePanelState {
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
}

export interface CardDetailViewRepositoryState {
	board: ReturnType<typeof useBoardContext>["board"];
	taskWorktreeInfo: ReturnType<typeof useTaskWorktreeInfoValue>;
	taskWorktreeSnapshot: ReturnType<typeof useTaskWorktreeSnapshotValue>;
	homeGitSummary: ReturnType<typeof useHomeGitSummaryValue>;
	taskScopeMode: ReturnType<typeof useScopeContext>["scopeMode"];
	taskResolvedScope: ReturnType<typeof useScopeContext>["resolvedScope"];
	taskReturnToContextual: ReturnType<typeof useScopeContext>["returnToContextual"];
	taskBranchActions: ReturnType<typeof useBranchActions>;
	fileBrowserData: ReturnType<typeof useFileBrowserData>;
	pillBranchLabel: string | null;
	isGitHistoryOpen: boolean;
	onToggleGitHistory: () => void;
	pendingCompareNavigation: ReturnType<typeof useSurfaceNavigationContext>["pendingCompareNavigation"];
	onCompareNavigationConsumed: () => void;
	onOpenGitCompare: ReturnType<typeof useSurfaceNavigationContext>["openGitCompare"];
	pendingFileNavigation: ReturnType<typeof useSurfaceNavigationContext>["pendingFileNavigation"];
	onFileNavigationConsumed: () => void;
	navigateToFile: ReturnType<typeof useSurfaceNavigationContext>["navigateToFile"];
	navigateToGitView: () => void;
	runGitAction: ReturnType<typeof useGitContext>["runGitAction"];
	handleAddToTerminal: (text: string) => Promise<void>;
	handleSendToTerminal: (text: string) => Promise<void>;
}

export interface CardDetailViewTerminalState {
	onSessionSummary: (summary: RuntimeTaskSessionSummary) => void;
	onCancelAutomaticTaskAction: ReturnType<typeof useStableCardActions>["onCancelAutomaticTaskAction"];
	isTaskTerminalEnabled: boolean;
}

export interface UseCardDetailViewResult {
	layout: CardDetailViewLayoutState;
	sidePanel: CardDetailViewSidePanelState;
	repository: CardDetailViewRepositoryState;
	terminal: CardDetailViewTerminalState;
}

export function useCardDetailView({
	selection,
	currentProjectId,
	sidePanelRatio,
	setSidePanelRatio,
	sidebar,
	skipTaskCheckoutConfirmation,
	skipHomeCheckoutConfirmation,
}: UseCardDetailViewInput): UseCardDetailViewResult {
	const { board, sessions: taskSessions, upsertSession: onSessionSummary, sendTaskSessionInput } = useBoardContext();
	const navigation = useSurfaceNavigationContext();
	const { runGitAction } = useGitContext();
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
		onConflictDetected: navigation.navigateToGitView,
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
		layout: {
			detailLayoutRef,
			mainRowRef,
			handleSidePanelSeparatorMouseDown,
			sidePanelPercent: formatCardDetailSidePanelPercent(sidePanelRatio),
			isTaskSidePanelOpen: sidebar === "task_column" || sidebar === "commit",
		},
		sidePanel: {
			taskSessions,
		},
		repository: {
			board,
			taskWorktreeInfo,
			taskWorktreeSnapshot,
			homeGitSummary,
			taskScopeMode,
			taskResolvedScope,
			taskReturnToContextual,
			taskBranchActions,
			fileBrowserData,
			pillBranchLabel,
			isGitHistoryOpen: navigation.isGitHistoryOpen,
			onToggleGitHistory: navigation.handleToggleGitHistory,
			pendingCompareNavigation: navigation.pendingCompareNavigation,
			onCompareNavigationConsumed: navigation.clearPendingCompareNavigation,
			onOpenGitCompare: navigation.openGitCompare,
			pendingFileNavigation: navigation.pendingFileNavigation,
			onFileNavigationConsumed: navigation.clearPendingFileNavigation,
			navigateToFile: navigation.navigateToFile,
			navigateToGitView: navigation.navigateToGitView,
			runGitAction,
			handleAddToTerminal,
			handleSendToTerminal,
		},
		terminal: {
			onSessionSummary,
			onCancelAutomaticTaskAction,
			isTaskTerminalEnabled: selection.column.id === "in_progress" || selection.column.id === "review",
		},
	};
}
