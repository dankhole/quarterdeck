import type { TaskDetailTerminalProps } from "@/components/task/task-detail-screen";
import { AgentTerminalPanel, ShellTerminalPanel } from "@/components/terminal";
import type { CardDetailViewLayoutState, CardDetailViewTerminalState } from "@/hooks/board/use-card-detail-view";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { CardSelection } from "@/types";

interface TaskDetailTerminalSurfaceProps {
	selection: CardSelection;
	currentProjectId: string | null;
	layoutState: Pick<CardDetailViewLayoutState, "mainRowRef">;
	terminalState: CardDetailViewTerminalState;
	sessionSummary: RuntimeTaskSessionSummary | null;
	terminalProps: TaskDetailTerminalProps;
}

export function TaskDetailTerminalSurface({
	selection,
	currentProjectId,
	layoutState,
	terminalState,
	sessionSummary,
	terminalProps,
}: TaskDetailTerminalSurfaceProps): React.ReactElement {
	return (
		<>
			<div ref={layoutState.mainRowRef} style={{ display: "flex", flex: "1 1 0", minHeight: 0, overflow: "hidden" }}>
				<div style={{ display: "flex", flex: "1 1 0", minWidth: 0, minHeight: 0 }}>
					<AgentTerminalPanel
						taskId={selection.card.id}
						projectId={currentProjectId}
						terminalEnabled={terminalState.isTaskTerminalEnabled}
						summary={sessionSummary}
						onSummary={terminalState.onSessionSummary}
						showSessionToolbar={false}
						autoFocus
						panelBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
						terminalBackgroundColor={TERMINAL_THEME_COLORS.surfacePrimary}
						taskColumnId={selection.column.id}
					/>
				</div>
			</div>
			{terminalProps.bottomTerminalOpen && terminalProps.bottomTerminalTaskId ? (
				<ResizableBottomPane
					minHeight={200}
					initialHeight={terminalProps.bottomTerminalPaneHeight}
					onHeightChange={terminalProps.onBottomTerminalPaneHeightChange}
					onCollapse={terminalProps.onBottomTerminalCollapse}
				>
					<div
						style={{
							display: "flex",
							flex: "1 1 0",
							minWidth: 0,
							paddingLeft: 12,
							paddingRight: 12,
						}}
					>
						<ShellTerminalPanel
							key={`detail-shell-${terminalProps.bottomTerminalTaskId}`}
							taskId={terminalProps.bottomTerminalTaskId}
							projectId={currentProjectId}
							summary={terminalProps.bottomTerminalSummary}
							onSummary={terminalState.onSessionSummary}
							autoFocus
							onClose={terminalProps.onBottomTerminalClose}
							headerTitle="Shell"
							headerSubtitle={terminalProps.bottomTerminalSubtitle}
							panelBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
							terminalBackgroundColor={TERMINAL_THEME_COLORS.surfaceRaised}
							cursorColor={TERMINAL_THEME_COLORS.textPrimary}
							onConnectionReady={terminalProps.onBottomTerminalConnectionReady}
							launchCommand={terminalProps.bottomTerminalAgentCommand}
							onLaunchCommand={terminalProps.onBottomTerminalSendAgentCommand}
							isExpanded={terminalProps.isBottomTerminalExpanded}
							onToggleExpand={terminalProps.onBottomTerminalToggleExpand}
							onRestart={terminalProps.onBottomTerminalRestart}
							onExit={terminalProps.onBottomTerminalExit}
						/>
					</div>
				</ResizableBottomPane>
			) : null}
		</>
	);
}
