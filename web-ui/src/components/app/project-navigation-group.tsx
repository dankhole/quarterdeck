import { useDraggable, useDroppable } from "@dnd-kit/core";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, Ellipsis, GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { resolveProjectNavigationTaskCounts } from "@/components/app/project-navigation-counts";
import { cn } from "@/components/ui/cn";
import { statusPillColors } from "@/data/column-colors";
import { type ProjectSection, UNGROUPED } from "@/hooks/project/project-groups";

export const projectMenuItemClass =
	"rounded-sm px-2 py-1.5 text-[13px] cursor-pointer outline-none data-[highlighted]:bg-surface-3 data-[disabled]:opacity-40 data-[disabled]:pointer-events-none";
export const projectMenuClass = "z-50 min-w-40 rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg";

export function ProjectNavigationGroup({
	section,
	striped = false,
	collapsed,
	currentProjectId,
	needsInputByProject,
	disabled,
	dragging,
	onToggle,
	actions,
	children,
}: {
	section: ProjectSection;
	striped?: boolean;
	collapsed: boolean;
	currentProjectId: string | null;
	needsInputByProject: Record<string, number>;
	disabled: boolean;
	dragging: boolean;
	onToggle: () => void;
	actions: ReactNode;
	children: ReactNode;
}) {
	const ungrouped = section.id === UNGROUPED;
	const drag = useDraggable({ id: `group:${section.id}`, disabled: disabled || ungrouped });
	const drop = useDroppable({ id: `section:${section.id}` });
	const current = collapsed && section.projects.some((project) => project.id === currentProjectId);
	const counts = section.projects.reduce(
		(sum, project) => {
			const counts = resolveProjectNavigationTaskCounts(project.taskCounts, needsInputByProject[project.id] ?? 0);
			return {
				inProgress: sum.inProgress + counts.inProgress,
				review: sum.review + counts.review,
				needsInput: sum.needsInput + counts.needsInput,
			};
		},
		{ inProgress: 0, review: 0, needsInput: 0 },
	);
	return (
		<section
			ref={drag.setNodeRef}
			aria-label={section.name}
			className={cn("group/section mb-2", drag.isDragging && "opacity-35")}
		>
			<div
				ref={drop.setNodeRef}
				className={cn(
					"flex items-center gap-0.5 rounded-md min-h-8 pr-1",
					striped && !(drop.isOver && dragging) && "bg-white/[0.025]",
					drop.isOver && dragging && "bg-accent/10 ring-1 ring-accent",
					current && "border-l-2 border-accent",
				)}
			>
				<button
					type="button"
					aria-expanded={!collapsed}
					aria-controls={`project-group-${section.id}`}
					aria-label={`${collapsed ? "Expand" : "Collapse"} ${section.name}${current ? ", contains current project" : ""}`}
					onClick={onToggle}
					className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-1 py-1.5 rounded-md hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-border-focus cursor-pointer"
				>
					<ChevronRight
						size={14}
						className={cn(
							"shrink-0 text-text-secondary transition-transform motion-reduce:transition-none",
							!collapsed && "rotate-90",
						)}
					/>
					<span title={section.name} className="truncate text-sm font-medium text-text-secondary">
						{section.name}
					</span>
					<span
						className="ml-auto text-[11px] tabular-nums text-text-tertiary"
						title={`${section.projects.length} projects`}
					>
						{section.projects.length}
					</span>
				</button>
				{!ungrouped ? (
					<>
						<button
							type="button"
							{...drag.attributes}
							{...drag.listeners}
							aria-label={`Drag group ${section.name}`}
							disabled={disabled}
							className="p-1 text-text-tertiary opacity-0 group-hover/section:opacity-100 focus:opacity-100 cursor-grab touch-none rounded-sm focus-visible:outline-2 focus-visible:outline-border-focus"
						>
							<GripVertical size={12} />
						</button>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger asChild>
								<button
									type="button"
									aria-label={`Actions for group ${section.name}`}
									disabled={disabled}
									className="p-1 text-text-tertiary hover:text-text-primary hover:bg-surface-3 rounded-sm focus-visible:outline-2 focus-visible:outline-border-focus"
								>
									<Ellipsis size={14} />
								</button>
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content align="end" sideOffset={4} className={projectMenuClass}>
									{actions}
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>
					</>
				) : null}
			</div>
			{collapsed && counts.inProgress + counts.review + counts.needsInput > 0 ? (
				<div role="group" className="flex gap-1 pl-6 pb-1 pt-0.5" aria-label={`Activity in ${section.name}`}>
					{[
						{ count: counts.inProgress, label: "IP", title: "In Progress", tone: statusPillColors.in_progress },
						{ count: counts.review, label: "R", title: "Review", tone: statusPillColors.review },
						{ count: counts.needsInput, label: "NI", title: "Needs Input", tone: statusPillColors.needs_input },
					]
						.filter((item) => item.count > 0)
						.map((item) => (
							<span
								key={item.label}
								title={`${item.count} ${item.title}`}
								role="img"
								aria-label={`${item.count} tasks ${item.title}`}
								className={cn("rounded-full px-1.5 text-[10px] leading-4 font-medium", item.tone)}
							>
								{item.label} {item.count}
							</span>
						))}
				</div>
			) : null}
			<div id={`project-group-${section.id}`} hidden={collapsed} className="pl-1 pt-1">
				{children}
			</div>
		</section>
	);
}

export function ProjectDropEnd({ sectionId, visible }: { sectionId: string; visible: boolean }) {
	const drop = useDroppable({ id: `end:${sectionId}`, disabled: !visible });
	return visible ? (
		<div
			ref={drop.setNodeRef}
			className={cn(
				"h-7 rounded-md border border-dashed border-border text-center text-[11px] leading-6 text-text-tertiary",
				drop.isOver && "border-accent bg-accent/10 text-accent",
			)}
		>
			Drop project here
		</div>
	) : null;
}
