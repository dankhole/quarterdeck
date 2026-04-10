import { type BeforeCapture, DragDropContext, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ChevronDown, ChevronRight, Play, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BoardCard } from "@/components/board-card";
import { Button } from "@/components/ui/button";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useReactiveCardState, useStableCardActions } from "@/state/card-actions-context";
import { findCardColumnId, isCardDropDisabled } from "@/state/drag-rules";
import { sortColumnCards } from "@/state/sort-column-cards";
import type { BoardCard as BoardCardModel, BoardColumn, BoardColumnId, CardSelection } from "@/types";

function ColumnSection({
	column,
	selectedCardId,
	defaultOpen,
	onCardClick,
	taskSessions,
	onCreateTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	activeDragSourceColumnId,
}: {
	column: BoardColumn;
	selectedCardId: string;
	defaultOpen: boolean;
	onCardClick: (card: BoardCardModel) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	activeDragSourceColumnId?: BoardColumnId | null;
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
	const { moveToTrashLoadingById, migratingTaskId, isLlmGenerationDisabled, showSummaryOnCards } =
		useReactiveCardState();
	const [open, setOpen] = useState(defaultOpen);
	const canCreate = column.id === "backlog" && onCreateTask;
	const canStartAllTasks = column.id === "backlog" && onStartAllTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const cardDropType = "CARD";
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null);

	useEffect(() => {
		if (!column.cards.some((card) => card.id === selectedCardId)) {
			return;
		}
		setOpen(true);
	}, [column.cards, selectedCardId]);

	return (
		<div className="bg-surface-1 rounded-lg shrink-0">
			<div
				style={{
					display: "flex",
					alignItems: "center",
					height: 40,
				}}
			>
				<button
					type="button"
					onClick={() => setOpen((prev) => !prev)}
					className="hover:bg-surface-0 rounded-md"
					style={{
						height: 32,
						flex: "1 1 auto",
						minWidth: 0,
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "0 8px",
						margin: "0 4px",
						background: "none",
						border: "none",
						cursor: "pointer",
						color: "inherit",
						textAlign: "left",
					}}
				>
					{open ? (
						<ChevronDown size={16} className="text-text-secondary" style={{ flexShrink: 0 }} />
					) : (
						<ChevronRight size={16} className="text-text-secondary" style={{ flexShrink: 0 }} />
					)}
					<span style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<ColumnIndicator columnId={column.id} />
						<span style={{ fontWeight: 600, fontSize: 13 }}>{column.title}</span>
						<span className="text-text-secondary" style={{ fontSize: 11 }}>
							{column.cards.length}
						</span>
					</span>
				</button>
				{canStartAllTasks ? (
					<Button
						icon={<Play size={14} />}
						variant="ghost"
						size="sm"
						onClick={onStartAllTasks}
						disabled={column.cards.length === 0}
						aria-label="Start all backlog tasks"
						title={column.cards.length > 0 ? "Start all backlog tasks" : "Backlog is empty"}
						style={{ marginRight: 4 }}
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
						style={{ marginRight: 4 }}
					/>
				) : null}
			</div>
			<div style={{ display: open ? "block" : "none" }}>
				<Droppable droppableId={column.id} type={cardDropType} isDropDisabled={isDropDisabled}>
					{(provided) => {
						return (
							<div
								ref={provided.innerRef}
								{...provided.droppableProps}
								style={{
									display: "flex",
									flexDirection: "column",
									padding: 8,
								}}
							>
								{canCreate ? (
									<Button
										icon={<span style={{ fontSize: 16, lineHeight: 1 }}>+</span>}
										aria-label="Create task"
										fill
										onClick={onCreateTask}
										style={{ marginBottom: 8 }}
									>
										<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
											<span>Create task</span>
											<span aria-hidden className="text-text-secondary">
												(c)
											</span>
										</span>
									</Button>
								) : null}
								{(() => {
									const items: ReactNode[] = [];
									let draggableIndex = 0;
									const cards = sortColumnCards(column.cards, column.id);
									for (const card of cards) {
										if (column.id === "backlog" && editingTaskId === card.id) {
											items.push(
												<div key={card.id} style={{ marginBottom: 8 }}>
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
												selected={card.id === selectedCardId}
												onStart={onStartTask}
												onRestartSession={onRestartSessionTask}
												onMoveToTrash={onMoveToTrashTask}
												onRestoreFromTrash={onRestoreFromTrashTask}
												onHardDelete={onHardDeleteTrashTask}
												onCancelAutomaticAction={onCancelAutomaticTaskAction}
												isMoveToTrashLoading={moveToTrashLoadingById[card.id] ?? false}
												onMigrateWorkingDirectory={onMigrateWorkingDirectory}
												isMigrateLoading={migratingTaskId === card.id}
												onRegenerateTitle={onRegenerateTitleTask}
												isLlmGenerationDisabled={isLlmGenerationDisabled}
												onUpdateTitle={onUpdateTaskTitle}
												onTogglePin={onTogglePinTask}
												showSummaryOnCards={showSummaryOnCards}
												onRequestDisplaySummary={onRequestDisplaySummary}
												onClick={() => {
													if (column.id === "backlog") {
														onEditTask?.(card);
														return;
													}
													onCardClick(card);
												}}
											/>,
										);
										draggableIndex += 1;
									}
									return items;
								})()}
								{provided.placeholder}
								{column.cards.length === 0 ? (
									<div className="flex items-center justify-center py-4 text-text-tertiary text-xs">Empty</div>
								) : null}
							</div>
						);
					}}
				</Droppable>
			</div>
		</div>
	);
}

export function ColumnContextPanel({
	selection,
	onCardSelect,
	taskSessions,
	onTaskDragEnd,
	onCreateTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	panelWidth,
}: {
	selection: CardSelection;
	onCardSelect: (taskId: string) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onTaskDragEnd: (result: DropResult) => void;
	onCreateTask?: () => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	panelWidth?: string;
}): React.ReactElement {
	const [activeDragSourceColumnId, setActiveDragSourceColumnId] = useState<BoardColumnId | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);

	const handleBeforeCapture = useCallback(
		(start: BeforeCapture) => {
			setActiveDragSourceColumnId(findCardColumnId(selection.allColumns, start.draggableId));
		},
		[selection.allColumns],
	);

	const handleDragEnd = useCallback(
		(result: DropResult) => {
			setActiveDragSourceColumnId(null);
			onTaskDragEnd(result);
		},
		[onTaskDragEnd],
	);

	useEffect(() => {
		const scrollContainer = scrollContainerRef.current;
		if (!scrollContainer) {
			return;
		}
		const escapedTaskId = selection.card.id.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
		const selectedCardElement = scrollContainer.querySelector<HTMLElement>(`[data-task-id="${escapedTaskId}"]`);
		if (!selectedCardElement) {
			return;
		}

		const frameId = window.requestAnimationFrame(() => {
			selectedCardElement.scrollIntoView({
				block: "center",
				inline: "nearest",
			});
		});
		return () => {
			window.cancelAnimationFrame(frameId);
		};
	}, [selection.card.id, selection.column.id]);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				width: panelWidth ?? "20%",
				flex: "1 1 0",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
			}}
		>
			<DragDropContext onBeforeCapture={handleBeforeCapture} onDragEnd={handleDragEnd}>
				<div
					ref={scrollContainerRef}
					className="flex flex-col gap-2 p-2"
					style={{
						flex: "1 1 0",
						minHeight: 0,
						overflowY: "auto",
						overscrollBehavior: "contain",
						overflowAnchor: "none",
					}}
				>
					{selection.allColumns.map((column) => (
						<ColumnSection
							key={column.id}
							column={column}
							selectedCardId={selection.card.id}
							defaultOpen={column.id !== "trash"}
							onCardClick={(card) => onCardSelect(card.id)}
							taskSessions={taskSessions}
							onCreateTask={column.id === "backlog" ? onCreateTask : undefined}
							onStartAllTasks={column.id === "backlog" ? onStartAllTasks : undefined}
							onClearTrash={column.id === "trash" ? onClearTrash : undefined}
							editingTaskId={column.id === "backlog" ? editingTaskId : null}
							inlineTaskEditor={column.id === "backlog" ? inlineTaskEditor : undefined}
							onEditTask={column.id === "backlog" ? onEditTask : undefined}
							activeDragSourceColumnId={activeDragSourceColumnId}
						/>
					))}
				</div>
			</DragDropContext>
		</div>
	);
}
