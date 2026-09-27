import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { DropResult } from "@hello-pangea/dnd";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { BoardColumn } from "@/components/board/board-column";
import { Button } from "@/components/ui/button";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { boardGridCollision } from "@/state/board-grid-collision";
import { resolveBoardGridDrop } from "@/state/board-grid-drag";
import type { BoardReplyScope } from "@/state/board-reply-drafts";
import { findCardColumnId, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardCard, BoardData } from "@/types";

export type RequestProgrammaticCardMove = (move: ProgrammaticCardMoveInFlight) => boolean;

export function QuarterdeckBoard({
	data,
	replyScope,
	taskSessions,
	onCardSelect,
	onCreateTask,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onDragEnd,
	onRequestProgrammaticCardMoveReady,
}: {
	data: BoardData;
	replyScope?: BoardReplyScope;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCardSelect: (taskId: string) => void;
	onCreateTask: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCard) => void;
	onDragEnd: (result: DropResult) => void;
	onRequestProgrammaticCardMoveReady?: (requestMove: RequestProgrammaticCardMove | null) => void;
}): React.ReactElement {
	const [activeDragTaskId, setActiveDragTaskId] = useState<string | null>(null);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const sourceColumnId = activeDragTaskId ? findCardColumnId(data.columns, activeDragTaskId) : null;
	const activeCard = data.columns.flatMap((column) => column.cards).find((card) => card.id === activeDragTaskId);
	const requestProgrammaticCardMove = useCallback<RequestProgrammaticCardMove>(
		(move) => {
			if (
				move.fromColumnId === move.toColumnId ||
				activeDragTaskId ||
				findCardColumnId(data.columns, move.taskId) !== move.fromColumnId
			)
				return false;
			const result = resolveBoardGridDrop(data, move.taskId, move.toColumnId, move);
			if (!result) return false;
			// Keep the existing lifecycle intent path; grid layout no longer synthesizes horizontal keyboard drags.
			onDragEnd(result);
			return true;
		},
		[activeDragTaskId, data, onDragEnd],
	);
	useEffect(() => {
		onRequestProgrammaticCardMoveReady?.(requestProgrammaticCardMove);
		return () => onRequestProgrammaticCardMoveReady?.(null);
	}, [onRequestProgrammaticCardMoveReady, requestProgrammaticCardMove]);
	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		setActiveDragTaskId(null);
		if (!over) return;
		const result = resolveBoardGridDrop(data, String(active.id), String(over.id));
		if (result) onDragEnd(result);
	};
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-4">
				<Button variant="primary" icon={<Plus size={16} />} onClick={onCreateTask} aria-label="Create task">
					Create task{" "}
					<span aria-hidden className="ml-4 rounded border border-white/20 px-1.5 text-[11px] text-white/70">
						C
					</span>
				</Button>
				<span className="text-xs text-text-tertiary">Your agents, at a glance</span>
			</div>
			<DndContext
				sensors={sensors}
				collisionDetection={boardGridCollision}
				onDragStart={({ active }) => setActiveDragTaskId(String(active.id))}
				onDragCancel={() => setActiveDragTaskId(null)}
				onDragEnd={handleDragEnd}
			>
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					<section className="kb-board" aria-label="Task board">
						{data.columns.map((column) => (
							<BoardColumn
								key={column.id}
								column={column}
								taskSessions={taskSessions}
								replyScope={replyScope}
								onClearTrash={column.id === "trash" ? onClearTrash : undefined}
								editingTaskId={editingTaskId}
								inlineTaskEditor={inlineTaskEditor}
								onEditTask={onEditTask}
								activeDragTaskId={activeDragTaskId}
								activeDragSourceColumnId={sourceColumnId}
								activeDragTaskUnstarted={activeCard?.unstarted}
								onCardClick={(card) => {
									if (!activeDragTaskId) onCardSelect(card.id);
								}}
							/>
						))}
					</section>
				</div>
				<DragOverlay dropAnimation={null}>
					{activeCard ? (
						<div className="rounded-xl border border-accent bg-surface-2 px-5 py-4 text-sm font-medium shadow-xl">
							{activeCard.title || "Task"}
						</div>
					) : null}
				</DragOverlay>
			</DndContext>
		</div>
	);
}
