import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
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
			{children(
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
			)}
		</div>
	);
}
