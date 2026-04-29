import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardColumnId, ReviewTaskWorktreeSnapshot } from "@/types";
import { getCardHoverTooltip, shortenBranchName } from "@/utils/board-card-display";
import { describeSessionState, getSessionStatusBadgeStyle, getSessionStatusTooltip } from "@/utils/session-status";
import { getTaskAgentDisplayLabel, getTaskAgentShortLabel } from "@/utils/task-agent-display";
import { resolveDetachedTaskWorktreeDisplay } from "@/utils/task-base-ref-display";
import { resolveTaskIdentity } from "@/utils/task-identity";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

export function isBoardCardSessionDead(sessionSummary?: RuntimeTaskSessionSummary): boolean {
	return (
		!sessionSummary ||
		sessionSummary.state === "idle" ||
		sessionSummary.state === "failed" ||
		sessionSummary.state === "interrupted" ||
		(sessionSummary.state === "awaiting_review" && sessionSummary.reviewReason === "error")
	);
}

export function resolveBoardCardViewModel({
	card,
	columnId,
	sessionSummary,
	reviewWorktreeSnapshot,
	workspacePath,
	showSummaryOnCards,
	uncommittedChangesOnCardsEnabled,
	isRestartDelayElapsed,
	hasRestartSessionHandler,
}: {
	card: BoardCard;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	reviewWorktreeSnapshot: ReviewTaskWorktreeSnapshot | null | undefined;
	workspacePath: string | null;
	showSummaryOnCards: boolean;
	uncommittedChangesOnCardsEnabled: boolean;
	isRestartDelayElapsed: boolean;
	hasRestartSessionHandler: boolean;
}) {
	const isTrashCard = columnId === "trash";
	const isCardInteractive = !isTrashCard;
	const taskIdentity = resolveTaskIdentity({
		projectRootPath: workspacePath,
		card,
		worktreeSnapshot: reviewWorktreeSnapshot ?? null,
		sessionSummary: sessionSummary ?? null,
	});
	const isSharedCheckout = taskIdentity.isAssignedShared;
	const isSessionPathDiverged =
		(sessionSummary?.state === "running" || sessionSummary?.state === "awaiting_review") &&
		taskIdentity.isSessionLaunchDiverged;
	const displayTitle = card.title || truncateTaskPromptLabel(card.prompt);
	const statusLabel = sessionSummary ? describeSessionState(sessionSummary) : null;
	const statusTagStyle = sessionSummary ? getSessionStatusBadgeStyle(sessionSummary) : null;
	const statusTooltip = sessionSummary ? getSessionStatusTooltip(sessionSummary) : null;
	const showStatusBadge = Boolean(statusLabel && statusTagStyle && columnId !== "backlog" && !isTrashCard);
	const cardHoverTooltip = getCardHoverTooltip(sessionSummary);
	const latestSummaryText = sessionSummary?.displaySummary ?? null;
	const isSummaryVisibleOnCard = showSummaryOnCards && Boolean(latestSummaryText);
	const effectiveTooltip = isSummaryVisibleOnCard ? null : cardHoverTooltip;
	const isSessionDead = isBoardCardSessionDead(sessionSummary);
	const isSessionRestartable =
		(columnId === "in_progress" || columnId === "review") &&
		isSessionDead &&
		isRestartDelayElapsed &&
		hasRestartSessionHandler;
	const statusMarker = columnId === "in_progress" ? (isSessionRestartable ? "restart" : "spinner") : null;
	const showProjectStatus = columnId === "in_progress" || columnId === "review" || isTrashCard;
	const detachedWorktreeDisplay = resolveDetachedTaskWorktreeDisplay({
		isDetached: taskIdentity.assignedIsDetached,
		isAssignedShared: isSharedCheckout,
		baseRef: card.baseRef,
		headCommit: taskIdentity.assignedHeadCommit,
	});
	const reviewBranchLabel =
		detachedWorktreeDisplay?.label ??
		(taskIdentity.displayBranchLabel ? shortenBranchName(taskIdentity.displayBranchLabel) : null);
	const reviewBranchTooltip = detachedWorktreeDisplay
		? detachedWorktreeDisplay.tooltip
		: (taskIdentity.assignedBranch ?? reviewBranchLabel);
	const reviewChangeSummary =
		reviewWorktreeSnapshot?.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorktreeSnapshot.changedFiles} ${reviewWorktreeSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorktreeSnapshot.additions ?? 0,
					deletions: reviewWorktreeSnapshot.deletions ?? 0,
				};
	const showUncommittedChangesIndicator =
		uncommittedChangesOnCardsEnabled &&
		showProjectStatus &&
		!isTrashCard &&
		(reviewWorktreeSnapshot?.changedFiles ?? 0) > 0;
	const effectiveAgentId = sessionSummary?.agentId ?? card.agentId ?? null;
	const agentBadge = effectiveAgentId
		? {
				label: getTaskAgentShortLabel(effectiveAgentId),
				tooltip: `Harness: ${getTaskAgentDisplayLabel(effectiveAgentId)}`,
			}
		: null;

	return {
		isTrashCard,
		isCardInteractive,
		isSharedCheckout,
		isSessionPathDiverged,
		displayTitle,
		statusLabel,
		statusTagStyle,
		statusTooltip,
		showStatusBadge,
		latestSummaryText,
		isSummaryVisibleOnCard,
		effectiveTooltip,
		isSessionDead,
		isSessionRestartable,
		statusMarker,
		showProjectStatus,
		reviewBranchLabel,
		reviewBranchTooltip,
		showDetachedWorktreeHint: detachedWorktreeDisplay !== null,
		reviewChangeSummary,
		showUncommittedChangesIndicator,
		agentBadge,
	};
}
