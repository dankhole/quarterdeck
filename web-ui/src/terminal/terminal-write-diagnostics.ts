export type TerminalWritePoolRole = "FREE" | "PRELOADING" | "READY" | "ACTIVE" | "PREVIOUS";

export type TerminalWriteVisibility = "visible" | "hidden-staged" | "hidden-parked";

export type TerminalSocketState = "none" | "connecting" | "open" | "closing" | "closed" | "unknown";

export interface TerminalWriteSocketDiagnostics {
	ioSocketState: TerminalSocketState;
	controlSocketState: TerminalSocketState;
	connectionReady: boolean;
	restoreCompleted: boolean;
}

export interface TerminalWriteDiagnostics extends TerminalWriteSocketDiagnostics {
	slotId: number;
	taskId: string | null;
	poolRole: TerminalWritePoolRole | null;
	visibility: TerminalWriteVisibility;
}
