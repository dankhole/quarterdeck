import { CommitPanel } from "@/components/git/panels";
import type { TaskDetailSidePanelProps } from "@/components/task/task-detail-screen";
import { ColumnContextPanel } from "@/components/terminal";
import type { CardDetailViewLayoutState, CardDetailViewSidePanelState } from "@/hooks/board/use-card-detail-view";
import { ResizeHandle } from "@/resize/resize-handle";
import type { SidebarId } from "@/resize/use-card-detail-layout";
import type { CardSelection } from "@/types";

interface TaskDetailSidePanelSurfaceProps {
	selection: CardSelection;
	currentProjectId: string | null;
	sidebar: SidebarId | null;
	layoutState: CardDetailViewLayoutState;
	sidePanelState: CardDetailViewSidePanelState;
	sidePanelProps: TaskDetailSidePanelProps;
}

export function TaskDetailSidePanelSurface({
	selection,
	currentProjectId,
	sidebar,
	layoutState,
	sidePanelState,
	sidePanelProps,
}: TaskDetailSidePanelSurfaceProps): React.ReactElement | null {
	if (!layoutState.isTaskSidePanelOpen) {
		return null;
	}

	return (
		<>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					flex: `0 0 ${layoutState.sidePanelPercent}`,
					minWidth: 0,
					minHeight: 0,
					overflow: "hidden",
				}}
			>
				{sidebar === "commit" ? (
					<CommitPanel
						projectId={currentProjectId ?? ""}
						taskId={selection.card.id}
						baseRef={selection.card.baseRef}
						navigateToFile={sidePanelProps.navigateToFile}
					/>
				) : (
					<ColumnContextPanel
						selection={selection}
						onCardSelect={sidePanelProps.onCardSelect}
						onCardDoubleClick={sidePanelProps.onCardDoubleClick}
						taskSessions={sidePanelState.taskSessions}
						onCreateTask={sidePanelProps.onCreateTask}
						onStartAllTasks={sidePanelProps.onStartAllTasks}
						onClearTrash={sidePanelProps.onClearTrash}
						editingTaskId={sidePanelProps.editingTaskId}
						inlineTaskEditor={sidePanelProps.inlineTaskEditor}
						onEditTask={sidePanelProps.onEditTask}
						panelWidth="100%"
					/>
				)}
			</div>
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize side panel"
				onMouseDown={layoutState.handleSidePanelSeparatorMouseDown}
				className="z-10"
			/>
		</>
	);
}
