import { ConflictBanner } from "@/components/git";
import { TaskDetailRepositorySurface } from "@/components/task/task-detail-repository-surface";
import type {
	TaskDetailLayoutProps,
	TaskDetailRepositoryProps,
	TaskDetailTerminalProps,
} from "@/components/task/task-detail-screen";
import { TaskDetailTerminalSurface } from "@/components/task/task-detail-terminal-surface";
import type {
	CardDetailViewLayoutState,
	CardDetailViewRepositoryState,
	CardDetailViewTerminalState,
} from "@/hooks/board/use-card-detail-view";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { CardSelection } from "@/types";

interface TaskDetailMainContentProps {
	selection: CardSelection;
	currentProjectId: string | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	layoutState: CardDetailViewLayoutState;
	repositoryState: CardDetailViewRepositoryState;
	terminalState: CardDetailViewTerminalState;
	layoutProps: TaskDetailLayoutProps;
	repositoryProps: TaskDetailRepositoryProps;
	terminalProps: TaskDetailTerminalProps;
}

export function TaskDetailMainContent({
	selection,
	currentProjectId,
	sessionSummary,
	layoutState,
	repositoryState,
	terminalState,
	layoutProps,
	repositoryProps,
	terminalProps,
}: TaskDetailMainContentProps): React.ReactElement {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				flex: "1 1 0",
				minWidth: 0,
				minHeight: 0,
				overflow: "hidden",
			}}
		>
			{layoutProps.topBar}
			{layoutProps.mainView !== "git" && (
				<ConflictBanner taskId={selection.card.id} onNavigateToResolver={repositoryState.navigateToGitView} />
			)}
			{layoutProps.mainView === "git" || layoutProps.mainView === "files" ? (
				<TaskDetailRepositorySurface
					detailLayout={layoutState}
					repositoryState={repositoryState}
					repositoryProps={repositoryProps}
					selection={selection}
					currentProjectId={currentProjectId}
					sessionSummary={sessionSummary}
					mainView={layoutProps.mainView}
				/>
			) : (
				<TaskDetailTerminalSurface
					selection={selection}
					currentProjectId={currentProjectId}
					layoutState={layoutState}
					terminalState={terminalState}
					sessionSummary={sessionSummary}
					terminalProps={terminalProps}
				/>
			)}
		</div>
	);
}
