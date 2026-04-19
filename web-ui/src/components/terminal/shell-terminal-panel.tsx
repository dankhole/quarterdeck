import type { ReactElement } from "react";

import {
	PersistentTerminalPanelLayout,
	type PersistentTerminalSessionControls,
} from "@/components/terminal/persistent-terminal-panel-layout";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";

export interface ShellTerminalPanelProps {
	taskId: string;
	projectId: string | null;
	terminalEnabled?: boolean;
	summary: RuntimeTaskSessionSummary | null;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onClose?: () => void;
	autoFocus?: boolean;
	headerTitle?: string;
	headerSubtitle?: string | null;
	panelBackgroundColor?: string;
	terminalBackgroundColor?: string;
	cursorColor?: string;
	isVisible?: boolean;
	onConnectionReady?: (taskId: string) => void;
	launchCommand?: string | null;
	onLaunchCommand?: () => void;
	isExpanded?: boolean;
	onToggleExpand?: () => void;
	onRestart?: () => void;
	onExit?: (taskId: string, exitCode: number | null) => void;
}

export function ShellTerminalPanel(props: ShellTerminalPanelProps): ReactElement {
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
			showSessionToolbar={false}
			onClose={props.onClose}
			headerTitle={props.headerTitle ?? "Shell"}
			headerSubtitle={props.headerSubtitle ?? null}
			panelBackgroundColor={props.panelBackgroundColor}
			terminalBackgroundColor={props.terminalBackgroundColor}
			commandAction={
				props.launchCommand && props.onLaunchCommand
					? {
							command: props.launchCommand,
							onRun: props.onLaunchCommand,
						}
					: undefined
			}
			isExpanded={props.isExpanded}
			onToggleExpand={props.onToggleExpand}
			onRestart={props.onRestart}
		/>
	);
}
