import type { WebSocket } from "ws";

import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import type { TerminalSessionService } from "./terminal-session-service";
import {
	type TerminalOutputCursor,
	type TerminalRestoreSnapshot,
	TerminalRestoreSnapshotUnavailableError,
} from "./terminal-state-mirror";
import { SNAPSHOT_DEFER_TIMEOUT_MS, sendControlMessage } from "./terminal-ws-protocol";
import type { IoOutputState, TerminalViewerState } from "./terminal-ws-types";

const log = createTaggedLogger("ws-server");

export const TERMINAL_RESTORE_MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const TERMINAL_RESTORE_MAX_PENDING_CHUNKS = 4096;
export const TERMINAL_RESTORE_TIMEOUT_MS = 10_000;

interface ViewerSessionRequest {
	viewerState: TerminalViewerState;
	ws: WebSocket;
	terminalManager: TerminalSessionService;
	taskId: string;
}

interface RestoreCycle {
	request: ViewerSessionRequest;
	snapshotSent: boolean;
	queuedRequest: ViewerSessionRequest | null;
	aborted: boolean;
	wakeIoChange: (() => void) | null;
}

interface HandleResizeRequest extends ViewerSessionRequest {
	cols: number;
	rows: number;
	pixelWidth?: number;
	pixelHeight?: number;
	force?: boolean;
}

export interface TerminalRestoreSnapshotObservation {
	taskId: string;
	clientId: string;
	connectionId: string | null;
	durationMs: number;
	snapshotBytes: number;
}

export interface TerminalWsRestoreCoordinatorObserver {
	onSnapshotSent?: (observation: TerminalRestoreSnapshotObservation) => void;
	onSnapshotFailed?: (observation: TerminalRestoreSnapshotObservation & { errorClass: string }) => void;
}

export class TerminalWsRestoreCoordinator {
	private readonly restoreCycles = new WeakMap<TerminalViewerState, RestoreCycle>();
	private readonly flushingViewers = new WeakSet<TerminalViewerState>();
	private readonly disconnectedViewers = new WeakSet<TerminalViewerState>();
	private readonly viewersNeedingRecapture = new WeakSet<TerminalViewerState>();

	constructor(private readonly observer: TerminalWsRestoreCoordinatorObserver = {}) {}

	beginInitialRestore(request: ViewerSessionRequest): void {
		if (request.viewerState.controlSocket !== request.ws) return;
		const cycle = this.beginRestoreCycle(request);
		request.viewerState.restore.deferredSnapshotTimer = setTimeout(() => {
			if (!this.ownsRestoreCycle(cycle)) return;
			request.viewerState.restore.deferredSnapshotTimer = null;
			void this.sendRestoreSnapshot(cycle);
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
		if (viewerState.controlSocket !== ws) return;
		terminalManager.resize(taskId, cols, rows, pixelWidth, pixelHeight, force);
		if (viewerState.restore.deferredSnapshotTimer === null) return;
		this.clearDeferredSnapshot(viewerState);
		const cycle = this.restoreCycles.get(viewerState);
		if (cycle) void this.sendRestoreSnapshot(cycle);
	}

	requestRestore(request: ViewerSessionRequest): void {
		const { viewerState, ws } = request;
		if (viewerState.controlSocket !== ws) return;
		const cycle = this.restoreCycles.get(viewerState);
		if (cycle?.aborted && cycle.request.ws === ws) return;
		if (cycle?.request.ws === ws && cycle.snapshotSent && !viewerState.restore.restoreComplete) {
			// The wire acknowledgement has no restore ID. Serialize sent snapshots
			// so an older ack cannot release a newer restore's pending output.
			cycle.queuedRequest = request;
			return;
		}
		void this.sendRestoreSnapshot(this.beginRestoreCycle(request));
	}

	completeRestore(viewerState: TerminalViewerState, ws: WebSocket): void {
		const cycle = this.restoreCycles.get(viewerState);
		if (
			!cycle ||
			cycle.request.ws !== ws ||
			!this.ownsRestoreCycle(cycle) ||
			!cycle.snapshotSent ||
			viewerState.restore.restoreComplete
		) {
			return;
		}
		if (cycle.queuedRequest) {
			void this.sendRestoreSnapshot(this.beginRestoreCycle(cycle.queuedRequest));
			return;
		}
		this.clearRestoreTimeout(viewerState);
		viewerState.restore.restoreComplete = true;
		viewerState.restoreStartedAt = null;
		viewerState.lastProtocolActivityAt = Date.now();
		this.flushPendingOutput(viewerState);
	}

	onIoSocketConnected(viewerState: TerminalViewerState): void {
		this.notifyIoConnectionChanged(viewerState);
		if (this.viewersNeedingRecapture.has(viewerState)) {
			const cycle = this.restoreCycles.get(viewerState);
			if (cycle && this.ownsRestoreCycle(cycle) && viewerState.restore.deferredSnapshotTimer === null) {
				this.requestRestore(cycle.request);
			}
			return;
		}
		this.flushPendingOutput(viewerState);
	}

	onIoSocketDisconnected(viewerState: TerminalViewerState): void {
		this.notifyIoConnectionChanged(viewerState);
	}

	private notifyIoConnectionChanged(viewerState: TerminalViewerState): void {
		const cycle = this.restoreCycles.get(viewerState);
		const wake = cycle?.wakeIoChange;
		if (cycle) cycle.wakeIoChange = null;
		wake?.();
	}

	handleLiveOutput(viewerState: TerminalViewerState, chunk: Buffer, outputCursor: TerminalOutputCursor | null): void {
		if (this.disconnectedViewers.has(viewerState) || this.isCoveredBySnapshot(viewerState, outputCursor)) return;
		if (!viewerState.ioSocket) {
			// Keep no unbounded transcript while IO is absent. The current
			// snapshot is now insufficient, so attachment must recapture first.
			this.viewersNeedingRecapture.add(viewerState);
			return;
		}
		if (
			viewerState.restore.restoreComplete &&
			viewerState.ioState &&
			!this.viewersNeedingRecapture.has(viewerState) &&
			!this.flushingViewers.has(viewerState)
		) {
			viewerState.ioState.enqueueOutput(chunk);
			return;
		}
		if (
			viewerState.restore.pendingOutputBytes + chunk.byteLength > TERMINAL_RESTORE_MAX_PENDING_BYTES ||
			viewerState.restore.pendingOutputChunks.length >= TERMINAL_RESTORE_MAX_PENDING_CHUNKS
		) {
			this.disconnectViewer(viewerState, "Terminal restore buffer exceeded; reconnect to resynchronize.");
			return;
		}
		viewerState.restore.pendingOutputChunks.push({ chunk, outputCursor });
		viewerState.restore.pendingOutputBytes += chunk.byteLength;
	}

	clearDeferredSnapshot(viewerState: TerminalViewerState, ws?: WebSocket): void {
		if (ws && viewerState.controlSocket !== ws) return;
		if (viewerState.restore.deferredSnapshotTimer === null) return;
		clearTimeout(viewerState.restore.deferredSnapshotTimer);
		viewerState.restore.deferredSnapshotTimer = null;
	}

	private clearRestoreTimeout(viewerState: TerminalViewerState): void {
		if (viewerState.restore.restoreTimeoutTimer === null) return;
		clearTimeout(viewerState.restore.restoreTimeoutTimer);
		viewerState.restore.restoreTimeoutTimer = null;
	}

	private beginRestoreCycle(request: ViewerSessionRequest): RestoreCycle {
		const { viewerState } = request;
		this.notifyIoConnectionChanged(viewerState);
		this.clearDeferredSnapshot(viewerState);
		this.clearRestoreTimeout(viewerState);
		viewerState.restore.restoreComplete = false;
		this.disconnectedViewers.delete(viewerState);
		// Retain bytes until a successful snapshot proves coverage. Failed/null
		// captures and superseded async results cannot claim any buffered bytes.
		viewerState.restoreStartedAt = Date.now();
		viewerState.lastProtocolActivityAt = Date.now();
		const cycle: RestoreCycle = {
			request,
			snapshotSent: false,
			queuedRequest: null,
			aborted: false,
			wakeIoChange: null,
		};
		this.restoreCycles.set(viewerState, cycle);
		viewerState.restore.restoreTimeoutTimer = setTimeout(() => {
			if (this.ownsRestoreCycle(cycle)) {
				this.disconnectViewer(viewerState, "Terminal restore timed out; reconnect to resynchronize.");
			}
		}, TERMINAL_RESTORE_TIMEOUT_MS);
		return cycle;
	}

	private ownsRestoreCycle(cycle: RestoreCycle): boolean {
		const { viewerState, ws } = cycle.request;
		return !cycle.aborted && this.restoreCycles.get(viewerState) === cycle && viewerState.controlSocket === ws;
	}

	private disconnectViewer(viewerState: TerminalViewerState, reason: string): void {
		const ioState = viewerState.ioState;
		const ioSocket = viewerState.ioSocket;
		const controlSocket = viewerState.controlSocket;
		const cycle = this.restoreCycles.get(viewerState);
		if (cycle) cycle.aborted = true;
		this.notifyIoConnectionChanged(viewerState);
		this.disconnectedViewers.add(viewerState);
		this.clearDeferredSnapshot(viewerState);
		this.clearRestoreTimeout(viewerState);
		viewerState.restore.restoreComplete = false;
		viewerState.restore.pendingOutputChunks = [];
		viewerState.restore.pendingOutputBytes = 0;
		ioState?.dispose();
		// A bounded restore gap fails explicitly. Never silently trim a terminal
		// byte stream: reconnect obtains a fresh authoritative snapshot instead.
		ioSocket?.close(1013, reason);
		controlSocket?.close(1013, reason);
	}

	private isCoveredBySnapshot(viewerState: TerminalViewerState, outputCursor: TerminalOutputCursor | null): boolean {
		const snapshotCursor = viewerState.restore.snapshotCursor;
		return (
			outputCursor !== null &&
			snapshotCursor !== null &&
			outputCursor.streamId === snapshotCursor.streamId &&
			outputCursor.sequence <= snapshotCursor.sequence
		);
	}

	private flushPendingOutput(viewerState: TerminalViewerState): void {
		if (this.flushingViewers.has(viewerState)) return;
		const cycle = this.restoreCycles.get(viewerState);
		this.flushingViewers.add(viewerState);
		try {
			while (
				viewerState.restore.restoreComplete &&
				!this.viewersNeedingRecapture.has(viewerState) &&
				viewerState.ioState &&
				(!cycle || this.ownsRestoreCycle(cycle)) &&
				viewerState.restore.pendingOutputChunks.length > 0
			) {
				const output = viewerState.restore.pendingOutputChunks.shift();
				if (!output) break;
				viewerState.restore.pendingOutputBytes -= output.chunk.byteLength;
				if (!this.isCoveredBySnapshot(viewerState, output.outputCursor)) {
					// Resolve IO ownership for every chunk. enqueueOutput may reenter
					// restore, append output, or replace/dispose the current socket.
					viewerState.ioState.enqueueOutput(output.chunk);
				}
			}
		} finally {
			this.flushingViewers.delete(viewerState);
		}
	}

	private async drainIoOutput(cycle: RestoreCycle): Promise<IoOutputState | null | false> {
		const { viewerState } = cycle.request;
		try {
			while (this.ownsRestoreCycle(cycle)) {
				const ioState = viewerState.ioState;
				if (!ioState) return null;
				const drained = await ioState.drainOutput();
				if (!this.ownsRestoreCycle(cycle)) return false;
				if (viewerState.ioState !== ioState) continue;
				if (drained) return ioState;
				// Reconnect can deliver its new control/resize before the old IO
				// closes or its replacement attaches. Wait for that ownership
				// change under the existing restore deadline, not a second timer.
				await new Promise<void>((resolve) => {
					cycle.wakeIoChange = resolve;
				});
			}
		} catch {
			if (this.ownsRestoreCycle(cycle)) {
				this.disconnectViewer(viewerState, "Terminal IO drain failed; reconnect to resynchronize.");
			}
		}
		return false;
	}

	private async sendRestoreSnapshot(cycle: RestoreCycle): Promise<void> {
		if (!this.ownsRestoreCycle(cycle)) return;
		const { viewerState, ws, terminalManager, taskId } = cycle.request;
		for (;;) {
			const drainedIo = await this.drainIoOutput(cycle);
			if (drainedIo === false || !this.ownsRestoreCycle(cycle)) return;
			// The helper's resolution is itself an async boundary. A replacement
			// IO attached in that gap must be drained before capture as well.
			if (viewerState.ioState === drainedIo) break;
		}
		const t0 = performance.now();
		let snapshot: TerminalRestoreSnapshot | null = null;
		let errorClass: string | null = null;
		try {
			snapshot = await terminalManager.getRestoreSnapshot(taskId);
		} catch (error) {
			if (error instanceof TerminalRestoreSnapshotUnavailableError) {
				if (this.ownsRestoreCycle(cycle)) {
					this.disconnectViewer(viewerState, "Terminal output is not snapshot-safe; reconnect to resynchronize.");
				}
				return;
			}
			errorClass = error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError";
		}
		if (!this.ownsRestoreCycle(cycle)) return;
		if (snapshot === null && this.viewersNeedingRecapture.has(viewerState)) {
			this.disconnectViewer(viewerState, "Terminal output recovery unavailable; reconnect to resynchronize.");
			return;
		}
		const observation = {
			taskId,
			clientId: viewerState.clientId,
			connectionId: viewerState.controlConnectionId,
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
			snapshotBytes: Buffer.byteLength(snapshot?.snapshot ?? ""),
		};
		log.debug("[perf] sendRestoreSnapshot", { ...observation, snapshotLength: snapshot?.snapshot.length ?? 0 });
		try {
			sendControlMessage(ws, {
				type: "restore",
				snapshot: snapshot?.snapshot ?? "",
				cols: snapshot?.cols ?? null,
				rows: snapshot?.rows ?? null,
			});
		} catch {
			this.disconnectViewer(viewerState, "Terminal restore delivery failed; reconnect to resynchronize.");
			return;
		}
		if (!this.ownsRestoreCycle(cycle)) return;
		viewerState.restore.snapshotCursor = snapshot?.outputCursor ?? null;
		cycle.snapshotSent = true;
		if (snapshot && viewerState.ioSocket && viewerState.ioState) this.viewersNeedingRecapture.delete(viewerState);
		// Diagnostics observers are not restore delivery. Their failure must
		// never send a second, empty snapshot after a successful restore.
		try {
			if (errorClass !== null) this.observer.onSnapshotFailed?.({ ...observation, errorClass });
			else this.observer.onSnapshotSent?.(observation);
		} catch {
			log.warn("Terminal restore observer failed", { taskId, clientId: viewerState.clientId });
		}
	}
}
