import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { cn } from "@/components/ui/cn";

export function SortableBoardCard({
	id,
	title,
	dropDisabled,
	dragDisabled = false,
	children,
}: {
	id: string;
	title: string;
	dropDisabled: boolean;
	dragDisabled?: boolean;
	children: (handle: ReactNode) => ReactNode;
}): React.ReactElement {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver } =
		useSortable({
			id,
			disabled: { droppable: dropDisabled, draggable: dragDisabled },
		});
	// dnd-kit memoizes `attributes`/`listeners`/`setActivatorNodeRef` so they
	// stay referentially stable for an item that isn't itself being dragged.
	// Memoizing the handle element on those same inputs keeps `dragHandle`
	// stable too, so passing it down doesn't defeat memo(BoardCard) for every
	// other card whenever one card's session summary changes.
	const handle = useMemo(
		() =>
			dragDisabled ? null : (
				<button
					type="button"
					ref={setActivatorNodeRef}
					{...attributes}
					{...listeners}
					aria-label={`Move ${title}`}
					title="Drag to move · Space and arrow keys to move with keyboard"
					className="touch-none cursor-grab rounded p-1 text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
					onClick={(event) => event.stopPropagation()}
				>
					<GripVertical size={14} />
				</button>
			),
		[dragDisabled, title, setActivatorNodeRef, attributes, listeners],
	);
	return (
		<div
			ref={setNodeRef}
			className={cn(
				"min-w-0",
				isDragging && "z-20 opacity-40",
				isOver && !isDragging && "rounded-xl ring-1 ring-accent",
			)}
			style={{ transform: CSS.Transform.toString(transform), transition }}
		>
			{children(handle)}
		</div>
	);
}
