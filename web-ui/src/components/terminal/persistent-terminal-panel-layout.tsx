import "@xterm/xterm/css/xterm.css";

import { Command, Eraser, Maximize2, MessageSquare, Minimize2, RotateCw, X } from "lucide-react";
import type { MutableRefObject, ReactElement } from "react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import { isMacPlatform } from "@/utils/platform";
import { describeSessionState, getSessionStatusBadgeStyle, statusBadgeColors } from "@/utils/session-status";

export interface PersistentTerminalSessionControls {
	clearTerminal: () => void;
	containerRef: MutableRefObject<HTMLDivElement | null>;
	isLoading: boolean;
	isStopping: boolean;
	lastError: string | null;
	stopTerminal: () => Promise<void>;
}

export interface PersistentTerminalPanelLayoutProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	sessionControls: PersistentTerminalSessionControls;
	showSessionToolbar?: boolean;
	onClose?: () => void;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	headerTitle?: string;
	headerSubtitle?: string | null;
	panelBackgroundColor?: string;
	terminalBackgroundColor?: string;
	commandAction?: {
		command: string | null;
		onRun: () => void;
	};
	isExpanded?: boolean;
	onToggleExpand?: () => void;
	onRestart?: () => void;
}

export function PersistentTerminalPanelLayout({
	taskId,
	summary,
	sessionControls,
	showSessionToolbar = true,
	onClose,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	headerTitle = "Terminal",
	headerSubtitle = null,
	panelBackgroundColor = "var(--color-surface-1)",
	terminalBackgroundColor = "var(--color-surface-1)",
	commandAction,
	isExpanded = false,
	onToggleExpand,
	onRestart,
}: PersistentTerminalPanelLayoutProps): ReactElement {
	const { containerRef, isLoading, lastError, isStopping, clearTerminal, stopTerminal } = sessionControls;
	const canStop = summary?.state === "running" || summary?.state === "awaiting_review";
	const statusLabel = useMemo(() => describeSessionState(summary), [summary]);
	const statusTagStyle = useMemo(() => getSessionStatusBadgeStyle(summary), [summary]);
	const commandLabel = useMemo(() => {
		const normalizedCommand = commandAction?.command?.trim();
		if (!normalizedCommand) {
			return null;
		}
		return normalizedCommand.split(/\s+/)[0] ?? null;
	}, [commandAction?.command]);

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
							<Button variant="default" size="sm" onClick={clearTerminal}>
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
							{headerTitle}
						</span>
						{headerSubtitle ? (
							<span
								className="truncate font-mono text-text-secondary"
								style={{ fontSize: 10 }}
								title={headerSubtitle}
							>
								{headerSubtitle}
							</span>
						) : null}
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: 2, marginRight: "-6px" }}>
						{commandLabel && commandAction ? (
							<Tooltip side="top" content={`Run ${commandLabel}`}>
								<Button
									icon={<MessageSquare size={12} />}
									variant="ghost"
									size="sm"
									onClick={commandAction.onRun}
									aria-label={`Run ${commandLabel}`}
								/>
							</Tooltip>
						) : null}
						<Tooltip side="top" content="Clear">
							<Button
								icon={<Eraser size={12} />}
								variant="ghost"
								size="sm"
								onClick={clearTerminal}
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
				onClick={() => getTerminalController(taskId)?.focus?.()}
			>
				<div
					ref={containerRef}
					className="kb-terminal-container"
					style={{
						height: "100%",
						width: "100%",
						position: "relative",
						background: terminalBackgroundColor,
						overflow: "hidden",
					}}
				>
					{isLoading ? (
						<div className="absolute inset-0 z-10 flex items-center justify-center">
							<Spinner size={24} />
						</div>
					) : null}
				</div>
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
