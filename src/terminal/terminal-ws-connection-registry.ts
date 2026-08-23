import type { WebSocket } from "ws";
import type { DiagnosticCaptureScope } from "../core";

import {
	createTerminalStreamState,
	createTerminalViewerState,
	type IoOutputState,
	type TerminalStreamState,
	type TerminalViewerState,
} from "./terminal-ws-types";

export interface TerminalWsDiagnosticSnapshot {
	streamCount: number;
	viewerCount: number;
	viewers: Array<{
		projectId: string;
		taskId: string;
		clientId: string;
		ioConnectionId: string | null;
		controlConnectionId: string | null;
		ioConnected: boolean;
		controlConnected: boolean;
		ioConnectedAt: number | null;
		controlConnectedAt: number | null;
		lastProtocolActivityAt: number | null;
		restoreComplete: boolean;
		restoreStartedAt: number | null;
		pendingRestoreBytes: number;
		backpressured: boolean;
	}>;
}

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

	replaceIoConnection(
		viewerState: TerminalViewerState,
		ws: WebSocket,
		ioState: IoOutputState,
		connectionId: string,
	): WebSocket | null {
		const previousIoSocket = viewerState.ioSocket;
		viewerState.ioState?.dispose();
		viewerState.ioState = ioState;
		viewerState.ioSocket = ws;
		viewerState.ioConnectionId = connectionId;
		viewerState.ioConnectedAt = Date.now();
		viewerState.lastProtocolActivityAt = Date.now();
		return previousIoSocket && previousIoSocket !== ws ? previousIoSocket : null;
	}

	replaceControlConnection(viewerState: TerminalViewerState, ws: WebSocket, connectionId: string): WebSocket | null {
		const previousControlSocket = viewerState.controlSocket;
		viewerState.controlSocket = ws;
		viewerState.controlConnectionId = connectionId;
		viewerState.controlConnectedAt = Date.now();
		viewerState.lastProtocolActivityAt = Date.now();
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
		viewerState.ioConnectionId = null;
		viewerState.ioConnectedAt = null;
		viewerState.ioState?.dispose();
		viewerState.ioState = null;
		this.cleanupViewerStateIfUnused(connectionKey, viewerState);
	}

	detachControlSocket(connectionKey: string, viewerState: TerminalViewerState, ws: WebSocket): void {
		if (viewerState.controlSocket !== ws) {
			return;
		}
		viewerState.controlSocket = null;
		viewerState.controlConnectionId = null;
		viewerState.controlConnectedAt = null;
		viewerState.detachControlListener?.();
		viewerState.detachControlListener = null;
		this.cleanupViewerStateIfUnused(connectionKey, viewerState);
	}

	getDiagnosticSnapshot(scope: Readonly<DiagnosticCaptureScope> = {}): TerminalWsDiagnosticSnapshot {
		const viewers = [];
		let streamCount = 0;
		for (const [connectionKey, stream] of this.terminalStreamStates) {
			const separator = connectionKey.indexOf(":");
			const projectId = separator >= 0 ? connectionKey.slice(0, separator) : connectionKey;
			const taskId = separator >= 0 ? connectionKey.slice(separator + 1) : "";
			if (scope.projectId && projectId !== scope.projectId) continue;
			if (scope.taskId && taskId !== scope.taskId) continue;
			streamCount += 1;
			for (const viewer of stream.viewers.values()) {
				viewers.push({
					projectId,
					taskId,
					clientId: viewer.clientId,
					ioConnectionId: viewer.ioConnectionId,
					controlConnectionId: viewer.controlConnectionId,
					ioConnected: viewer.ioSocket !== null,
					controlConnected: viewer.controlSocket !== null,
					ioConnectedAt: viewer.ioConnectedAt,
					controlConnectedAt: viewer.controlConnectedAt,
					lastProtocolActivityAt: viewer.lastProtocolActivityAt,
					restoreComplete: viewer.restore.restoreComplete,
					restoreStartedAt: viewer.restoreStartedAt,
					pendingRestoreBytes: viewer.restore.pendingOutputChunks.reduce(
						(total, chunk) => total + chunk.byteLength,
						0,
					),
					backpressured: stream.backpressuredViewerIds.has(viewer.clientId),
				});
			}
		}
		return { streamCount, viewerCount: viewers.length, viewers };
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
