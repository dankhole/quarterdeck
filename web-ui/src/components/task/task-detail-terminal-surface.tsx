import type { TaskDetailTerminalProps } from "@/components/task/task-detail-screen";
import { AgentTerminalPanel, ShellTerminalPanel } from "@/components/terminal";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{terminalState.pendingSessionLabel || terminalState.isSessionProcessless ? (
						<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-1 px-4 py-3">
							{terminalState.pendingSessionLabel ? (
								<div role="status" className="flex items-center gap-2 text-sm text-text-secondary">
									<Spinner size={18} />
									{terminalState.pendingSessionLabel}
								</div>
							) : (
								<>
									<p className="text-sm text-text-secondary">Chat is not running</p>
									<Button variant="primary" onClick={terminalState.onResumeSession}>
										{sessionSummary?.resumeSessionId ? "Resume chat" : "Restart chat"}
									</Button>
								</>
							)}
						</div>
					) : null}
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
