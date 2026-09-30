import { ProjectNavigationList } from "@/components/app/project-navigation-list";
import { ProjectNavigationRemovalDialog } from "@/components/app/project-navigation-removal-dialog";
import { ProjectNavigationSidebarSections } from "@/components/app/project-navigation-sidebar-sections";
import { CreateTaskButton } from "@/components/task/create-task-button";
import { useProjectNavigationPanel } from "@/hooks/project";
import type { ProjectOrganization, RuntimeProjectSummary } from "@/runtime/types";

export function ProjectNavigationPanel({
	projects,
	isLoadingProjects = false,
	currentProjectId,
	removingProjectId,
	onSelectProject,
	onPreloadProject,
	onRemoveProject,
	onAddProject,
	onCreateTask,
	organization,
	onOrganization,
	organizationDisabled,
	needsInputByProject,
}: {
	projects: RuntimeProjectSummary[];
	isLoadingProjects?: boolean;
	currentProjectId: string | null;
	removingProjectId: string | null;
	onSelectProject: (projectId: string) => void;
	onPreloadProject?: (projectId: string) => void;
	onRemoveProject: (projectId: string) => Promise<boolean>;
	onAddProject: (groupId?: string) => void;
	organization?: ProjectOrganization | null;
	onOrganization?: (value: ProjectOrganization) => void;
	organizationDisabled?: boolean;
	onCreateTask: () => void;
	needsInputByProject: Record<string, number>;
}): React.ReactElement {
	const panel = useProjectNavigationPanel({
		projects,
		removingProjectId,
		onRemoveProject,
	});

	return (
		<div className="flex flex-col min-h-0 overflow-hidden bg-surface-1 flex-1">
			<CreateTaskButton onClick={onCreateTask} />

			<ProjectNavigationList
				projects={projects}
				isLoadingProjects={isLoadingProjects}
				currentProjectId={currentProjectId}
				removingProjectId={removingProjectId}
				needsInputByProject={needsInputByProject}
				onSelectProject={onSelectProject}
				onPreloadProject={onPreloadProject}
				onRequestRemoveProject={panel.requestProjectRemoval}
				onAddProject={onAddProject}
				organization={organization}
				onOrganization={onOrganization}
				organizationDisabled={organizationDisabled}
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
