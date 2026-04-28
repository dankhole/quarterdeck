import { Draggable, type DraggableProvided, type DraggableStateSnapshot } from "@hello-pangea/dnd";
import { AlertCircle, GitBranch, Pencil, Pin, PinOff, RotateCw } from "lucide-react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import { BoardCardActions } from "@/components/board/board-card-actions";
import { InlineTitleEditor } from "@/components/task/inline-title-editor";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TruncateTooltip } from "@/components/ui/tooltip";
import { useBoardCard } from "@/hooks/board/use-board-card";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { CARD_TEXT_COLOR } from "@/utils/board-card-display";
import { statusBadgeColors } from "@/utils/session-status";

export { getCardHoverTooltip } from "@/utils/board-card-display";

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
	onClick,
	onDoubleClick,
	onStart,
	onRestartSession,
	onMoveToTrash,
	onRestoreFromTrash,
	onHardDelete,
	onRegenerateTitle,
	isLlmGenerationDisabled,
	onUpdateTitle,
	onTogglePin,
	isMoveToTrashLoading = false,
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
	onClick?: () => void;
	onDoubleClick?: () => void;
	onStart?: (taskId: string) => void;
	onRestartSession?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onHardDelete?: (taskId: string) => void;
	onRegenerateTitle?: (taskId: string) => void;
	isLlmGenerationDisabled?: boolean;
	onUpdateTitle?: (taskId: string, title: string) => void;
	onTogglePin?: (taskId: string) => void;
	isMoveToTrashLoading?: boolean;
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
	const {
		reviewWorktreeSnapshot,
		isHovered,
		setIsHovered,
		hoverTimerRef,
		isEditingTitle,
		openTitleEditor,
		closeTitleEditor,
		isTrashCard,
		isCardInteractive,
		isSharedCheckout,
		isSessionPathDiverged,
		displayTitle,
		statusLabel,
		statusTagStyle,
		statusTooltip,
		showStatusBadge,
		runningActivity,
		latestSummaryText,
		effectiveTooltip,
		isSessionDead,
		isSessionRestartable,
		statusMarker,
		showProjectStatus,
		reviewBranchLabel,
		reviewBranchTooltip,
		reviewChangeSummary,
		showUncommittedChangesIndicator,
	} = useBoardCard({
		card,
		columnId,
		sessionSummary,
		showSummaryOnCards,
		uncommittedChangesOnCardsEnabled,
		onRestartSession,
	});
	const statusBadgeClass = isTrashCard ? "bg-surface-3 text-text-tertiary" : statusBadgeColors[statusTagStyle!];

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
							{isSessionPathDiverged ? (
								<Tooltip content="Agent session was launched from a different directory than this task's assigned identity. Restart the task to realign it.">
									<AlertCircle size={12} className="shrink-0 text-status-orange" />
								</Tooltip>
							) : null}
							{showUncommittedChangesIndicator ? (
								<Tooltip
									content={`${reviewWorktreeSnapshot!.changedFiles} uncommitted change${reviewWorktreeSnapshot!.changedFiles === 1 ? "" : "s"}`}
								>
									<span className="inline-flex items-center shrink-0">
										<span className="block size-1.5 rounded-full bg-status-red" />
									</span>
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
								isMoveToTrashLoading={isMoveToTrashLoading}
								onStart={onStart}
								onRestartSession={onRestartSession}
								onMoveToTrash={onMoveToTrash}
								onRestoreFromTrash={onRestoreFromTrash}
								onHardDelete={onHardDelete}
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
											statusBadgeClass,
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
							<TruncateTooltip content={reviewBranchTooltip ?? reviewBranchLabel} side="top">
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
