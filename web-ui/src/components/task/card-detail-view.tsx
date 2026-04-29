import { TaskBranchDialogs } from "@/components/task/task-branch-dialogs";
import { TaskDetailMainContent } from "@/components/task/task-detail-main-content";
import type {
	TaskDetailLayoutProps,
	TaskDetailRepositoryProps,
	TaskDetailSidePanelProps,
	TaskDetailTerminalProps,
} from "@/components/task/task-detail-screen";
import { TaskDetailSidePanelSurface } from "@/components/task/task-detail-side-panel";
import { useCardDetailView } from "@/hooks/board/use-card-detail-view";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { CardSelection } from "@/types";

/**
 * Renders the task detail area: side panel (for task-tied tabs) + right column (TopBar + main content).
 * Returns a Fragment — its children are direct flex items of the parent container.
 * The sidebar toolbar is NOT rendered here — it lives in App.tsx.
 */
export function CardDetailView({
	selection,
	currentProjectId,
	projectPath,
	sessionSummary,
	layoutProps,
	sidePanelProps,
	repositoryProps,
	terminalProps,
}: {
	selection: CardSelection;
	currentProjectId: string | null;
	projectPath: string | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	layoutProps: TaskDetailLayoutProps;
	sidePanelProps: TaskDetailSidePanelProps;
	repositoryProps: TaskDetailRepositoryProps;
	terminalProps: TaskDetailTerminalProps;
}): React.ReactElement {
	const { sidebar, sidePanelRatio, setSidePanelRatio } = layoutProps;
	const { skipTaskCheckoutConfirmation, skipHomeCheckoutConfirmation } = repositoryProps;
	// Task repository identity needs the project root to distinguish shared-checkout tasks
	// from isolated worktrees. If more task-detail props need project-scoped identity
	// context, move this into a task repository identity provider instead of threading
	// those values through this component.
	const detail = useCardDetailView({
		selection,
		currentProjectId,
		projectPath,
		sidePanelRatio,
		setSidePanelRatio,
		sidebar,
		skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation,
	});

	// The component renders as a wrapper div whose children are the side panel + right column.
	// The wrapper is a flex row that fills the parent container.
	return (
		<div
			ref={detail.layout.detailLayoutRef}
			style={{
				display: "flex",
				flex: "1 1 0",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
			}}
		>
			<TaskDetailSidePanelSurface
				selection={selection}
				currentProjectId={currentProjectId}
				sidebar={sidebar}
				layoutState={detail.layout}
				sidePanelState={detail.sidePanel}
				sidePanelProps={sidePanelProps}
			/>

			{/* Right column — TopBar + main content */}
			<TaskDetailMainContent
				selection={selection}
				currentProjectId={currentProjectId}
				sessionSummary={sessionSummary}
				layoutState={detail.layout}
				repositoryState={detail.repository}
				terminalState={detail.terminal}
				layoutProps={layoutProps}
				repositoryProps={repositoryProps}
				terminalProps={terminalProps}
			/>
			<TaskBranchDialogs
				taskBranchActions={detail.repository.taskBranchActions}
				currentProjectId={currentProjectId}
				onSkipTaskCheckoutConfirmationChange={repositoryProps.onSkipTaskCheckoutConfirmationChange}
			/>
		</div>
	);
}
