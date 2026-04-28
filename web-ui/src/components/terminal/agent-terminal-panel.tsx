import type { ReactElement } from "react";

import {
	PersistentTerminalPanelLayout,
	type PersistentTerminalSessionControls,
} from "@/components/terminal/persistent-terminal-panel-layout";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";

export interface AgentTerminalPanelProps {
	taskId: string;
	projectId: string | null;
	terminalEnabled?: boolean;
	summary: RuntimeTaskSessionSummary | null;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	taskColumnId?: string;
	showSessionToolbar?: boolean;
	onClose?: () => void;
	autoFocus?: boolean;
	minimalHeaderTitle?: string;
	minimalHeaderSubtitle?: string | null;
	panelBackgroundColor?: string;
	terminalBackgroundColor?: string;
	cursorColor?: string;
	isVisible?: boolean;
	onConnectionReady?: (taskId: string) => void;
	agentCommand?: string | null;
	onSendAgentCommand?: () => void;
	isExpanded?: boolean;
	onToggleExpand?: () => void;
	onRestart?: () => void;
	onExit?: (taskId: string, exitCode: number | null) => void;
}

export function AgentTerminalPanel(props: AgentTerminalPanelProps): ReactElement {
	// enabled gates whether this panel should keep a live persistent terminal connection.
	// We disable it for non-active task contexts so backlog and trash views do not keep extra websocket sockets open.
	const sessionControls: PersistentTerminalSessionControls = usePersistentTerminalSession({
		taskId: props.taskId,
		projectId: props.projectId,
		enabled: props.terminalEnabled ?? true,
		onSummary: props.onSummary,
		onConnectionReady: props.onConnectionReady,
		onExit: props.onExit,
		autoFocus: props.autoFocus,
		isVisible: props.isVisible,
		sessionStartedAt: props.summary?.startedAt ?? null,
		terminalBackgroundColor: props.terminalBackgroundColor ?? "var(--color-surface-1)",
		cursorColor: props.cursorColor ?? "var(--color-text-primary)",
	});

	return (
		<PersistentTerminalPanelLayout
			taskId={props.taskId}
			summary={props.summary}
			sessionControls={sessionControls}
			showSessionToolbar={props.showSessionToolbar}
			onClose={props.onClose}
			headerTitle={props.minimalHeaderTitle ?? "Terminal"}
			headerSubtitle={props.minimalHeaderSubtitle ?? null}
			panelBackgroundColor={props.panelBackgroundColor}
			terminalBackgroundColor={props.terminalBackgroundColor}
			commandAction={
				props.agentCommand && props.onSendAgentCommand
					? {
							command: props.agentCommand,
							onRun: props.onSendAgentCommand,
						}
					: undefined
			}
			isExpanded={props.isExpanded}
			onToggleExpand={props.onToggleExpand}
			onRestart={props.onRestart}
		/>
	);
}
