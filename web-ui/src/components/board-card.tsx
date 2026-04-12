import { Draggable } from "@hello-pangea/dnd";
import { AlertCircle, GitBranch, Pencil, Pin, PinOff, Play, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { InlineTitleEditor } from "@/components/inline-title-editor";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getWorkspacePath, useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import { describeSessionState, getSessionStatusBadgeStyle, statusBadgeColors } from "@/utils/session-status";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

const CARD_TEXT_COLOR = {
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

function shortenBranchName(branch: string): string {
	return branch.replace(/^(?:feature|fix|chore|hotfix|bugfix|release|refactor|feat)\//i, "") || branch;
}

function extractToolInputSummaryFromActivityText(activityText: string, toolName: string): string | null {
	const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = activityText.match(
		new RegExp(`^(?:Using|Completed|Failed|Calling)\\s+${escapedToolName}(?::\\s*(.+))?$`),
	);
	if (!match) {
		return null;
	}
	const rawSummary = match[1]?.trim() ?? "";
	if (!rawSummary) {
		return null;
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return operationSummary?.trim() || null;
	}
	return rawSummary;
}

function parseToolCallFromActivityText(
	activityText: string,
): { toolName: string; toolInputSummary: string | null } | null {
	const match = activityText.match(/^(?:Using|Completed|Failed|Calling)\s+([^:()]+?)(?::\s*(.+))?$/);
	if (!match?.[1]) {
		return null;
	}
	const toolName = match[1].trim();
	if (!toolName) {
		return null;
	}
	const rawSummary = match[2]?.trim() ?? "";
	if (!rawSummary) {
		return { toolName, toolInputSummary: null };
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return {
			toolName,
			toolInputSummary: operationSummary?.trim() || null,
		};
	}
	return {
		toolName,
		toolInputSummary: rawSummary,
	};
}

function resolveToolCallLabel(
	activityText: string | undefined,
	toolName: string | null,
	toolInputSummary: string | null,
): string | null {
	if (toolName) {
		const summary = toolInputSummary ?? extractToolInputSummaryFromActivityText(activityText ?? "", toolName);
		return summary ? `${toolName}(${summary})` : toolName;
	}
	if (!activityText) {
		return null;
	}
	const parsed = parseToolCallFromActivityText(activityText);
	if (!parsed) {
		return null;
	}
	return parsed.toolInputSummary ? `${parsed.toolName}(${parsed.toolInputSummary})` : parsed.toolName;
}

const TOOLTIP_MAX_LENGTH = 80;

/** Tooltip content for card hover: displaySummary if available, fallback text otherwise. */
export function getCardHoverTooltip(summary: RuntimeTaskSessionSummary | undefined): string | null {
	if (!summary) {
		return null;
	}

	// displaySummary is the single canonical text — already truncated to 80 chars.
	// Show it regardless of state (running, review, etc.).
	if (summary.displaySummary) {
		return summary.displaySummary;
	}

	// Fallback for sessions that predate the displaySummary field: use the last
	// conversation summary entry, truncated.
	if (summary.conversationSummaries.length > 0) {
		const last = summary.conversationSummaries[summary.conversationSummaries.length - 1];
		const text = last?.text?.trim();
		if (text) {
			return text.length > TOOLTIP_MAX_LENGTH ? `${text.slice(0, TOOLTIP_MAX_LENGTH)}\u2026` : text;
		}
	}
	return null;
}

/** Short activity label for running cards (e.g. "Reading src/auth.ts"). */
function getRunningActivityLabel(summary: RuntimeTaskSessionSummary | undefined): string | null {
	if (!summary || summary.state !== "running") {
		return null;
	}
	const hookActivity = summary.latestHookActivity;
	if (!hookActivity) {
		return null;
	}
	const activityText = hookActivity.activityText?.trim();
	const toolName = hookActivity.toolName?.trim() ?? null;
	const toolInputSummary = hookActivity.toolInputSummary?.trim() ?? null;
	if (activityText) {
		const toolCallLabel = resolveToolCallLabel(activityText, toolName, toolInputSummary);
		if (toolCallLabel) {
			return toolCallLabel;
		}
		if (activityText === "Agent active" || activityText === "Working on task" || activityText.startsWith("Resumed")) {
			return null;
		}
		if (activityText.startsWith("Agent: ")) {
			return activityText.slice(7);
		}
		return activityText;
	}
	return null;
}

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
	onDependencyPointerDown,
	onDependencyPointerEnter,
	onRequestDisplaySummary,
	isDependencySource = false,
	isDependencyTarget = false,
	isDependencyLinking = false,
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
	onRequestDisplaySummary?: (taskId: string) => void;
	onDependencyPointerDown?: (taskId: string, event: MouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	isDependencySource?: boolean;
	isDependencyTarget?: boolean;
	isDependencyLinking?: boolean;
}): React.ReactElement {
	const [isHovered, setIsHovered] = useState(false);
	const [isEditingTitle, setIsEditingTitle] = useState(false);

	const openTitleEditor = useCallback(() => setIsEditingTitle(true), []);
	const closeTitleEditor = useCallback(() => setIsEditingTitle(false), []);

	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(card.id);
	const isTrashCard = columnId === "trash";
	const isCardInteractive = !isTrashCard;

	// Derive shared-checkout state from metadata snapshot path when available,
	// falling back to card.useWorktree for tasks that haven't started yet.
	const isSharedCheckout = useMemo(() => {
		const wsPath = getWorkspacePath();
		if (reviewWorkspaceSnapshot?.path && wsPath) {
			return reviewWorkspaceSnapshot.path === wsPath;
		}
		return card.useWorktree === false;
	}, [reviewWorkspaceSnapshot?.path, card.useWorktree]);

	// Warn when the agent session is running in a different directory than the
	// card's working directory. This can happen after migration edge cases or
	// if the persisted state drifts from reality.
	// TODO: Add a force-restart button that calls startTaskSession to restart
	// the agent at the correct CWD. Currently no explicit restart UI exists.
	const isCwdDiverged = useMemo(() => {
		if (!sessionSummary?.workspacePath || !reviewWorkspaceSnapshot?.path) return false;
		if (sessionSummary.state !== "running" && sessionSummary.state !== "awaiting_review") return false;
		return sessionSummary.workspacePath !== reviewWorkspaceSnapshot.path;
	}, [sessionSummary?.workspacePath, sessionSummary?.state, reviewWorkspaceSnapshot?.path]);

	const displayTitle = card.title || truncateTaskPromptLabel(card.prompt);

	const statusLabel = sessionSummary ? describeSessionState(sessionSummary) : null;
	const statusTagStyle = sessionSummary ? getSessionStatusBadgeStyle(sessionSummary) : null;
	const showStatusBadge = statusLabel && statusTagStyle && columnId !== "backlog" && !isTrashCard;

	const runningActivity = useMemo(() => getRunningActivityLabel(sessionSummary), [sessionSummary]);
	const cardHoverTooltip = useMemo(() => getCardHoverTooltip(sessionSummary), [sessionSummary]);

	const latestSummaryText = sessionSummary?.displaySummary ?? null;

	// Don't show the tooltip if the summary is already visible on the card face.
	const isSummaryVisibleOnCard = showSummaryOnCards && !!latestSummaryText;
	const effectiveTooltip = isSummaryVisibleOnCard ? null : cardHoverTooltip;

	const isSessionDead =
		!sessionSummary ||
		sessionSummary.state === "idle" ||
		sessionSummary.state === "failed" ||
		sessionSummary.state === "interrupted" ||
		(sessionSummary.state === "awaiting_review" && sessionSummary.reviewReason === "error");

	// Delay showing the restart button by ~1s so it doesn't flash during
	// transient dead states (hydration, brief exits before auto-restart).
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
	const showWorkspaceStatus = columnId === "in_progress" || columnId === "review" || isTrashCard;
	const effectiveBranch =
		reviewWorkspaceSnapshot?.branch ?? (reviewWorkspaceSnapshot?.isDetached ? null : card.branch) ?? null;
	const reviewBranchLabel = effectiveBranch
		? shortenBranchName(effectiveBranch)
		: (reviewWorkspaceSnapshot?.headCommit?.slice(0, 8) ?? null);
	const reviewChangeSummary = reviewWorkspaceSnapshot
		? reviewWorkspaceSnapshot.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorkspaceSnapshot.changedFiles} ${reviewWorkspaceSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorkspaceSnapshot.additions ?? 0,
					deletions: reviewWorkspaceSnapshot.deletions ?? 0,
				}
		: null;
	const cancelAutomaticActionLabel =
		!isTrashCard && card.autoReviewEnabled ? getTaskAutoReviewCancelButtonLabel(card.autoReviewMode) : null;

	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<Draggable draggableId={card.id} index={index} isDragDisabled={false}>
			{(provided, snapshot) => {
				const isDragging = snapshot.isDragging;
				const draggableContent = (
					<div
						ref={provided.innerRef}
						{...provided.draggableProps}
						{...provided.dragHandleProps}
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
							if (!snapshot.isDragging && onClick) {
								onClick();
							}
						}}
						onDoubleClick={(event) => {
							if (!isCardInteractive || isDependencyLinking || snapshot.isDragging) {
								return;
							}
							if (event.metaKey || event.ctrlKey) {
								return;
							}
							onDoubleClick?.();
						}}
						style={{
							...provided.draggableProps.style,
							marginBottom: 6,
							cursor: "grab",
						}}
						onMouseEnter={() => {
							setIsHovered(true);
							onDependencyPointerEnter?.(card.id);
							onRequestDisplaySummary?.(card.id);
						}}
						onMouseMove={() => {
							if (!isDependencyLinking) {
								return;
							}
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseLeave={() => setIsHovered(false)}
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
									showWorkspaceStatus &&
									!isTrashCard &&
									(reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0 ? (
										<Tooltip
											content={`${reviewWorkspaceSnapshot!.changedFiles} uncommitted change${reviewWorkspaceSnapshot!.changedFiles === 1 ? "" : "s"}`}
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
									{columnId === "in_progress" &&
									showRunningTaskEmergencyActions &&
									!isSessionDead &&
									isHovered ? (
										<>
											{onRestartSession ? (
												<Tooltip content="Force restart session">
													<Button
														icon={<RotateCw size={12} />}
														variant="ghost"
														size="sm"
														className="text-status-orange hover:text-text-primary"
														aria-label="Force restart agent session"
														onMouseDown={stopEvent}
														onClick={(event) => {
															stopEvent(event);
															onRestartSession(card.id);
														}}
													/>
												</Tooltip>
											) : null}
											<Tooltip content="Force trash task">
												<Button
													icon={isMoveToTrashLoading ? <Spinner size={13} /> : <Trash2 size={13} />}
													variant="ghost"
													size="sm"
													className="text-status-red hover:text-text-primary"
													disabled={isMoveToTrashLoading}
													aria-label="Force move task to trash"
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														onMoveToTrash?.(card.id);
													}}
												/>
											</Tooltip>
										</>
									) : columnId === "backlog" ? (
										<Button
											icon={<Play size={14} />}
											variant="ghost"
											size="sm"
											aria-label="Start task"
											onMouseDown={stopEvent}
											onClick={(event) => {
												stopEvent(event);
												onStart?.(card.id);
											}}
										/>
									) : columnId === "review" ? (
										<>
											{isSessionRestartable && onRestartSession ? (
												<Tooltip content="Restart session">
													<Button
														icon={<RotateCw size={12} />}
														variant="ghost"
														size="sm"
														aria-label="Restart agent session"
														onMouseDown={stopEvent}
														onClick={(event) => {
															stopEvent(event);
															onRestartSession(card.id);
														}}
													/>
												</Tooltip>
											) : null}
											<Button
												icon={isMoveToTrashLoading ? <Spinner size={13} /> : <Trash2 size={13} />}
												variant="ghost"
												size="sm"
												disabled={isMoveToTrashLoading}
												aria-label="Move task to trash"
												onMouseDown={stopEvent}
												onClick={(event) => {
													stopEvent(event);
													onMoveToTrash?.(card.id);
												}}
											/>
										</>
									) : columnId === "trash" ? (
										<>
											<Tooltip
												side="bottom"
												content={
													<>
														Restore session
														<br />
														in new workspace
													</>
												}
											>
												<Button
													icon={<RotateCcw size={12} />}
													variant="ghost"
													size="sm"
													aria-label="Restore task from trash"
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														onRestoreFromTrash?.(card.id);
													}}
												/>
											</Tooltip>
											<Tooltip side="bottom" content="Delete permanently">
												<Button
													icon={<Trash2 size={12} />}
													variant="ghost"
													size="sm"
													className="text-status-red hover:text-status-red"
													aria-label="Delete task permanently"
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														onHardDelete?.(card.id);
													}}
												/>
											</Tooltip>
										</>
									) : null}
								</div>
								{showSummaryOnCards && latestSummaryText ? (
									<p className="text-xs text-text-secondary line-clamp-2 mt-1 m-0">{latestSummaryText}</p>
								) : null}
								{showStatusBadge ? (
									<div className="flex items-center gap-1.5 mt-1.5">
										<span
											className={cn(
												"inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
												isTrashCard ? "bg-surface-3 text-text-tertiary" : statusBadgeColors[statusTagStyle],
											)}
										>
											{statusLabel}
										</span>
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
								{showWorkspaceStatus && reviewBranchLabel ? (
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
												<span style={{ color: CARD_TEXT_COLOR.muted }}>
													{reviewChangeSummary.filesLabel}
												</span>
												<span className="text-status-green"> +{reviewChangeSummary.additions}</span>
												<span className="text-status-red"> -{reviewChangeSummary.deletions}</span>
											</>
										) : null}
									</p>
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
					return createPortal(draggableContent, document.body);
				}
				return draggableContent;
			}}
		</Draggable>
	);
}
