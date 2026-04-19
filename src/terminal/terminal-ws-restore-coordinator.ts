import type { WebSocket } from "ws";

import { createTaggedLogger } from "../core";
import type { TerminalSessionService } from "./terminal-session-service";
import { SNAPSHOT_DEFER_TIMEOUT_MS, sendControlMessage } from "./terminal-ws-protocol";
import type { TerminalViewerState } from "./terminal-ws-types";

const log = createTaggedLogger("ws-server");

interface ViewerSessionRequest {
	viewerState: TerminalViewerState;
	ws: WebSocket;
	terminalManager: TerminalSessionService;
	taskId: string;
}

interface HandleResizeRequest extends ViewerSessionRequest {
	cols: number;
	rows: number;
	pixelWidth?: number;
	pixelHeight?: number;
	force?: boolean;
}

export class TerminalWsRestoreCoordinator {
	beginInitialRestore({ viewerState, ws, terminalManager, taskId }: ViewerSessionRequest): void {
		this.resetRestoreState(viewerState);
		viewerState.restore.deferredSnapshotTimer = setTimeout(() => {
			viewerState.restore.deferredSnapshotTimer = null;
			void this.sendRestoreSnapshot({ viewerState, ws, terminalManager, taskId });
		}, SNAPSHOT_DEFER_TIMEOUT_MS);
	}

	handleResize({
		viewerState,
		ws,
		terminalManager,
		taskId,
		cols,
		rows,
		pixelWidth,
		pixelHeight,
		force,
	}: HandleResizeRequest): void {
		terminalManager.resize(taskId, cols, rows, pixelWidth, pixelHeight, force);
		if (viewerState.restore.deferredSnapshotTimer === null) {
			return;
		}
		clearTimeout(viewerState.restore.deferredSnapshotTimer);
		viewerState.restore.deferredSnapshotTimer = null;
		void this.sendRestoreSnapshot({ viewerState, ws, terminalManager, taskId });
	}

	requestRestore({ viewerState, ws, terminalManager, taskId }: ViewerSessionRequest): void {
		this.resetRestoreState(viewerState);
		void this.sendRestoreSnapshot({ viewerState, ws, terminalManager, taskId });
	}

	completeRestore(viewerState: TerminalViewerState): void {
		viewerState.restore.restoreComplete = true;
		this.flushPendingOutput(viewerState);
	}

	onIoSocketConnected(viewerState: TerminalViewerState): void {
		this.flushPendingOutput(viewerState);
	}

	handleLiveOutput(viewerState: TerminalViewerState, chunk: Buffer): void {
		if (viewerState.restore.restoreComplete && viewerState.ioState) {
			viewerState.ioState.enqueueOutput(chunk);
			return;
		}
		if (viewerState.ioSocket) {
			viewerState.restore.pendingOutputChunks.push(chunk);
		}
	}

	clearDeferredSnapshot(viewerState: TerminalViewerState, ws?: WebSocket): void {
		if (ws && viewerState.controlSocket !== ws) {
			return;
		}
		if (viewerState.restore.deferredSnapshotTimer === null) {
			return;
		}
		clearTimeout(viewerState.restore.deferredSnapshotTimer);
		viewerState.restore.deferredSnapshotTimer = null;
	}

	private resetRestoreState(viewerState: TerminalViewerState): void {
		this.clearDeferredSnapshot(viewerState);
		viewerState.restore.restoreComplete = false;
		viewerState.restore.pendingOutputChunks = [];
	}

	private flushPendingOutput(viewerState: TerminalViewerState): void {
		if (
			!viewerState.restore.restoreComplete ||
			!viewerState.ioState ||
			viewerState.restore.pendingOutputChunks.length === 0
		) {
			return;
		}
		for (const chunk of viewerState.restore.pendingOutputChunks) {
			viewerState.ioState.enqueueOutput(chunk);
		}
		viewerState.restore.pendingOutputChunks = [];
	}

	private async sendRestoreSnapshot({
		viewerState,
		ws,
		terminalManager,
		taskId,
	}: ViewerSessionRequest): Promise<void> {
		if (viewerState.controlSocket !== ws) {
			return;
		}
		const t0 = performance.now();
		try {
			const snapshot = await terminalManager.getRestoreSnapshot(taskId);
			const totalMs = Math.round((performance.now() - t0) * 100) / 100;
			const snapshotLength = snapshot?.snapshot?.length ?? 0;
			log.debug("[perf] sendRestoreSnapshot", {
				totalMs,
				snapshotLength,
				taskId,
			});
			if (viewerState.controlSocket !== ws) {
				return;
			}
			sendControlMessage(ws, {
				type: "restore",
				snapshot: snapshot?.snapshot ?? "",
				cols: snapshot?.cols ?? null,
				rows: snapshot?.rows ?? null,
			});
		} catch {
			if (viewerState.controlSocket !== ws) {
				return;
			}
			sendControlMessage(ws, {
				type: "restore",
				snapshot: "",
				cols: null,
				rows: null,
			});
		}
	}
}
