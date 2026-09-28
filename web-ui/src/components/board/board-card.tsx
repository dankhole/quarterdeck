import { Draggable, type DraggableProvided, type DraggableStateSnapshot } from "@hello-pangea/dnd";
import { TASK_CARD_COLORS, taskColorSeed } from "@runtime-contract";
import { AlertCircle, GitBranch, Info, Pencil, Pin, PinOff, RotateCw } from "lucide-react";
import { type MouseEvent, memo, type ReactNode } from "react";
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

export const BoardCard = memo(function BoardCard({
	card,
	index,
	columnId,
	sessionSummary,
	selected = false,
	showSummaryOnCards = false,
	showSummaryOnHover = true,
	uncommittedChangesOnCardsEnabled = false,
	onClick,
	onDoubleClick,
	onStart,
	onRestartSession,
	onMoveToTrash,
	onRestoreFromTrash,
	onHardDelete,
	onRegenerateTitle,
	onUpdateTitle,
	onTogglePin,
	isMoveToTrashLoading = false,
	onTerminalWarmup,
	onTerminalCancelWarmup,
	draggable = true,
	rich = false,
	dragHandle,
	conversation,
}: {
	card: BoardCardModel;
	index: number;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	selected?: boolean;
	showSummaryOnCards?: boolean;
	showSummaryOnHover?: boolean;
	uncommittedChangesOnCardsEnabled?: boolean;
	onClick?: () => void;
	onDoubleClick?: () => void;
	onStart?: (taskId: string) => void;
	onRestartSession?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onHardDelete?: (taskId: string) => void;
	onRegenerateTitle?: (taskId: string) => void;
	onUpdateTitle?: (taskId: string, title: string) => void;
	onTogglePin?: (taskId: string) => void;
	isMoveToTrashLoading?: boolean;
	onTerminalWarmup?: (taskId: string) => void;
	onTerminalCancelWarmup?: (taskId: string) => void;
	draggable?: boolean;
	rich?: boolean;
	dragHandle?: ReactNode;
	conversation?: (statusBadges: ReactNode) => ReactNode;
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
		latestSummaryText,
		effectiveTooltip,
		isSessionDead,
		isSessionRestartable,
		statusMarker,
		showProjectStatus,
		reviewBranchLabel,
		reviewBranchTooltip,
		showDetachedWorktreeHint,
		reviewChangeSummary,
		showUncommittedChangesIndicator,
		agentBadge,
	} = useBoardCard({
		card,
		columnId,
		sessionSummary,
		showSummaryOnCards,
		showSummaryOnHover,
		uncommittedChangesOnCardsEnabled,
		onRestartSession,
	});
	const cardColor = TASK_CARD_COLORS[card.colorIndex ?? taskColorSeed(card.id)];
	const statusBadgeClass = isTrashCard ? "bg-surface-3 text-text-tertiary" : statusBadgeColors[statusTagStyle!];

	const statusBadges =
		isSharedCheckout || showStatusBadge || agentBadge ? (
			<div className={cn("flex flex-wrap items-center gap-1.5", !rich && "mt-1.5")} data-board-card-status-row>
				{isSharedCheckout ? (
					<Tooltip content="Running in shared checkout (not isolated)">
						<span className="inline-flex items-center shrink-0 rounded bg-status-red/15 px-1 py-px text-[10px] font-medium text-status-red leading-tight">
							Shared
						</span>
					</Tooltip>
				) : null}
				{showStatusBadge ? (
					<Tooltip content={statusTooltip}>
						<span
							className={cn(
								"inline-flex shrink-0 items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium leading-tight",
								statusBadgeClass,
							)}
							data-board-card-status-badge
						>
							{statusLabel}
						</span>
					</Tooltip>
				) : null}
				{agentBadge ? (
					<Tooltip content={agentBadge.tooltip}>
						<span
							className="inline-flex shrink-0 items-center whitespace-nowrap rounded bg-surface-3 px-1.5 py-0.5 text-xs font-medium text-text-secondary leading-tight"
							data-board-card-agent-badge
						>
							{agentBadge.label}
						</span>
					</Tooltip>
				) : null}
			</div>
		) : null;

	const renderBranchStatus = () => {
		if (!showProjectStatus || !reviewBranchLabel) {
			return null;
		}

		const content = (
			<p
				className="font-mono kb-line-clamp-1"
				style={{
					margin: "4px 0 0",
					fontSize: 12,
					lineHeight: 1.4,
					color: isTrashCard ? CARD_TEXT_COLOR.muted : undefined,
				}}
			>
				{reviewChangeSummary && !isTrashCard ? (
					<>
						<span style={{ color: CARD_TEXT_COLOR.muted }}>{reviewChangeSummary.filesLabel}</span>
						<span className="text-status-green"> +{reviewChangeSummary.additions}</span>
						<span className="text-status-red"> -{reviewChangeSummary.deletions}</span>
						<span style={{ color: CARD_TEXT_COLOR.muted }}> · </span>
					</>
				) : null}
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
				{showDetachedWorktreeHint && !isTrashCard ? (
					<Info
						size={10}
						aria-label="Detached worktree"
						className="ml-1 inline text-text-tertiary"
						style={{ verticalAlign: -1 }}
					/>
				) : null}
			</p>
		);

		return showDetachedWorktreeHint ? (
			<Tooltip content={reviewBranchTooltip} side="top">
				{content}
			</Tooltip>
		) : (
			<TruncateTooltip content={reviewBranchTooltip ?? reviewBranchLabel} side="top">
				{content}
			</TruncateTooltip>
		);
	};

	const renderShell = (provided?: DraggableProvided, snapshot?: DraggableStateSnapshot) => {
		const isDragging = snapshot?.isDragging ?? false;
		const content = (
			<div
				ref={provided?.innerRef}
				{...(provided?.draggableProps ?? {})}
				{...(provided?.dragHandleProps ?? {})}
				className={cn("kb-board-card-shell", rich && "h-full")}
				data-task-id={card.id}
				data-column-id={columnId}
				data-selected={selected}
				{...(rich && isCardInteractive ? { role: "link", tabIndex: 0, "aria-label": `Open ${displayTitle}` } : {})}
				onKeyDown={(event) => {
					if (rich && isCardInteractive && event.target === event.currentTarget && event.key === "Enter") {
						event.preventDefault();
						onClick?.();
					}
				}}
				onClick={(event) => {
					if (!isCardInteractive) {
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
					if (!isCardInteractive || isDragging) {
						return;
					}
					if (event.metaKey || event.ctrlKey) {
						return;
					}
					onDoubleClick?.();
				}}
				style={{
					...(provided?.draggableProps?.style ?? {}),
					marginBottom: rich ? 0 : 6,
					cursor: draggable ? "grab" : undefined,
				}}
				onMouseEnter={() => {
					hoverTimerRef.current = setTimeout(() => setIsHovered(true), 200);
					if (!card.unstarted) onTerminalWarmup?.(card.id);
				}}
				onMouseLeave={() => {
					if (hoverTimerRef.current) {
						clearTimeout(hoverTimerRef.current);
						hoverTimerRef.current = null;
					}
					setIsHovered(false);
					if (!card.unstarted) onTerminalCancelWarmup?.(card.id);
				}}
			>
				<Tooltip content={rich ? undefined : (effectiveTooltip ?? undefined)} side="top">
					<div
						style={{
							backgroundColor: `color-mix(in srgb, ${cardColor} ${isHovered ? 11 : 7}%, var(--color-surface-1))`,
							borderColor: `color-mix(in srgb, ${cardColor} 18%, var(--color-border))`,
						}}
						className={cn(
							"rounded-md border p-2.5 transition-colors",
							rich && "flex h-full flex-col rounded-xl !p-3",
							isCardInteractive && "cursor-pointer",
							isDragging && "shadow-lg",
						)}
					>
						<div
							className="flex min-w-0 flex-nowrap items-center gap-x-1"
							data-board-card-header
							style={{ minHeight: 24 }}
						>
							{statusMarker === "restart" ? (
								<div className="inline-flex shrink-0 items-center">
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
								<div className="inline-flex shrink-0 items-center">
									<Spinner size={12} />
								</div>
							) : null}
							{card.pinned ? (
								<Tooltip content={isTrashCard ? "Pinned — protected from deletion" : "Pinned to top"}>
									<span className="inline-flex items-center shrink-0 text-text-secondary">
										<Pin size={12} />
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
									stopEvent={stopEvent}
								/>
							) : (
								<div className="min-w-0 flex-1 basis-0" data-board-card-title>
									<p
										className={cn(
											"truncate m-0",
											rich ? "font-semibold text-[15px] leading-6" : "font-medium text-sm",
											isTrashCard && "line-through text-text-tertiary",
										)}
									>
										{displayTitle}
									</p>
								</div>
							)}
							<div
								className="ml-auto flex w-max min-w-0 max-w-full shrink flex-wrap items-center justify-end gap-0.5 [&>button]:h-[22px] [&>button]:shrink-0 [&>button]:px-0"
								data-board-card-action-rail
							>
								{!isEditingTitle && (rich || isHovered || isTrashCard) ? (
									<>
										{onTogglePin ? (
											<Tooltip
												content={card.pinned ? "Unpin" : isTrashCard ? "Keep in Trash" : "Pin to top"}
											>
												<Button
													icon={card.pinned ? <PinOff size={12} /> : <Pin size={12} />}
													variant="ghost"
													size="sm"
													aria-label={
														card.pinned
															? "Unpin task"
															: isTrashCard
																? "Pin task in trash"
																: "Pin task to top"
													}
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														onTogglePin(card.id);
													}}
												/>
											</Tooltip>
										) : null}
										{onUpdateTitle && !isTrashCard ? (
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
								{dragHandle}
								<BoardCardActions
									cardId={card.id}
									columnId={columnId}
									isUnstarted={card.unstarted === true}
									isHovered={rich || isHovered}
									isSessionDead={isSessionDead}
									isSessionRestartable={isSessionRestartable}
									isMoveToTrashLoading={isMoveToTrashLoading}
									onStart={onStart}
									onRestartSession={onRestartSession}
									onMoveToTrash={onMoveToTrash}
									onRestoreFromTrash={onRestoreFromTrash}
									onHardDelete={card.pinned ? undefined : onHardDelete}
								/>
							</div>
						</div>
						{!rich && showSummaryOnCards && latestSummaryText ? (
							<p className="text-xs text-text-secondary line-clamp-2 mt-1 m-0">{latestSummaryText}</p>
						) : null}
						{!rich && statusBadges}
						{renderBranchStatus()}
						{conversation?.(statusBadges)}
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
});
