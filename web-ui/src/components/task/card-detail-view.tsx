import type { ReactNode } from "react";
import { CommitPanel } from "@/components/git/panels";
import { TaskBranchDialogs } from "@/components/task/task-branch-dialogs";
import { TaskDetailMainContent } from "@/components/task/task-detail-main-content";
import { ColumnContextPanel } from "@/components/terminal";
import { useCardDetailView } from "@/hooks/board/use-card-detail-view";
import { useBoardContext } from "@/providers/board-provider";
import { ResizeHandle } from "@/resize/resize-handle";
import type { MainViewId, SidebarId } from "@/resize/use-card-detail-layout";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, CardSelection } from "@/types";

/**
 * Renders the task detail area: side panel (for task-tied tabs) + right column (TopBar + main content).
 * Returns a Fragment — its children are direct flex items of the parent container.
 * The sidebar toolbar is NOT rendered here — it lives in App.tsx.
 */
export function CardDetailView({
	selection,
	currentProjectId,
	sessionSummary,
	onCardSelect,
	onCreateTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	gitHistoryPanel,
	bottomTerminalOpen,
	bottomTerminalTaskId,
	bottomTerminalSummary,
	bottomTerminalSubtitle,
	onBottomTerminalClose,
	onBottomTerminalCollapse,
	bottomTerminalPaneHeight,
	onBottomTerminalPaneHeightChange,
	onBottomTerminalConnectionReady,
	bottomTerminalAgentCommand,
	onBottomTerminalSendAgentCommand,
	isBottomTerminalExpanded,
	onBottomTerminalToggleExpand,
	onBottomTerminalRestart,
	onBottomTerminalExit,
	mainView,
	sidebar,
	topBar,
	sidePanelRatio,
	setSidePanelRatio,
	skipTaskCheckoutConfirmation,
	skipHomeCheckoutConfirmation,
	onSkipTaskCheckoutConfirmationChange,
	onDeselectTask,
	onCardDoubleClick,
	pinnedBranches,
	onTogglePinBranch,
}: {
	selection: CardSelection;
	currentProjectId: string | null;
	sessionSummary: RuntimeTaskSessionSummary | null;
	onCardSelect: (taskId: string) => void;
	onCardDoubleClick?: (taskId: string) => void;
	onCreateTask?: () => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCard) => void;
	gitHistoryPanel?: ReactNode;
	bottomTerminalOpen: boolean;
	bottomTerminalTaskId: string | null;
	bottomTerminalSummary: RuntimeTaskSessionSummary | null;
	bottomTerminalSubtitle?: string | null;
	onBottomTerminalClose: () => void;
	onBottomTerminalCollapse?: () => void;
	bottomTerminalPaneHeight?: number;
	onBottomTerminalPaneHeightChange?: (height: number) => void;
	onBottomTerminalConnectionReady?: (taskId: string) => void;
	bottomTerminalAgentCommand?: string | null;
	onBottomTerminalSendAgentCommand?: () => void;
	isBottomTerminalExpanded?: boolean;
	onBottomTerminalToggleExpand?: () => void;
	onBottomTerminalRestart?: () => void;
	onBottomTerminalExit?: (taskId: string, exitCode: number | null) => void;
	mainView: MainViewId;
	sidebar: SidebarId | null;
	topBar: ReactNode;
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
	onSkipTaskCheckoutConfirmationChange?: (skip: boolean) => void;
	onDeselectTask: () => void;
	pinnedBranches?: string[];
	onTogglePinBranch?: (branchName: string) => void;
}): React.ReactElement {
	const { sessions: taskSessions } = useBoardContext();
	const detail = useCardDetailView({
		selection,
		currentProjectId,
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
			ref={detail.detailLayoutRef}
			style={{
				display: "flex",
				flex: "1 1 0",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
			}}
		>
			{/* Task-tied side panel — only when a task tab is active */}
			{detail.isTaskSidePanelOpen ? (
				<>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							flex: `0 0 ${detail.sidePanelPercent}`,
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
								navigateToFile={detail.navigateToFile}
							/>
						) : (
							<ColumnContextPanel
								selection={selection}
								onCardSelect={onCardSelect}
								onCardDoubleClick={onCardDoubleClick}
								taskSessions={taskSessions}
								onCreateTask={onCreateTask}
								onStartAllTasks={onStartAllTasks}
								onClearTrash={onClearTrash}
								editingTaskId={editingTaskId}
								inlineTaskEditor={inlineTaskEditor}
								onEditTask={onEditTask}
								panelWidth="100%"
							/>
						)}
					</div>
					<ResizeHandle
						orientation="vertical"
						ariaLabel="Resize side panel"
						onMouseDown={detail.handleSidePanelSeparatorMouseDown}
						className="z-10"
					/>
				</>
			) : null}

			{/* Right column — TopBar + main content */}
			<TaskDetailMainContent
				detail={detail}
				selection={selection}
				currentProjectId={currentProjectId}
				sessionSummary={sessionSummary}
				mainView={mainView}
				topBar={topBar}
				gitHistoryPanel={gitHistoryPanel}
				pinnedBranches={pinnedBranches}
				onTogglePinBranch={onTogglePinBranch}
				onDeselectTask={onDeselectTask}
				bottomTerminalOpen={bottomTerminalOpen}
				bottomTerminalTaskId={bottomTerminalTaskId}
				bottomTerminalSummary={bottomTerminalSummary}
				bottomTerminalSubtitle={bottomTerminalSubtitle}
				onBottomTerminalClose={onBottomTerminalClose}
				onBottomTerminalCollapse={onBottomTerminalCollapse}
				bottomTerminalPaneHeight={bottomTerminalPaneHeight}
				onBottomTerminalPaneHeightChange={onBottomTerminalPaneHeightChange}
				onBottomTerminalConnectionReady={onBottomTerminalConnectionReady}
				bottomTerminalAgentCommand={bottomTerminalAgentCommand}
				onBottomTerminalSendAgentCommand={onBottomTerminalSendAgentCommand}
				isBottomTerminalExpanded={isBottomTerminalExpanded}
				onBottomTerminalToggleExpand={onBottomTerminalToggleExpand}
				onBottomTerminalRestart={onBottomTerminalRestart}
				onBottomTerminalExit={onBottomTerminalExit}
			/>
			<TaskBranchDialogs
				taskBranchActions={detail.taskBranchActions}
				currentProjectId={currentProjectId}
				onSkipTaskCheckoutConfirmationChange={onSkipTaskCheckoutConfirmationChange}
			/>
		</div>
	);
}
