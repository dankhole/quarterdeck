import { Droppable } from "@hello-pangea/dnd";
import { Play, Plus, Trash2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { BoardCard } from "@/components/board/board-card";
import { Button } from "@/components/ui/button";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useReactiveCardState, useStableCardActions } from "@/state/card-actions-context";
import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import { sortColumnCards } from "@/state/sort-column-cards";
import type { BoardCard as BoardCardModel, BoardColumnId, BoardColumn as BoardColumnModel } from "@/types";

export function BoardColumn({
	column,
	taskSessions,
	onCreateTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onCardClick,
	activeDragTaskId,
	activeDragSourceColumnId,
	activeDragTaskUnstarted,
	programmaticCardMoveInFlight,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	dependencySourceTaskId,
	dependencyTargetTaskId,
	isDependencyLinking,
}: {
	column: BoardColumnModel;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	onCardClick?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	activeDragTaskUnstarted?: boolean;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	onDependencyPointerDown?: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	dependencySourceTaskId?: string | null;
	dependencyTargetTaskId?: string | null;
	isDependencyLinking?: boolean;
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
		onTerminalWarmup,
		onTerminalCancelWarmup,
	} = useStableCardActions();
	const { moveToTrashLoadingById, showSummaryOnCards, showSummaryOnHover, uncommittedChangesOnCardsEnabled } =
		useReactiveCardState();
	const canCreate = column.id === "review" && onCreateTask;
	const unstartedCount = column.cards.filter((card) => card.unstarted).length;
	const canStartAllTasks = column.id === "review" && onStartAllTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const cardDropType = "CARD";
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
		activeDragTaskUnstarted,
		programmaticCardMoveInFlight,
	});
	const createTaskButtonText = (
		<span className="inline-flex items-center gap-1.5">
			<span>Create task</span>
			<span aria-hidden className="text-text-secondary">
				(c)
			</span>
		</span>
	);

	return (
		<section
			data-column-id={column.id}
			className="flex flex-col min-w-0 min-h-0 bg-surface-1 rounded-lg overflow-hidden"
			style={{
				flex: "1 1 0",
			}}
		>
			<div className="flex flex-col min-h-0" style={{ flex: "1 1 0" }}>
				<div
					className="flex items-center justify-between"
					style={{
						height: 40,
						padding: "0 12px",
					}}
				>
					<div className="flex items-center gap-2">
						<ColumnIndicator columnId={column.id} />
						<span className="font-semibold text-sm">{column.title}</span>
						<span className="text-text-secondary text-xs">{column.cards.length}</span>
					</div>
					{canStartAllTasks ? (
						<Button
							icon={<Play size={14} />}
							variant="ghost"
							size="sm"
							onClick={onStartAllTasks}
							disabled={unstartedCount === 0}
							aria-label="Start all unstarted tasks"
							title={unstartedCount > 0 ? "Start all unstarted tasks" : "No unstarted tasks"}
						/>
					) : null}
					{canClearTrash ? (
						<Button
							icon={<Trash2 size={14} />}
							variant="ghost"
							size="sm"
							className="text-status-red hover:text-status-red"
							onClick={onClearTrash}
							disabled={column.cards.length === 0}
							aria-label="Clear trash"
							title={column.cards.length > 0 ? "Clear trash permanently" : "Trash is empty"}
						/>
					) : null}
				</div>

				<Droppable droppableId={column.id} type={cardDropType} isDropDisabled={isDropDisabled}>
					{(cardProvided) => (
						<div ref={cardProvided.innerRef} {...cardProvided.droppableProps} className="kb-column-cards">
							{canCreate ? (
								<Button
									icon={<Plus size={14} />}
									aria-label="Create task"
									fill
									onClick={onCreateTask}
									style={{ marginBottom: 6, flexShrink: 0 }}
								>
									{createTaskButtonText}
								</Button>
							) : null}

							{(() => {
								const items: ReactNode[] = [];
								let draggableIndex = 0;
								const cards = sortColumnCards(column.cards, column.id);
								let unstartedSectionShown = false;
								for (const card of cards) {
									if (column.id === "review" && card.unstarted && !unstartedSectionShown) {
										unstartedSectionShown = true;
										items.push(
											<div
												key="unstarted-heading"
												className="flex items-center gap-2 px-1 pb-2 pt-3 text-xs text-text-secondary"
												data-unstarted-heading
											>
												<span>Unstarted</span>
												<span className="text-text-tertiary">{unstartedCount}</span>
												<span className="h-px flex-1 bg-border" />
											</div>,
										);
									}
									if (column.id === "review" && card.unstarted && editingTaskId === card.id) {
										items.push(
											<div
												key={card.id}
												data-task-id={card.id}
												data-column-id={column.id}
												style={{ marginBottom: 6 }}
											>
												{inlineTaskEditor}
											</div>,
										);
										continue;
									}
									items.push(
										<BoardCard
											key={card.id}
											card={card}
											index={draggableIndex}
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
											onDependencyPointerDown={onDependencyPointerDown}
											onDependencyPointerEnter={onDependencyPointerEnter}
											isDependencySource={dependencySourceTaskId === card.id}
											isDependencyTarget={dependencyTargetTaskId === card.id}
											isDependencyLinking={isDependencyLinking}
											showSummaryOnCards={showSummaryOnCards}
											showSummaryOnHover={showSummaryOnHover}
											uncommittedChangesOnCardsEnabled={uncommittedChangesOnCardsEnabled}
											onTerminalWarmup={onTerminalWarmup}
											onTerminalCancelWarmup={onTerminalCancelWarmup}
											onClick={() => {
												if (column.id === "review" && card.unstarted) {
													onEditTask?.(card);
													return;
												}
												onCardClick?.(card);
											}}
										/>,
									);
									draggableIndex += 1;
								}
								return items;
							})()}
							{cardProvided.placeholder}
						</div>
					)}
				</Droppable>
			</div>
		</section>
	);
}
