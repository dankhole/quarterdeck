import type { WebSocket } from "ws";

import {
	createTerminalStreamState,
	createTerminalViewerState,
	type IoOutputState,
	type TerminalStreamState,
	type TerminalViewerState,
} from "./terminal-ws-types";

export class TerminalWsConnectionRegistry {
	private readonly terminalStreamStates = new Map<string, TerminalStreamState>();

	getOrCreateStream(connectionKey: string): TerminalStreamState {
		const existing = this.terminalStreamStates.get(connectionKey);
		if (existing) {
			return existing;
		}
		const created = createTerminalStreamState();
		this.terminalStreamStates.set(connectionKey, created);
		return created;
	}

	getOrCreateViewer(
		connectionKey: string,
		clientId: string,
	): {
		streamState: TerminalStreamState;
		viewerState: TerminalViewerState;
	} {
		const streamState = this.getOrCreateStream(connectionKey);
		const existingViewer = streamState.viewers.get(clientId);
		if (existingViewer) {
			return { streamState, viewerState: existingViewer };
		}
		const createdViewer = createTerminalViewerState(clientId);
		streamState.viewers.set(clientId, createdViewer);
		return { streamState, viewerState: createdViewer };
	}

	replaceIoConnection(viewerState: TerminalViewerState, ws: WebSocket, ioState: IoOutputState): WebSocket | null {
		const previousIoSocket = viewerState.ioSocket;
		viewerState.ioState?.dispose();
		viewerState.ioState = ioState;
		viewerState.ioSocket = ws;
		return previousIoSocket && previousIoSocket !== ws ? previousIoSocket : null;
	}

	replaceControlConnection(viewerState: TerminalViewerState, ws: WebSocket): WebSocket | null {
		const previousControlSocket = viewerState.controlSocket;
		viewerState.controlSocket = ws;
		return previousControlSocket && previousControlSocket !== ws ? previousControlSocket : null;
	}

	replaceControlListener(viewerState: TerminalViewerState, detachControlListener: (() => void) | null): void {
		viewerState.detachControlListener?.();
		viewerState.detachControlListener = detachControlListener;
	}

	detachIoSocket(connectionKey: string, viewerState: TerminalViewerState, ws: WebSocket): void {
		if (viewerState.ioSocket !== ws) {
			return;
		}
		viewerState.ioSocket = null;
		viewerState.ioState?.dispose();
		viewerState.ioState = null;
		this.cleanupViewerStateIfUnused(connectionKey, viewerState);
	}

	detachControlSocket(connectionKey: string, viewerState: TerminalViewerState, ws: WebSocket): void {
		if (viewerState.controlSocket !== ws) {
			return;
		}
		viewerState.controlSocket = null;
		viewerState.detachControlListener?.();
		viewerState.detachControlListener = null;
		this.cleanupViewerStateIfUnused(connectionKey, viewerState);
	}

	private cleanupViewerStateIfUnused(connectionKey: string, viewerState: TerminalViewerState): void {
		if (viewerState.ioSocket || viewerState.controlSocket) {
			return;
		}

		const streamState = this.terminalStreamStates.get(connectionKey);
		if (!streamState) {
			return;
		}

		if (viewerState.restore.deferredSnapshotTimer !== null) {
			clearTimeout(viewerState.restore.deferredSnapshotTimer);
			viewerState.restore.deferredSnapshotTimer = null;
		}
		viewerState.restore.pendingOutputChunks = [];
		streamState.backpressuredViewerIds.delete(viewerState.clientId);
		streamState.viewers.delete(viewerState.clientId);

		if (streamState.viewers.size > 0) {
			return;
		}

		streamState.detachOutputListener?.();
		streamState.detachOutputListener = null;
		streamState.backpressuredViewerIds.clear();
		this.terminalStreamStates.delete(connectionKey);
	}
}
