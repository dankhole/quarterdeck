import { ProjectNavigationList } from "@/components/app/project-navigation-list";
import { ProjectNavigationRemovalDialog } from "@/components/app/project-navigation-removal-dialog";
import { ProjectNavigationSidebarSections } from "@/components/app/project-navigation-sidebar-sections";
import { useProjectNavigationPanel } from "@/hooks/project";
import type { RuntimeProjectSummary, RuntimeTaskSessionSummary } from "@/runtime/types";

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
	notificationSessions,
	notificationWorkspaceIds,
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
	notificationSessions: Record<string, RuntimeTaskSessionSummary>;
	notificationWorkspaceIds: Record<string, string>;
}): React.ReactElement {
	const panel = useProjectNavigationPanel({
		projects,
		removingProjectId,
		onRemoveProject,
		onReorderProjects,
		notificationSessions,
		notificationWorkspaceIds,
	});

	return (
		<div className="flex flex-col min-h-0 overflow-hidden bg-surface-1 flex-1">
			<div style={{ padding: "12px 12px 8px" }}>
				<div>
					<div className="font-semibold text-base flex items-baseline gap-1.5">
						Quarterdeck <span className="text-text-secondary font-normal text-xs">v{__APP_VERSION__}</span>
					</div>
				</div>
			</div>

			<ProjectNavigationList
				projects={panel.displayedProjects}
				isLoadingProjects={isLoadingProjects}
				canReorder={panel.canReorder}
				currentProjectId={currentProjectId}
				removingProjectId={removingProjectId}
				needsInputByProject={panel.needsInputByProject}
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
