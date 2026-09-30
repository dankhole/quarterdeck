import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { ComponentProps } from "react";
import { ProjectRow } from "@/components/app/project-navigation-row";
import { cn } from "@/components/ui/cn";

export function ProjectNavigationItem({
	disabled,
	...props
}: ComponentProps<typeof ProjectRow> & { disabled: boolean }) {
	const drag = useDraggable({ id: `project:${props.project.id}`, disabled });
	const drop = useDroppable({ id: `before:${props.project.id}` });
	return (
		<div
			ref={(element) => {
				drag.setNodeRef(element);
				drop.setNodeRef(element);
			}}
			className={cn(
				"relative mb-1",
				drag.isDragging && "opacity-35",
				drop.isOver &&
					!drag.isDragging &&
					"before:absolute before:inset-x-0 before:-top-0.5 before:h-0.5 before:bg-accent",
			)}
		>
			<ProjectRow
				{...props}
				showDragHandle={!disabled}
				dragHandleProps={{ ...drag.attributes, ...drag.listeners }}
				isDragging={drag.isDragging}
			/>
		</div>
	);
}
