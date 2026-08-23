import type { WebSocket } from "ws";

export interface IoOutputState {
	enqueueOutput: (chunk: Buffer) => void;
	acknowledgeOutput: (bytes: number) => void;
	dispose: () => void;
}

export interface TerminalViewerRestoreState {
	pendingOutputChunks: Buffer[];
	restoreComplete: boolean;
	deferredSnapshotTimer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalViewerState {
	clientId: string;
	ioConnectionId: string | null;
	controlConnectionId: string | null;
	ioConnectedAt: number | null;
	controlConnectedAt: number | null;
	lastProtocolActivityAt: number | null;
	restoreStartedAt: number | null;
	restore: TerminalViewerRestoreState;
	ioState: IoOutputState | null;
	ioSocket: WebSocket | null;
	controlSocket: WebSocket | null;
	detachControlListener: (() => void) | null;
}

export interface TerminalStreamState {
	viewers: Map<string, TerminalViewerState>;
	backpressuredViewerIds: Set<string>;
	detachOutputListener: (() => void) | null;
}

export function createTerminalViewerState(clientId: string): TerminalViewerState {
	return {
		clientId,
		ioConnectionId: null,
		controlConnectionId: null,
		ioConnectedAt: null,
		controlConnectedAt: null,
		lastProtocolActivityAt: null,
		restoreStartedAt: null,
		restore: {
			pendingOutputChunks: [],
			restoreComplete: false,
			deferredSnapshotTimer: null,
		},
		ioState: null,
		ioSocket: null,
		controlSocket: null,
		detachControlListener: null,
	};
}

export function createTerminalStreamState(): TerminalStreamState {
	return {
		viewers: new Map(),
		backpressuredViewerIds: new Set(),
		detachOutputListener: null,
	};
}
