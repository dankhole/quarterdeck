import { ProjectNavigationList } from "@/components/app/project-navigation-list";
import { ProjectNavigationRemovalDialog } from "@/components/app/project-navigation-removal-dialog";
import { ProjectNavigationSidebarSections } from "@/components/app/project-navigation-sidebar-sections";
import { CreateTaskButton } from "@/components/task/create-task-button";
import { useProjectNavigationPanel } from "@/hooks/project";
import type { RuntimeProjectSummary } from "@/runtime/types";

export function ProjectNavigationPanel({
	projects,
	isLoadingProjects = false,
	currentProjectId,
	removingProjectId,
	onSelectProject,
	onPreloadProject,
	onRemoveProject,
	onReorderProjects,
	onAddProject,
	onCreateTask,
	needsInputByProject,
}: {
	projects: RuntimeProjectSummary[];
	isLoadingProjects?: boolean;
	currentProjectId: string | null;
	removingProjectId: string | null;
	onSelectProject: (projectId: string) => void;
	onPreloadProject?: (projectId: string) => void;
	onRemoveProject: (projectId: string) => Promise<boolean>;
	onReorderProjects?: (projectOrder: string[]) => Promise<void>;
	onAddProject: () => void;
	onCreateTask: () => void;
	needsInputByProject: Record<string, number>;
}): React.ReactElement {
	const panel = useProjectNavigationPanel({
		projects,
		removingProjectId,
		onRemoveProject,
		onReorderProjects,
	});

	return (
		<div className="flex flex-col min-h-0 overflow-hidden bg-surface-1 flex-1">
			<CreateTaskButton onClick={onCreateTask} />

			<ProjectNavigationList
				projects={panel.displayedProjects}
				isLoadingProjects={isLoadingProjects}
				canReorder={panel.canReorder}
				currentProjectId={currentProjectId}
				removingProjectId={removingProjectId}
				needsInputByProject={needsInputByProject}
				onSelectProject={onSelectProject}
				onPreloadProject={onPreloadProject}
				onRequestRemoveProject={panel.requestProjectRemoval}
				onDragEnd={panel.handleDragEnd}
				onAddProject={onAddProject}
			/>
			<ProjectNavigationSidebarSections />
			<ProjectNavigationRemovalDialog
				pendingProjectRemoval={panel.pendingProjectRemoval}
				pendingProjectTaskCount={panel.pendingProjectTaskCount}
				isProjectRemovalPending={panel.isProjectRemovalPending}
				onClearPendingProjectRemoval={panel.closeProjectRemovalDialog}
				onConfirmProjectRemoval={panel.confirmProjectRemoval}
			/>
		</div>
	);
}
