import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardColumnId, ReviewTaskWorktreeSnapshot } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import { getCardHoverTooltip, getRunningActivityLabel, shortenBranchName } from "@/utils/board-card-display";
import { describeSessionState, getSessionStatusBadgeStyle, getSessionStatusTooltip } from "@/utils/session-status";
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
	const isSharedCheckout =
		reviewWorktreeSnapshot?.path && workspacePath
			? reviewWorktreeSnapshot.path === workspacePath
			: card.useWorktree === false;
	const isCwdDiverged =
		Boolean(sessionSummary?.projectPath) &&
		Boolean(reviewWorktreeSnapshot?.path) &&
		(sessionSummary?.state === "running" || sessionSummary?.state === "awaiting_review") &&
		sessionSummary.projectPath !== reviewWorktreeSnapshot?.path;
	const displayTitle = card.title || truncateTaskPromptLabel(card.prompt);
	const statusLabel = sessionSummary ? describeSessionState(sessionSummary) : null;
	const statusTagStyle = sessionSummary ? getSessionStatusBadgeStyle(sessionSummary) : null;
	const statusTooltip = sessionSummary ? getSessionStatusTooltip(sessionSummary) : null;
	const showStatusBadge = Boolean(statusLabel && statusTagStyle && columnId !== "backlog" && !isTrashCard);
	const runningActivity = getRunningActivityLabel(sessionSummary);
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
	const effectiveBranch =
		reviewWorktreeSnapshot?.branch ?? (reviewWorktreeSnapshot?.isDetached ? null : card.branch) ?? null;
	const reviewBranchLabel = effectiveBranch
		? shortenBranchName(effectiveBranch)
		: (reviewWorktreeSnapshot?.headCommit?.slice(0, 8) ?? null);
	const reviewChangeSummary =
		reviewWorktreeSnapshot?.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorktreeSnapshot.changedFiles} ${reviewWorktreeSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorktreeSnapshot.additions ?? 0,
					deletions: reviewWorktreeSnapshot.deletions ?? 0,
				};
	const cancelAutomaticActionLabel =
		!isTrashCard && card.autoReviewEnabled ? getTaskAutoReviewCancelButtonLabel(card.autoReviewMode) : null;
	const showUncommittedChangesIndicator =
		uncommittedChangesOnCardsEnabled &&
		showProjectStatus &&
		!isTrashCard &&
		(reviewWorktreeSnapshot?.changedFiles ?? 0) > 0;

	return {
		isTrashCard,
		isCardInteractive,
		isSharedCheckout,
		isCwdDiverged,
		displayTitle,
		statusLabel,
		statusTagStyle,
		statusTooltip,
		showStatusBadge,
		runningActivity,
		latestSummaryText,
		isSummaryVisibleOnCard,
		effectiveTooltip,
		isSessionDead,
		isSessionRestartable,
		statusMarker,
		showProjectStatus,
		effectiveBranch,
		reviewBranchLabel,
		reviewChangeSummary,
		cancelAutomaticActionLabel,
		showUncommittedChangesIndicator,
	};
}
