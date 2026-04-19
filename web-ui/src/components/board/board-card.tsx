import { Draggable, type DraggableProvided, type DraggableStateSnapshot } from "@hello-pangea/dnd";
import { AlertCircle, GitBranch, Pencil, Pin, PinOff, RotateCw } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BoardCardActions } from "@/components/board/board-card-actions";
import {
	CARD_TEXT_COLOR,
	getCardHoverTooltip,
	getRunningActivityLabel,
	shortenBranchName,
} from "@/components/board/board-card-display";
import { InlineTitleEditor } from "@/components/task/inline-title-editor";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TruncateTooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getProjectPath, useTaskWorktreeSnapshotValue } from "@/stores/project-metadata-store";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import {
	describeSessionState,
	getSessionStatusBadgeStyle,
	getSessionStatusTooltip,
	statusBadgeColors,
} from "@/utils/session-status";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

export { getCardHoverTooltip } from "@/components/board/board-card-display";

const stopEvent = (event: MouseEvent<HTMLElement>) => {
	event.preventDefault();
	event.stopPropagation();
};

export function BoardCard({
	card,
	index,
	columnId,
	sessionSummary,
	selected = false,
	showSummaryOnCards = false,
	uncommittedChangesOnCardsEnabled = false,
	showRunningTaskEmergencyActions = false,
	onClick,
	onDoubleClick,
	onStart,
	onRestartSession,
	onMoveToTrash,
	onRestoreFromTrash,
	onHardDelete,
	onCancelAutomaticAction,
	onRegenerateTitle,
	isLlmGenerationDisabled,
	onUpdateTitle,
	onTogglePin,
	isMoveToTrashLoading = false,
	onMigrateWorkingDirectory,
	isMigrateLoading = false,
	onFlagForDebug,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	onRequestDisplaySummary,
	onTerminalWarmup,
	onTerminalCancelWarmup,
	isDependencySource = false,
	isDependencyTarget = false,
	isDependencyLinking = false,
	draggable = true,
}: {
	card: BoardCardModel;
	index: number;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	selected?: boolean;
	showSummaryOnCards?: boolean;
	uncommittedChangesOnCardsEnabled?: boolean;
	showRunningTaskEmergencyActions?: boolean;
	onClick?: () => void;
	onDoubleClick?: () => void;
	onStart?: (taskId: string) => void;
	onRestartSession?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onHardDelete?: (taskId: string) => void;
	onCancelAutomaticAction?: (taskId: string) => void;
	onRegenerateTitle?: (taskId: string) => void;
	isLlmGenerationDisabled?: boolean;
	onUpdateTitle?: (taskId: string, title: string) => void;
	onTogglePin?: (taskId: string) => void;
	isMoveToTrashLoading?: boolean;
	onMigrateWorkingDirectory?: (taskId: string, direction: "isolate" | "de-isolate") => void;
	isMigrateLoading?: boolean;
	onFlagForDebug?: (taskId: string) => void;
	onDependencyPointerDown?: (taskId: string, event: MouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	onRequestDisplaySummary?: (taskId: string) => void;
	onTerminalWarmup?: (taskId: string) => void;
	onTerminalCancelWarmup?: (taskId: string) => void;
	isDependencySource?: boolean;
	isDependencyTarget?: boolean;
	isDependencyLinking?: boolean;
	draggable?: boolean;
}): React.ReactElement {
	const [isHovered, setIsHovered] = useState(false);
	const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [isEditingTitle, setIsEditingTitle] = useState(false);

	const openTitleEditor = useCallback(() => setIsEditingTitle(true), []);
	const closeTitleEditor = useCallback(() => setIsEditingTitle(false), []);

	const reviewWorktreeSnapshot = useTaskWorktreeSnapshotValue(card.id);
	const isTrashCard = columnId === "trash";
	const isCardInteractive = !isTrashCard;

	const isSharedCheckout = useMemo(() => {
		const wsPath = getProjectPath();
		if (reviewWorktreeSnapshot?.path && wsPath) {
			return reviewWorktreeSnapshot.path === wsPath;
		}
		return card.useWorktree === false;
	}, [reviewWorktreeSnapshot?.path, card.useWorktree]);

	const isCwdDiverged = useMemo(() => {
		if (!sessionSummary?.projectPath || !reviewWorktreeSnapshot?.path) return false;
		if (sessionSummary.state !== "running" && sessionSummary.state !== "awaiting_review") return false;
		return sessionSummary.projectPath !== reviewWorktreeSnapshot.path;
	}, [sessionSummary?.projectPath, sessionSummary?.state, reviewWorktreeSnapshot?.path]);

	const displayTitle = card.title || truncateTaskPromptLabel(card.prompt);

	const statusLabel = sessionSummary ? describeSessionState(sessionSummary) : null;
	const statusTagStyle = sessionSummary ? getSessionStatusBadgeStyle(sessionSummary) : null;
	const statusTooltip = sessionSummary ? getSessionStatusTooltip(sessionSummary) : null;
	const showStatusBadge = statusLabel && statusTagStyle && columnId !== "backlog" && !isTrashCard;

	const runningActivity = useMemo(() => getRunningActivityLabel(sessionSummary), [sessionSummary]);
	const cardHoverTooltip = useMemo(() => getCardHoverTooltip(sessionSummary), [sessionSummary]);

	const latestSummaryText = sessionSummary?.displaySummary ?? null;

	const isSummaryVisibleOnCard = showSummaryOnCards && !!latestSummaryText;
	const effectiveTooltip = isSummaryVisibleOnCard ? null : cardHoverTooltip;

	const isSessionDead =
		!sessionSummary ||
		sessionSummary.state === "idle" ||
		sessionSummary.state === "failed" ||
		sessionSummary.state === "interrupted" ||
		(sessionSummary.state === "awaiting_review" && sessionSummary.reviewReason === "error");

	const [isRestartDelayElapsed, setIsRestartDelayElapsed] = useState(false);
	useEffect(() => {
		if (!isSessionDead) {
			setIsRestartDelayElapsed(false);
			return;
		}
		const timer = setTimeout(() => setIsRestartDelayElapsed(true), 1_000);
		return () => clearTimeout(timer);
	}, [isSessionDead]);

	const isSessionRestartable =
		(columnId === "in_progress" || columnId === "review") && isSessionDead && isRestartDelayElapsed;

	const statusMarker =
		columnId === "in_progress" ? (isSessionRestartable && onRestartSession ? "restart" : "spinner") : null;
	const showProjectStatus = columnId === "in_progress" || columnId === "review" || isTrashCard;
	const effectiveBranch =
		reviewWorktreeSnapshot?.branch ?? (reviewWorktreeSnapshot?.isDetached ? null : card.branch) ?? null;
	const reviewBranchLabel = effectiveBranch
		? shortenBranchName(effectiveBranch)
		: (reviewWorktreeSnapshot?.headCommit?.slice(0, 8) ?? null);
	const reviewChangeSummary = reviewWorktreeSnapshot
		? reviewWorktreeSnapshot.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorktreeSnapshot.changedFiles} ${reviewWorktreeSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorktreeSnapshot.additions ?? 0,
					deletions: reviewWorktreeSnapshot.deletions ?? 0,
				}
		: null;
	const cancelAutomaticActionLabel =
		!isTrashCard && card.autoReviewEnabled ? getTaskAutoReviewCancelButtonLabel(card.autoReviewMode) : null;

	const renderShell = (provided?: DraggableProvided, snapshot?: DraggableStateSnapshot) => {
		const isDragging = snapshot?.isDragging ?? false;
		const content = (
			<div
				ref={provided?.innerRef}
				{...(provided?.draggableProps ?? {})}
				{...(provided?.dragHandleProps ?? {})}
				className="kb-board-card-shell"
				data-task-id={card.id}
				data-column-id={columnId}
				data-selected={selected}
				onMouseDownCapture={(event) => {
					if (!isCardInteractive) {
						return;
					}
					if (isDependencyLinking) {
						event.preventDefault();
						event.stopPropagation();
						return;
					}
					if (!event.metaKey && !event.ctrlKey) {
						return;
					}
					const target = event.target as HTMLElement | null;
					if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					onDependencyPointerDown?.(card.id, event);
				}}
				onClick={(event) => {
					if (!isCardInteractive) {
						return;
					}
					if (isDependencyLinking) {
						event.preventDefault();
						event.stopPropagation();
						return;
					}
					if (event.metaKey || event.ctrlKey) {
						return;
					}
					if (!isDragging && onClick) {
						onClick();
					}
				}}
				onDoubleClick={(event) => {
					if (!isCardInteractive || isDependencyLinking || isDragging) {
						return;
					}
					if (event.metaKey || event.ctrlKey) {
						return;
					}
					onDoubleClick?.();
				}}
				style={{
					...(provided?.draggableProps?.style ?? {}),
					marginBottom: 6,
					cursor: draggable ? "grab" : undefined,
				}}
				onMouseEnter={() => {
					hoverTimerRef.current = setTimeout(() => setIsHovered(true), 200);
					onDependencyPointerEnter?.(card.id);
					onRequestDisplaySummary?.(card.id);
					onTerminalWarmup?.(card.id);
				}}
				onMouseMove={() => {
					if (!isDependencyLinking) {
						return;
					}
					onDependencyPointerEnter?.(card.id);
				}}
				onMouseLeave={() => {
					if (hoverTimerRef.current) {
						clearTimeout(hoverTimerRef.current);
						hoverTimerRef.current = null;
					}
					setIsHovered(false);
					onTerminalCancelWarmup?.(card.id);
				}}
			>
				<Tooltip content={effectiveTooltip ?? undefined} side="top">
					<div
						className={cn(
							"rounded-md border border-border-bright bg-surface-2 p-2.5",
							isCardInteractive && "cursor-pointer hover:bg-surface-3 hover:border-border-bright",
							isDragging && "shadow-lg",
							isHovered && isCardInteractive && "bg-surface-3 border-border-bright",
							isDependencySource && "kb-board-card-dependency-source",
							isDependencyTarget && "kb-board-card-dependency-target",
						)}
					>
						<div className="flex items-center gap-2" style={{ minHeight: 24 }}>
							{statusMarker === "restart" ? (
								<div className="inline-flex items-center">
									<Tooltip content="Restart session">
										<Button
											icon={<RotateCw size={12} />}
											variant="ghost"
											size="sm"
											className="text-status-red hover:text-text-primary"
											aria-label="Restart agent session"
											onMouseDown={stopEvent}
											onClick={(event) => {
												stopEvent(event);
												onRestartSession?.(card.id);
											}}
										/>
									</Tooltip>
								</div>
							) : statusMarker === "spinner" ? (
								<div className="inline-flex items-center">
									<Spinner size={12} />
								</div>
							) : null}
							{card.pinned && !isTrashCard ? (
								<Tooltip content="Pinned to top">
									<span className="inline-flex items-center shrink-0 text-text-secondary">
										<Pin size={12} />
									</span>
								</Tooltip>
							) : null}
							{isSharedCheckout ? (
								<Tooltip content="Running in shared checkout (not isolated)">
									<span className="inline-flex items-center shrink-0 rounded bg-status-red/15 px-1 py-px text-[10px] font-medium text-status-red leading-tight">
										Shared
									</span>
								</Tooltip>
							) : null}
							{isCwdDiverged ? (
								<Tooltip content="Agent session is running in a different directory than expected. Restart the task to fix.">
									<AlertCircle size={12} className="shrink-0 text-status-orange" />
								</Tooltip>
							) : null}
							{uncommittedChangesOnCardsEnabled &&
							showProjectStatus &&
							!isTrashCard &&
							(reviewWorktreeSnapshot?.changedFiles ?? 0) > 0 ? (
								<Tooltip
									content={`${reviewWorktreeSnapshot!.changedFiles} uncommitted change${reviewWorktreeSnapshot!.changedFiles === 1 ? "" : "s"}`}
								>
									<span className="inline-flex items-center shrink-0">
										<span className="block size-1.5 rounded-full bg-status-red" />
									</span>
								</Tooltip>
							) : null}
							{onMigrateWorkingDirectory &&
							(columnId === "in_progress" || columnId === "review") &&
							isHovered ? (
								<Tooltip content={isSharedCheckout ? "Isolate to worktree" : "Move to main checkout"}>
									<Button
										icon={<GitBranch size={12} />}
										variant="ghost"
										size="sm"
										disabled={isMigrateLoading}
										aria-label={isSharedCheckout ? "Isolate to worktree" : "Move to main checkout"}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onMigrateWorkingDirectory(card.id, isSharedCheckout ? "isolate" : "de-isolate");
										}}
									/>
								</Tooltip>
							) : null}
							{isEditingTitle && onUpdateTitle ? (
								<InlineTitleEditor
									cardId={card.id}
									currentTitle={card.title}
									onSave={onUpdateTitle}
									onClose={closeTitleEditor}
									onRegenerate={onRegenerateTitle}
									isLlmGenerationDisabled={isLlmGenerationDisabled}
									stopEvent={stopEvent}
								/>
							) : (
								<div className="flex flex-1 items-center gap-1 min-w-0">
									<div className="flex-1 min-w-0">
										<p
											className={cn(
												"kb-line-clamp-1 m-0 font-medium text-sm",
												isTrashCard && "line-through text-text-tertiary",
											)}
										>
											{displayTitle}
										</p>
									</div>
									{isHovered && !isTrashCard ? (
										<>
											{onTogglePin ? (
												<Tooltip content={card.pinned ? "Unpin" : "Pin to top"}>
													<Button
														icon={card.pinned ? <PinOff size={12} /> : <Pin size={12} />}
														variant="ghost"
														size="sm"
														aria-label={card.pinned ? "Unpin task" : "Pin task to top"}
														onMouseDown={stopEvent}
														onClick={(event) => {
															stopEvent(event);
															onTogglePin(card.id);
														}}
													/>
												</Tooltip>
											) : null}
											{onUpdateTitle ? (
												<Button
													icon={<Pencil size={12} />}
													variant="ghost"
													size="sm"
													aria-label="Edit title"
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														openTitleEditor();
													}}
												/>
											) : null}
										</>
									) : null}
								</div>
							)}
							<BoardCardActions
								cardId={card.id}
								columnId={columnId}
								isHovered={isHovered}
								isSessionDead={isSessionDead}
								isSessionRestartable={isSessionRestartable}
								showRunningTaskEmergencyActions={showRunningTaskEmergencyActions}
								isMoveToTrashLoading={isMoveToTrashLoading}
								onStart={onStart}
								onRestartSession={onRestartSession}
								onMoveToTrash={onMoveToTrash}
								onRestoreFromTrash={onRestoreFromTrash}
								onHardDelete={onHardDelete}
								onFlagForDebug={onFlagForDebug}
							/>
						</div>
						{showSummaryOnCards && latestSummaryText ? (
							<p className="text-xs text-text-secondary line-clamp-2 mt-1 m-0">{latestSummaryText}</p>
						) : null}
						{showStatusBadge ? (
							<div className="flex items-center gap-1.5 mt-1.5">
								<Tooltip content={statusTooltip}>
									<span
										className={cn(
											"inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
											isTrashCard ? "bg-surface-3 text-text-tertiary" : statusBadgeColors[statusTagStyle],
										)}
									>
										{statusLabel}
									</span>
								</Tooltip>
								{runningActivity ? (
									<span
										className="text-text-secondary text-xs font-mono kb-line-clamp-1 min-w-0"
										style={{ overflowWrap: "anywhere" }}
									>
										{runningActivity}
									</span>
								) : null}
							</div>
						) : null}
						{showProjectStatus && reviewBranchLabel ? (
							<TruncateTooltip content={effectiveBranch ?? reviewBranchLabel} side="top">
								<p
									className="font-mono kb-line-clamp-1"
									style={{
										margin: "4px 0 0",
										fontSize: 12,
										lineHeight: 1.4,
										color: isTrashCard ? CARD_TEXT_COLOR.muted : undefined,
									}}
								>
									<GitBranch
										size={10}
										style={{
											display: "inline",
											color: isTrashCard ? CARD_TEXT_COLOR.muted : CARD_TEXT_COLOR.secondary,
											margin: "0px 4px 2px 0",
											verticalAlign: "middle",
										}}
									/>
									<span
										style={{
											color: isTrashCard ? CARD_TEXT_COLOR.muted : CARD_TEXT_COLOR.secondary,
											textDecoration: isTrashCard ? "line-through" : undefined,
										}}
									>
										{reviewBranchLabel}
									</span>
									{reviewChangeSummary && !isTrashCard ? (
										<>
											<span style={{ color: CARD_TEXT_COLOR.muted }}> · </span>
											<span style={{ color: CARD_TEXT_COLOR.muted }}>{reviewChangeSummary.filesLabel}</span>
											<span className="text-status-green"> +{reviewChangeSummary.additions}</span>
											<span className="text-status-red"> -{reviewChangeSummary.deletions}</span>
										</>
									) : null}
								</p>
							</TruncateTooltip>
						) : null}
						{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
							<Button
								size="sm"
								fill
								style={{ marginTop: 12 }}
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onCancelAutomaticAction(card.id);
								}}
							>
								{cancelAutomaticActionLabel}
							</Button>
						) : null}
					</div>
				</Tooltip>
			</div>
		);

		if (isDragging && typeof document !== "undefined") {
			return createPortal(content, document.body);
		}
		return content;
	};

	if (!draggable) {
		return renderShell();
	}

	return (
		<Draggable draggableId={card.id} index={index} isDragDisabled={false}>
			{(provided, snapshot) => renderShell(provided, snapshot)}
		</Draggable>
	);
}
