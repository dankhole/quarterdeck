import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { ProjectRow, ProjectRowSkeleton } from "@/components/app/project-navigation-row";
import type { RuntimeProjectSummary } from "@/runtime/types";

export function ProjectNavigationList({
	projects,
	isLoadingProjects,
	canReorder,
	currentProjectId,
	removingProjectId,
	needsInputByProject,
	onSelectProject,
	onPreloadProject,
	onRequestRemoveProject,
	onDragEnd,
	onAddProject,
}: {
	projects: RuntimeProjectSummary[];
	isLoadingProjects: boolean;
	canReorder: boolean;
	currentProjectId: string | null;
	removingProjectId: string | null;
	needsInputByProject: Record<string, number>;
	onSelectProject: (projectId: string) => void;
	onPreloadProject?: (projectId: string) => void;
	onRequestRemoveProject: (projectId: string) => void;
	onDragEnd: (result: DropResult) => void;
	onAddProject: () => void;
}): React.ReactElement {
	return (
		<div
			className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-1"
			style={{ padding: "4px 12px" }}
		>
			{projects.length === 0 && isLoadingProjects ? (
				<div style={{ padding: "4px 0" }}>
					{Array.from({ length: 3 }).map((_, index) => (
						<ProjectRowSkeleton key={`project-skeleton-${index}`} />
					))}
				</div>
			) : null}

			<DragDropContext onDragEnd={onDragEnd}>
				<Droppable droppableId="project-list">
					{(droppableProvided) => (
						<div ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
							{projects.map((project, index) => (
								<Draggable key={project.id} draggableId={project.id} index={index} isDragDisabled={!canReorder}>
									{(draggableProvided, draggableSnapshot) => {
										const row = (
											<div
												ref={draggableProvided.innerRef}
												{...draggableProvided.draggableProps}
												style={{
													...draggableProvided.draggableProps.style,
													marginBottom: 4,
												}}
											>
												<ProjectRow
													project={project}
													isCurrent={currentProjectId === project.id}
													removingProjectId={removingProjectId}
													needsInputCount={needsInputByProject[project.id] ?? 0}
													showDragHandle={canReorder}
													dragHandleProps={draggableProvided.dragHandleProps}
													isDragging={draggableSnapshot.isDragging}
													onSelect={onSelectProject}
													onPreload={onPreloadProject}
													onRemove={onRequestRemoveProject}
												/>
											</div>
										);
										if (draggableSnapshot.isDragging && typeof document !== "undefined") {
											return createPortal(row, document.body);
										}
										return row;
									}}
								</Draggable>
							))}
							{droppableProvided.placeholder}
						</div>
					)}
				</Droppable>
			</DragDropContext>

			{!isLoadingProjects ? (
				<button
					type="button"
					className="kb-project-row flex cursor-pointer items-center gap-1.5 rounded-md text-text-secondary hover:text-text-primary"
					style={{ padding: "6px 8px" }}
					onClick={onAddProject}
					disabled={removingProjectId !== null}
				>
					<Plus size={14} className="shrink-0" />
					<span className="text-sm">Add Project</span>
				</button>
			) : null}
		</div>
	);
}
