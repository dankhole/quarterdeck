import { Droppable } from "@hello-pangea/dnd";
import { Play, Plus, Trash2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { BoardCard } from "@/components/board-card";
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
		onCancelAutomaticTaskAction,
		onRegenerateTitleTask,
		onUpdateTaskTitle,
		onTogglePinTask,
		onMigrateWorkingDirectory,
		onRequestDisplaySummary,
	} = useStableCardActions();
	const {
		moveToTrashLoadingById,
		migratingTaskId,
		isLlmGenerationDisabled,
		showSummaryOnCards,
		uncommittedChangesOnCardsEnabled,
	} = useReactiveCardState();
	const canCreate = column.id === "backlog" && onCreateTask;
	const canStartAllTasks = column.id === "backlog" && onStartAllTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const cardDropType = "CARD";
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
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
							disabled={column.cards.length === 0}
							aria-label="Start all backlog tasks"
							title={column.cards.length > 0 ? "Start all backlog tasks" : "Backlog is empty"}
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
								for (const card of cards) {
									if (column.id === "backlog" && editingTaskId === card.id) {
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
											onCancelAutomaticAction={onCancelAutomaticTaskAction}
											onRegenerateTitle={onRegenerateTitleTask}
											isLlmGenerationDisabled={isLlmGenerationDisabled}
											onUpdateTitle={onUpdateTaskTitle}
											onTogglePin={onTogglePinTask}
											isMoveToTrashLoading={moveToTrashLoadingById[card.id] ?? false}
											onDependencyPointerDown={onDependencyPointerDown}
											onDependencyPointerEnter={onDependencyPointerEnter}
											isDependencySource={dependencySourceTaskId === card.id}
											isDependencyTarget={dependencyTargetTaskId === card.id}
											onMigrateWorkingDirectory={onMigrateWorkingDirectory}
											isMigrateLoading={migratingTaskId === card.id}
											isDependencyLinking={isDependencyLinking}
											showSummaryOnCards={showSummaryOnCards}
											uncommittedChangesOnCardsEnabled={uncommittedChangesOnCardsEnabled}
											onRequestDisplaySummary={onRequestDisplaySummary}
											onClick={() => {
												if (column.id === "backlog") {
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
