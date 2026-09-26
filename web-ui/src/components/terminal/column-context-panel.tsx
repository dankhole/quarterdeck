import { type BeforeCapture, DragDropContext, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ChevronDown, ChevronRight, Play, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BoardCard } from "@/components/board/board-card";
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
	onCardDoubleClick,
	taskSessions,
	onCreateTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	activeDragTaskId,
	activeDragSourceColumnId,
	activeDragTaskUnstarted,
}: {
	column: BoardColumn;
	selectedCardId: string;
	defaultOpen: boolean;
	onCardClick: (card: BoardCardModel) => void;
	onCardDoubleClick?: (card: BoardCardModel) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	activeDragTaskUnstarted?: boolean;
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
	const [open, setOpen] = useState(defaultOpen);
	const canCreate = column.id === "review" && onCreateTask;
	const unstartedCount = column.cards.filter((card) => card.unstarted).length;
	const canStartAllTasks = column.id === "review" && onStartAllTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
		activeDragTaskUnstarted,
	});

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
						disabled={unstartedCount === 0}
						aria-label="Start all unstarted tasks"
						title={unstartedCount > 0 ? "Start all unstarted tasks" : "No unstarted tasks"}
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
				<Droppable droppableId={column.id} type="CARD" isDropDisabled={isDropDisabled}>
					{(provided) => (
						<div ref={provided.innerRef} {...provided.droppableProps} className="flex flex-col p-2">
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
								let cardIndex = 0;
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
											index={cardIndex}
											columnId={column.id}
											sessionSummary={taskSessions[card.id]}
											selected={card.id === selectedCardId}
											onStart={onStartTask}
											onRestartSession={onRestartSessionTask}
											onMoveToTrash={onMoveToTrashTask}
											onRestoreFromTrash={onRestoreFromTrashTask}
											onHardDelete={onHardDeleteTrashTask}
											isMoveToTrashLoading={moveToTrashLoadingById[card.id] ?? false}
											onRegenerateTitle={onRegenerateTitleTask}
											onUpdateTitle={onUpdateTaskTitle}
											onTogglePin={onTogglePinTask}
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
												onCardClick(card);
											}}
											onDoubleClick={() => {
												if (column.id === "review" && card.unstarted) {
													return;
												}
												onCardDoubleClick?.(card);
											}}
										/>,
									);
									cardIndex += 1;
								}
								return items;
							})()}
							{provided.placeholder}
							{column.cards.length === 0 ? (
								<div className="flex items-center justify-center py-4 text-text-tertiary text-xs">Empty</div>
							) : null}
						</div>
					)}
				</Droppable>
			</div>
		</div>
	);
}

export function ColumnContextPanel({
	selection,
	onCardSelect,
	onCardDoubleClick,
	onTaskDragEnd,
	taskSessions,
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
	onCardDoubleClick?: (taskId: string) => void;
	onTaskDragEnd: (result: DropResult) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	panelWidth?: string;
}): React.ReactElement {
	const [activeDragTaskId, setActiveDragTaskId] = useState<string | null>(null);
	const [activeDragSourceColumnId, setActiveDragSourceColumnId] = useState<BoardColumnId | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);

	const handleBeforeCapture = useCallback(
		(start: BeforeCapture) => {
			setActiveDragTaskId(start.draggableId);
			setActiveDragSourceColumnId(findCardColumnId(selection.allColumns, start.draggableId));
		},
		[selection.allColumns],
	);

	const handleDragEnd = useCallback(
		(result: DropResult) => {
			setActiveDragTaskId(null);
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
							onCardDoubleClick={onCardDoubleClick ? (card) => onCardDoubleClick(card.id) : undefined}
							taskSessions={taskSessions}
							onCreateTask={column.id === "review" ? onCreateTask : undefined}
							onStartAllTasks={column.id === "review" ? onStartAllTasks : undefined}
							onClearTrash={column.id === "trash" ? onClearTrash : undefined}
							editingTaskId={column.id === "review" ? editingTaskId : null}
							inlineTaskEditor={column.id === "review" ? inlineTaskEditor : undefined}
							onEditTask={column.id === "review" ? onEditTask : undefined}
							activeDragTaskId={activeDragTaskId}
							activeDragSourceColumnId={activeDragSourceColumnId}
							activeDragTaskUnstarted={selection.allColumns.some((item) =>
								item.cards.some((card) => card.id === activeDragTaskId && card.unstarted),
							)}
						/>
					))}
				</div>
			</DragDropContext>
			<div className="px-3 py-2 text-text-tertiary text-[11px] text-center shrink-0">
				Double-click a task to open agent chat
			</div>
		</div>
	);
}
