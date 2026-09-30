import { DndContext, DragOverlay } from "@dnd-kit/core";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { ProjectGroupDialog } from "@/components/app/project-group-dialog";
import {
	ProjectDropEnd,
	ProjectNavigationGroup,
	projectMenuClass,
	projectMenuItemClass,
} from "@/components/app/project-navigation-group";
import { ProjectNavigationItem } from "@/components/app/project-navigation-item";
import { ProjectRowSkeleton } from "@/components/app/project-navigation-row";
import { moveProjectOneStep, projectDropCommand, UNGROUPED } from "@/hooks/project/project-groups";
import { useProjectGroupNavigation } from "@/hooks/project/use-project-group-navigation";
import type { ProjectManagementMenuActions } from "@/hooks/project/use-project-management";
import type { ProjectOrganization, RuntimeProjectSummary } from "@/runtime/types";

const ignoreOrganization = () => {};
export function ProjectNavigationList({
	projects,
	isLoadingProjects,
	currentProjectId,
	removingProjectId,
	needsInputByProject,
	onSelectProject,
	onPreloadProject,
	onRequestRemoveProject,
	onAddProject,
	organization = null,
	onOrganization = ignoreOrganization,
	organizationDisabled = false,
	management,
}: {
	projects: RuntimeProjectSummary[];
	isLoadingProjects: boolean;
	currentProjectId: string | null;
	removingProjectId: string | null;
	needsInputByProject: Record<string, number>;
	onSelectProject: (projectId: string) => void;
	onPreloadProject?: (projectId: string) => void;
	onRequestRemoveProject: (projectId: string) => void;
	onAddProject: (groupId?: string) => void;
	organization?: ProjectOrganization | null;
	onOrganization?: (value: ProjectOrganization) => void;
	organizationDisabled?: boolean;
	management?: ProjectManagementMenuActions | null;
}) {
	const {
		groups,
		sections,
		hasGroups,
		collapse,
		dialog,
		setDialog,
		dragId,
		setDragId,
		setRevealId,
		listRef,
		addRef,
		disabled,
		sensors,
		collision,
		openDialog,
		closeDialog,
		execute,
	} = useProjectGroupNavigation({
		organization,
		projects,
		currentProjectId,
		onOrganization,
		organizationDisabled,
		removingProjectId,
		isLoadingProjects,
	});
	function rows(section: (typeof sections)[number]) {
		return (
			<>
				{section.projects.map((project, index) => (
					<ProjectNavigationItem
						key={project.id}
						project={project}
						disabled={disabled}
						striped={index % 2 === 1}
						isCurrent={currentProjectId === project.id}
						removingProjectId={removingProjectId}
						needsInputCount={needsInputByProject[project.id] ?? 0}
						onSelect={onSelectProject}
						onPreload={onPreloadProject}
						onRemove={onRequestRemoveProject}
						management={management}
						actionsDisabled={organizationDisabled}
						groupActions={
							<>
								<DropdownMenu.Item
									className={projectMenuItemClass}
									disabled={disabled}
									onSelect={() => openDialog({ type: "move", project })}
								>
									Move to group…
								</DropdownMenu.Item>
								{([-1, 1] as const).map((direction) => (
									<DropdownMenu.Item
										key={direction}
										className={projectMenuItemClass}
										disabled={
											disabled || (direction === -1 ? index === 0 : index === section.projects.length - 1)
										}
										onSelect={() => {
											const command = moveProjectOneStep(section, project.id, direction);
											if (command) void execute(command);
										}}
									>
										{direction === -1 ? "Move up" : "Move down"}
									</DropdownMenu.Item>
								))}
								<DropdownMenu.Separator className="my-1 h-px bg-border" />
							</>
						}
					/>
				))}
				{section.projects.length === 0 && !dragId && !isLoadingProjects ? (
					<div className="px-5 py-3 text-xs text-text-tertiary">
						No projects yet.{" "}
						<button
							type="button"
							disabled={disabled}
							className="text-text-secondary hover:text-accent underline underline-offset-2"
							onClick={() => onAddProject(section.id === UNGROUPED ? undefined : section.id)}
						>
							Add project
						</button>
					</div>
				) : null}
				<ProjectDropEnd sectionId={section.id} visible={Boolean(dragId?.startsWith("project:"))} />
			</>
		);
	}
	const draggedProject = projects.find((project) => `project:${project.id}` === dragId);
	const draggedGroup = sections.find((section) => `group:${section.id}` === dragId);
	return (
		<>
			<div className="flex shrink-0 items-center px-4 pt-2 pb-1 gap-1">
				<span className="text-xs font-medium text-text-secondary flex-1">Projects</span>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<button
							ref={addRef}
							type="button"
							aria-label="Add project or group"
							disabled={disabled}
							className="p-1.5 rounded-md text-text-secondary hover:bg-surface-3 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-border-focus"
						>
							<Plus size={14} />
						</button>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content className={projectMenuClass} sideOffset={4} align="end">
							<DropdownMenu.Item className={projectMenuItemClass} onSelect={() => onAddProject()}>
								Add project…
							</DropdownMenu.Item>
							<DropdownMenu.Item
								className={projectMenuItemClass}
								onSelect={() => openDialog({ type: "create" })}
							>
								New group…
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
				{hasGroups ? (
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							<button
								type="button"
								aria-label="Project group options"
								className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-3 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-border-focus"
							>
								<Ellipsis size={14} />
							</button>
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content className={projectMenuClass} sideOffset={4} align="end">
								<DropdownMenu.Item className={projectMenuItemClass} onSelect={() => collapse.setCollapsed([])}>
									Expand all
								</DropdownMenu.Item>
								<DropdownMenu.Item
									className={projectMenuItemClass}
									onSelect={() => collapse.setCollapsed(sections.map((section) => section.id))}
								>
									Collapse all
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
				) : null}
			</div>
			<div
				ref={listRef}
				role="navigation"
				className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-1"
				aria-label="Projects"
			>
				{projects.length === 0 && isLoadingProjects
					? Array.from({ length: 3 }, (_, index) => <ProjectRowSkeleton key={index} />)
					: null}
				<DndContext
					key={organization?.revision ?? 0}
					sensors={sensors}
					collisionDetection={collision}
					onDragStart={({ active }) => setDragId(String(active.id))}
					onDragCancel={() => setDragId(null)}
					onDragEnd={({ active, over }) => {
						setDragId(null);
						if (!over || disabled) return;
						const command = projectDropCommand(String(active.id), String(over.id), sections);
						if (command) void execute(command);
					}}
				>
					{sections.map((section, index) =>
						!hasGroups ? (
							<div key={section.id}>{rows(section)}</div>
						) : section.id === UNGROUPED &&
							section.projects.length === 0 &&
							!dragId &&
							!isLoadingProjects ? null : (
							<ProjectNavigationGroup
								key={section.id}
								section={section}
								currentProjectId={currentProjectId}
								collapsed={collapse.collapsed.includes(section.id)}
								needsInputByProject={needsInputByProject}
								disabled={disabled}
								dragging={dragId !== null}
								onToggle={() => collapse.toggle(section.id)}
								actions={
									<>
										<DropdownMenu.Item
											className={projectMenuItemClass}
											onSelect={() => onAddProject(section.id)}
										>
											Add project…
										</DropdownMenu.Item>
										<DropdownMenu.Item
											className={projectMenuItemClass}
											onSelect={() => openDialog({ type: "rename", group: section })}
										>
											Rename…
										</DropdownMenu.Item>
										{([-1, 1] as const).map((direction) => (
											<DropdownMenu.Item
												key={direction}
												className={projectMenuItemClass}
												disabled={direction === -1 ? index === 0 : index === sections.length - 2}
												onSelect={() =>
													void execute({
														type: "reorder_group",
														groupId: section.id,
														beforeGroupId:
															sections[index + (direction === 1 ? 2 : -1)]?.id === UNGROUPED
																? null
																: (sections[index + (direction === 1 ? 2 : -1)]?.id ?? null),
													})
												}
											>
												{direction === -1 ? "Move up" : "Move down"}
											</DropdownMenu.Item>
										))}
										<DropdownMenu.Separator className="my-1 h-px bg-border" />
										<DropdownMenu.Item
											className={projectMenuItemClass}
											onSelect={() =>
												section.projects.length
													? openDialog({ type: "remove", group: section })
													: void execute({ type: "remove", groupId: section.id })
											}
										>
											Remove group…
										</DropdownMenu.Item>
									</>
								}
							>
								{rows(section)}
							</ProjectNavigationGroup>
						),
					)}
					{createPortal(
						<DragOverlay>
							{dragId ? (
								<div className="rounded-md border border-border-bright bg-surface-2 px-3 py-2 text-sm shadow-xl max-w-60 truncate">
									{draggedProject?.name ?? draggedGroup?.name}
									{draggedGroup ? ` · ${draggedGroup.projects.length} projects` : ""}
								</div>
							) : null}
						</DragOverlay>,
						document.body,
					)}
				</DndContext>
			</div>
			<div role="status" aria-live="polite" className="sr-only">
				{groups.announcement}
			</div>
			{dialog ? (
				<ProjectGroupDialog
					key={`${dialog.type}:${dialog.type === "rename" || dialog.type === "remove" ? dialog.group.id : dialog.type === "create" ? (dialog.projectId ?? "") : dialog.project.id}`}
					state={dialog}
					organization={groups.organization}
					projects={projects}
					pending={groups.pending}
					onExecute={execute}
					onClose={closeDialog}
					onCreateForProject={(projectId) => setDialog({ type: "create", projectId })}
					onReveal={(groupId) => {
						collapse.expand(groupId);
						if (dialog.type === "move") setRevealId(dialog.project.id);
					}}
				/>
			) : null}
		</>
	);
}
