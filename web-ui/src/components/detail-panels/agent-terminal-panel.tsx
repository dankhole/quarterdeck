import "@xterm/xterm/css/xterm.css";

import { Command, Eraser, Maximize2, MessageSquare, Minimize2, RotateCw, X } from "lucide-react";
import type { MutableRefObject, ReactElement } from "react";
import { useMemo } from "react";

import { ChatOutputView } from "@/components/chat-output-view";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useChatOutput } from "@/hooks/use-chat-output";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";
import { isMacPlatform } from "@/utils/platform";
import { describeSessionState, getSessionStatusBadgeStyle, statusBadgeColors } from "@/utils/session-status";

interface AgentTerminalSessionControls {
	clearTerminal: () => void;
	containerRef: MutableRefObject<HTMLDivElement | null>;
	isStopping: boolean;
	lastError: string | null;
	stopTerminal: () => Promise<void>;
}

export interface AgentTerminalPanelProps {
	taskId: string;
	workspaceId: string | null;
	terminalEnabled?: boolean;
	summary: RuntimeTaskSessionSummary | null;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	taskColumnId?: string;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
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
	chatViewEnabled?: boolean;
	scrollOnEraseInDisplay?: boolean;
}

function AgentTerminalPanelLayout({
	taskId: _taskId,
	summary,
	onSummary: _onSummary,
	taskColumnId: _taskColumnId = "in_progress",
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showSessionToolbar = true,
	onClose,
	autoFocus: _autoFocus = false,
	minimalHeaderTitle = "Terminal",
	minimalHeaderSubtitle = null,
	panelBackgroundColor = "var(--color-surface-1)",
	terminalBackgroundColor = "var(--color-surface-1)",
	cursorColor: _cursorColor = "var(--color-text-primary)",
	isVisible: _isVisible = true,
	onConnectionReady: _onConnectionReady,
	agentCommand,
	onSendAgentCommand,
	isExpanded = false,
	onToggleExpand,
	onRestart,
	sessionControls,
	chatViewEnabled = false,
	chatLines,
	onClearChat,
}: AgentTerminalPanelProps & {
	sessionControls: AgentTerminalSessionControls;
	chatLines: string[];
	onClearChat: () => void;
}): ReactElement {
	const { containerRef, lastError, isStopping, clearTerminal, stopTerminal } = sessionControls;
	const canStop = summary?.state === "running" || summary?.state === "awaiting_review";
	const statusLabel = useMemo(() => describeSessionState(summary), [summary]);
	const statusTagStyle = useMemo(() => getSessionStatusBadgeStyle(summary), [summary]);
	const agentLabel = useMemo(() => {
		const normalizedCommand = agentCommand?.trim();
		if (!normalizedCommand) {
			return null;
		}
		return normalizedCommand.split(/\s+/)[0] ?? null;
	}, [agentCommand]);

	const handleClear = () => {
		clearTerminal();
		onClearChat();
	};

	return (
		<div
			style={{
				display: "flex",
				flex: "1 1 0",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
				background: panelBackgroundColor,
			}}
		>
			{showSessionToolbar ? (
				<>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							padding: "8px 12px",
						}}
					>
						<div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
							<span
								className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${statusBadgeColors[statusTagStyle]}`}
							>
								{statusLabel}
							</span>
						</div>
						<div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
							<Button variant="default" size="sm" onClick={handleClear}>
								Clear
							</Button>
							<Button
								variant="default"
								size="sm"
								onClick={() => {
									void stopTerminal();
								}}
								disabled={!canStop || isStopping}
							>
								Stop
							</Button>
						</div>
					</div>
					<div className="h-px bg-border" />
				</>
			) : onClose ? (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "6px 0 0 3px",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
						<span className="text-text-secondary" style={{ fontSize: 12 }}>
							{minimalHeaderTitle}
						</span>
						{minimalHeaderSubtitle ? (
							<span
								className="truncate font-mono text-text-secondary"
								style={{ fontSize: 10 }}
								title={minimalHeaderSubtitle}
							>
								{minimalHeaderSubtitle}
							</span>
						) : null}
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: 2, marginRight: "-6px" }}>
						{agentLabel && onSendAgentCommand ? (
							<Tooltip side="top" content={`Run ${agentLabel}`}>
								<Button
									icon={<MessageSquare size={12} />}
									variant="ghost"
									size="sm"
									onClick={onSendAgentCommand}
									aria-label={`Run ${agentLabel}`}
								/>
							</Tooltip>
						) : null}
						<Tooltip side="top" content="Clear">
							<Button
								icon={<Eraser size={12} />}
								variant="ghost"
								size="sm"
								onClick={handleClear}
								aria-label="Clear terminal"
							/>
						</Tooltip>
						{onRestart ? (
							<Tooltip side="top" content="Restart">
								<Button
									icon={<RotateCw size={12} />}
									variant="ghost"
									size="sm"
									onClick={onRestart}
									aria-label="Restart terminal"
								/>
							</Tooltip>
						) : null}
						{onToggleExpand ? (
							<Tooltip
								side="top"
								content={
									<span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
										<span>{isExpanded ? "Collapse" : "Expand"}</span>
										<span
											style={{ display: "inline-flex", alignItems: "center", gap: 2, whiteSpace: "nowrap" }}
										>
											<span>(</span>
											{isMacPlatform ? <Command size={11} /> : <span style={{ fontSize: 11 }}>Ctrl</span>}
											<span>+ M)</span>
										</span>
									</span>
								}
							>
								<Button
									icon={isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
									variant="ghost"
									size="sm"
									onClick={onToggleExpand}
									aria-label={isExpanded ? "Collapse terminal" : "Expand terminal"}
								/>
							</Tooltip>
						) : null}
						<Button
							icon={<X size={14} />}
							variant="ghost"
							size="sm"
							onClick={onClose}
							aria-label="Close terminal"
						/>
					</div>
				</div>
			) : null}
			<div
				style={{
					flex: "1 1 0",
					minHeight: 0,
					overflow: "hidden",
					padding: "3px 1.5px 3px 3px",
					display: "flex",
					flexDirection: "column",
				}}
			>
				{chatViewEnabled ? <ChatOutputView lines={chatLines} backgroundColor={terminalBackgroundColor} /> : null}
				<div
					ref={containerRef}
					className="kb-terminal-container"
					style={{
						height: chatViewEnabled ? "0px" : "100%",
						width: "100%",
						background: terminalBackgroundColor,
						overflow: "hidden",
					}}
				/>
			</div>
			{lastError ? (
				<div className="flex gap-2 rounded-none border-t border-status-red/30 bg-status-red/10 p-3 text-[13px] text-status-red">
					{lastError}
				</div>
			) : null}
			{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
				<div className="px-3 py-2">
					<Button variant="default" fill onClick={onCancelAutomaticAction}>
						{cancelAutomaticActionLabel}
					</Button>
				</div>
			) : null}
		</div>
	);
}

export function AgentTerminalPanel(props: AgentTerminalPanelProps): ReactElement {
	// enabled gates whether this panel should keep a live persistent terminal connection.
	// We disable it for non-active task contexts so backlog and trash views do not keep extra websocket sockets open.
	const sessionControls = usePersistentTerminalSession({
		taskId: props.taskId,
		workspaceId: props.workspaceId,
		enabled: props.terminalEnabled ?? true,
		onSummary: props.onSummary,
		onConnectionReady: props.onConnectionReady,
		onExit: props.onExit,
		autoFocus: props.autoFocus,
		isVisible: props.isVisible,
		sessionStartedAt: props.summary?.startedAt ?? null,
		terminalBackgroundColor: props.terminalBackgroundColor ?? "var(--color-surface-1)",
		cursorColor: props.cursorColor ?? "var(--color-text-primary)",
		scrollOnEraseInDisplay: props.scrollOnEraseInDisplay,
	});

	const chatViewEnabled = props.chatViewEnabled ?? false;
	const { lines: chatLines, clear: clearChat } = useChatOutput({
		taskId: props.taskId,
		workspaceId: props.workspaceId,
		enabled: (props.terminalEnabled ?? true) && chatViewEnabled,
		terminalBackgroundColor: props.terminalBackgroundColor ?? "var(--color-surface-1)",
		cursorColor: props.cursorColor ?? "var(--color-text-primary)",
	});

	return (
		<AgentTerminalPanelLayout
			{...props}
			sessionControls={sessionControls}
			chatLines={chatLines}
			onClearChat={clearChat}
		/>
	);
}
