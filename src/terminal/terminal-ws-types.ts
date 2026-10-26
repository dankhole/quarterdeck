import type { WebSocket } from "ws";
import type { TerminalOutputCursor } from "./terminal-state-mirror";

export interface IoOutputState {
	enqueueOutput: (chunk: Buffer) => void;
	acknowledgeOutput: (bytes: number) => void;
	/** Flush pending batches and wait until the browser has applied every sent byte. */
	drainOutput: () => Promise<boolean>;
	dispose: () => void;
}

export interface TerminalViewerRestoreState {
	pendingOutputChunks: Array<{ chunk: Buffer; outputCursor: TerminalOutputCursor | null }>;
	snapshotCursor: TerminalOutputCursor | null;
	pendingOutputBytes: number;
	restoreTimeoutTimer: ReturnType<typeof setTimeout> | null;
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
			snapshotCursor: null,
			pendingOutputBytes: 0,
			restoreTimeoutTimer: null,
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
