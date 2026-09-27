import { useDroppable } from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { BoardCard } from "@/components/board/board-card";
import { BoardCardConversation } from "@/components/board/board-card-conversation";
import { SortableBoardCard } from "@/components/board/sortable-board-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardReplyScope } from "@/state/board-reply-drafts";
import { useReactiveCardState, useStableCardActions } from "@/state/card-actions-context";
import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import { sortColumnCards } from "@/state/sort-column-cards";
import type { BoardCard as BoardCardModel, BoardColumnId, BoardColumn as BoardColumnModel } from "@/types";

export function BoardColumn({
	column,
	taskSessions,
	replyScope,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onCardClick,
	activeDragTaskId,
	activeDragSourceColumnId,
	activeDragTaskUnstarted,
	programmaticCardMoveInFlight,
}: {
	column: BoardColumnModel;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	replyScope?: BoardReplyScope;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	onCardClick?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	activeDragTaskUnstarted?: boolean;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
}): React.ReactElement {
	const {
		onStartTask,
		onRestartSessionTask,
		onMoveToTrashTask,
		onRestoreFromTrashTask,
		onHardDeleteTrashTask,
		onRegenerateTitleTask,
		onUpdateTaskTitle,
		onTogglePinTask,
	} = useStableCardActions();
	const { moveToTrashLoadingById, showSummaryOnCards, showSummaryOnHover, uncommittedChangesOnCardsEnabled } =
		useReactiveCardState();
	const unstartedCount = column.cards.filter((card) => card.unstarted).length;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
		activeDragTaskUnstarted,
		programmaticCardMoveInFlight,
	});
	const [trashOpen, setTrashOpen] = useState(false);
	const isTrash = column.id === "trash";
	const open = !isTrash || trashOpen;
	const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: isDropDisabled });
	const cards = sortColumnCards(column.cards, column.id);

	return (
		<section
			ref={setNodeRef}
			data-column-id={column.id}
			aria-label={column.title}
			className={cn(
				"min-w-0 rounded-xl",
				isTrash && "border border-border bg-surface-1/50",
				isOver && "ring-1 ring-accent bg-accent/5",
			)}
		>
			<div className={cn("flex min-h-9 items-center justify-between gap-2", isTrash ? "px-3 py-1" : "mb-3")}>
				{isTrash ? (
					<button
						type="button"
						aria-expanded={open}
						aria-controls="board-trash-cards"
						onClick={() => setTrashOpen((value) => !value)}
						className="flex flex-1 items-center gap-2.5 rounded py-1 text-sm text-text-secondary hover:text-text-primary"
					>
						{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
						<Trash2 size={14} />
						<span className="font-medium">Trash</span>
						<span className="text-xs text-text-tertiary">{cards.length}</span>
					</button>
				) : (
					<div className="flex items-center gap-2.5">
						<ColumnIndicator columnId={column.id} />
						<h2 className="text-sm font-semibold">{column.title}</h2>
						<span className="rounded bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">{cards.length}</span>
					</div>
				)}
				{canClearTrash ? (
					<Button
						icon={<Trash2 size={13} />}
						variant="ghost"
						size="sm"
						onClick={onClearTrash}
						disabled={!cards.some((card) => !card.pinned)}
						aria-label="Clear trash"
					>
						Clear trash
					</Button>
				) : null}
			</div>
			{open ? (
				<SortableContext
					items={cards.filter((card) => card.id !== editingTaskId).map((card) => card.id)}
					strategy={rectSortingStrategy}
				>
					<div
						id={isTrash ? "board-trash-cards" : undefined}
						className={cn("kb-board-grid", isTrash && "p-3 pt-1")}
					>
						{cards.map((card, index) => (
							<Fragment key={card.id}>
								{column.id === "review" && card.unstarted && !cards[index - 1]?.unstarted ? (
									<div
										className="col-span-full flex items-center gap-2 pt-2 text-xs text-text-secondary"
										data-unstarted-heading
									>
										<span>Unstarted</span>
										<span>{unstartedCount}</span>
										<span className="h-px flex-1 bg-border" />
									</div>
								) : null}
								{card.unstarted && editingTaskId === card.id ? (
									<div key={card.id} data-task-id={card.id} data-column-id={column.id}>
										{inlineTaskEditor}
									</div>
								) : (
									<SortableBoardCard
										key={card.id}
										id={card.id}
										title={card.title || "task"}
										dropDisabled={isDropDisabled}
									>
										{(handle) => (
											<BoardCard
												key={card.id}
												draggable={false}
												rich={column.id !== "trash"}
												dragHandle={handle}
												conversation={
													column.id !== "trash"
														? (statusBadges) => (
																<BoardCardConversation
																	card={card}
																	columnId={column.id}
																	summary={taskSessions[card.id]}
																	replyScope={replyScope}
																	statusBadges={statusBadges}
																/>
															)
														: undefined
												}
												card={card}
												index={index}
												columnId={column.id}
												sessionSummary={taskSessions[card.id]}
												onStart={onStartTask}
												onRestartSession={onRestartSessionTask}
												onMoveToTrash={onMoveToTrashTask}
												onRestoreFromTrash={onRestoreFromTrashTask}
												onHardDelete={onHardDeleteTrashTask}
												onRegenerateTitle={onRegenerateTitleTask}
												onUpdateTitle={onUpdateTaskTitle}
												onTogglePin={onTogglePinTask}
												isMoveToTrashLoading={moveToTrashLoadingById[card.id] ?? false}
												showSummaryOnCards={showSummaryOnCards}
												showSummaryOnHover={showSummaryOnHover}
												uncommittedChangesOnCardsEnabled={uncommittedChangesOnCardsEnabled}
												onClick={() => {
													if (column.id === "review" && card.unstarted) {
														onEditTask?.(card);
														return;
													}
													onCardClick?.(card);
												}}
											/>
										)}
									</SortableBoardCard>
								)}
							</Fragment>
						))}
					</div>
					{cards.length === 0 ? (
						<div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-text-tertiary">
							{isTrash
								? "Trash is empty."
								: column.id === "in_progress"
									? "No tasks in progress. Create a task to get started."
									: "All caught up. Tasks appear here when they're ready for you."}
						</div>
					) : null}
				</SortableContext>
			) : null}
		</section>
	);
}
