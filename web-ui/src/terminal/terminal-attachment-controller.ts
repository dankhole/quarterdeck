import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { type PersistentTerminalSubscriber, TerminalSessionHandle } from "@/terminal/terminal-session-handle";
import { type PersistentTerminalAppearance, TerminalViewport } from "@/terminal/terminal-viewport";

export type { PersistentTerminalSubscriber } from "@/terminal/terminal-session-handle";

// Full console.trace stacks are expensive if the reconnect path loops. Keep one
// breadcrumb, then sample at most once per window.
const SESSION_INSTANCE_TRACE_SAMPLE_INTERVAL_MS = 5000;
let sessionInstanceReconnectTraceCount = 0;
let sessionInstanceReconnectLastTraceAt = 0;

interface SessionInstanceReconnectTraceData {
	slotId: number;
	taskId: string | null;
	prevPid: number | null;
	nextPid: number | null;
	prevStartedAt: number | null;
	nextStartedAt: number | null;
	prevState: RuntimeTaskSessionSummary["state"] | null;
	nextState: RuntimeTaskSessionSummary["state"];
}

function maybeTraceSessionInstanceReconnect(data: SessionInstanceReconnectTraceData): void {
	sessionInstanceReconnectTraceCount += 1;
	const now = performance.now();
	const shouldTrace =
		sessionInstanceReconnectTraceCount === 1 ||
		now - sessionInstanceReconnectLastTraceAt >= SESSION_INSTANCE_TRACE_SAMPLE_INTERVAL_MS;
	if (!shouldTrace) {
		return;
	}
	sessionInstanceReconnectLastTraceAt = now;
	console.trace("[quarterdeck-debug] terminal reconnect on session_instance_changed", {
		...data,
		traceCount: sessionInstanceReconnectTraceCount,
	});
}

interface TerminalAttachmentControllerOptions {
	isDisposed: () => boolean;
}

export class TerminalAttachmentController {
	private readonly viewport: TerminalViewport;
	private readonly session: TerminalSessionHandle;
	private showTimestamp: number | null = null;

	constructor(
		private readonly slotId: number,
		appearance: PersistentTerminalAppearance,
		private readonly options: TerminalAttachmentControllerOptions,
	) {
		this.viewport = this.createViewport(appearance);
		this.session = this.createSessionHandle();
	}

	get visibleContainer(): HTMLDivElement | null {
		return this.viewport.visibleContainer;
	}

	get stageContainer(): HTMLDivElement | null {
		return this.viewport.stageContainer;
	}

	get connectedTaskId(): string | null {
		return this.session.connectedTaskId;
	}

	get connectedProjectId(): string | null {
		return this.session.connectedProjectId;
	}

	get hasIoSocket(): boolean {
		return this.session.hasIoSocket;
	}

	get hasControlSocket(): boolean {
		return this.session.hasControlSocket;
	}

	get isIoOpen(): boolean {
		return this.session.isIoOpen;
	}

	get sessionState(): string | null {
		return this.session.sessionState;
	}

	get sessionAgentId(): RuntimeTaskSessionSummary["agentId"] | null {
		return this.session.sessionAgentId;
	}

	private createViewport(appearance: PersistentTerminalAppearance): TerminalViewport {
		return new TerminalViewport(this.slotId, appearance, {
			clearGeometry: clearTerminalGeometry,
			getConnectedTaskId: () => this.connectedTaskId,
			isDisposed: () => this.options.isDisposed(),
			notifyOutputText: (text) => this.session.publishOutputText(text),
			reportGeometry: reportTerminalGeometry,
			sendControlMessage: (msg) => this.session.sendControl(msg),
			sendIoData: (data) => this.session.sendIo(data),
		});
	}

	private createSessionHandle(): TerminalSessionHandle {
		return new TerminalSessionHandle(this.slotId, {
			enqueueWrite: (data, options) => {
				void this.viewport.enqueueWrite(data, options);
			},
			applyRestore: async (snapshot, cols, rows) => {
				await this.viewport.applyRestoreSnapshot(snapshot, cols, rows);
				this.viewport.finalizeRestorePresentation({
					hasActiveIoSocket: this.session.hasIoSocket,
					onInteractive: () => {
						this.session.notifyConnectionReadyAfterRestore(this.showTimestamp);
						this.showTimestamp = null;
					},
				});
			},
			onSummaryStateChange: (summary, previousSummary) => {
				this.handleSessionStateChange(summary, previousSummary);
			},
			onExit: (code) => {
				this.handleSessionExit(code);
			},
			ensureVisible: () => this.viewport.ensureVisible(),
			invalidateResize: () => this.viewport.invalidateResize(),
			requestResize: () => this.viewport.requestResize(),
			getVisibleContainer: () => this.visibleContainer,
			getStageContainer: () => this.stageContainer,
			isDisposed: () => this.options.isDisposed(),
		});
	}

	private handleSessionStateChange(
		summary: RuntimeTaskSessionSummary,
		previousSummary: RuntimeTaskSessionSummary | null,
	): void {
		const previousState = previousSummary?.state;
		const sessionInstanceChanged =
			previousSummary !== null &&
			(summary.startedAt !== previousSummary.startedAt || summary.pid !== previousSummary.pid);

		if (
			(this.visibleContainer ?? this.stageContainer) &&
			summary.state !== previousState &&
			previousState !== "running" &&
			previousState !== "awaiting_review" &&
			(summary.state === "running" || summary.state === "awaiting_review")
		) {
			this.viewport.forceResize();
		}

		if ((this.visibleContainer ?? this.stageContainer) && sessionInstanceChanged && summary.pid !== null) {
			// A new pid/startedAt means the server-side PTY changed underneath an
			// existing pooled slot. Reconnect the sockets rather than queueing a
			// restore on the old control socket; dogfood showed reused slots can
			// remain stuck forever waiting for an initial restore that never
			// completes. Ignore processless stop/exit summaries here: reconnecting
			// on pid=null just flashes the old terminal before untrash starts the
			// real replacement process.
			maybeTraceSessionInstanceReconnect({
				slotId: this.slotId,
				taskId: this.connectedTaskId,
				prevPid: previousSummary?.pid ?? null,
				nextPid: summary.pid,
				prevStartedAt: previousSummary?.startedAt ?? null,
				nextStartedAt: summary.startedAt,
				prevState: previousState ?? null,
				nextState: summary.state,
			});
			this.session.reconnect("session_instance_changed");
		}
	}

	private handleSessionExit(code: number | null): void {
		const label = code == null ? "session exited" : `session exited with code ${code}`;
		this.viewport.writeText(`\r\n[quarterdeck] ${label}\r\n`);
	}

	ensureConnected(): void {
		this.session.ensureConnected();
	}

	connectToTask(taskId: string, projectId: string): void {
		this.session.connectToTask(taskId, projectId);
	}

	async disconnectFromTask(): Promise<void> {
		const previousTaskId = this.session.disconnectFromTask();
		if (!previousTaskId) {
			return;
		}
		clearTerminalGeometry(previousTaskId);

		await this.viewport.drainWrites();
		if (!this.connectedTaskId) {
			this.viewport.resetBuffer();
		}
	}

	onceConnectionReady(callback: () => void): void {
		this.session.onceConnectionReady(callback);
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		return this.session.subscribe(subscriber);
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.viewport.setAppearance(appearance);
	}

	setFontWeight(weight: number): void {
		this.viewport.setFontWeight(weight);
	}

	attachToStageContainer(container: HTMLDivElement): void {
		this.viewport.attachToStageContainer(container);
	}

	show(appearance: PersistentTerminalAppearance, options: { autoFocus?: boolean; isVisible?: boolean }): void {
		this.showTimestamp = performance.now();
		this.viewport.show(appearance, {
			autoFocus: options.autoFocus,
			isVisible: options.isVisible,
			restoreCompleted: this.session.restoreCompleted,
		});
		if (this.session.restoreCompleted) {
			this.session.notifyInteractiveShown(this.showTimestamp);
			this.showTimestamp = null;
		}
	}

	hide(): void {
		this.viewport.hide();
	}

	park(): void {
		this.viewport.park();
	}

	writeText(text: string): void {
		this.viewport.writeText(text);
	}

	focus(): void {
		this.viewport.focus();
	}

	input(text: string): boolean {
		if (!this.session.isIoOpen) {
			return false;
		}
		this.viewport.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (!this.session.isIoOpen) {
			return false;
		}
		this.viewport.paste(text);
		return true;
	}

	clear(): void {
		this.viewport.clear();
	}

	reset(): void {
		this.viewport.reset();
	}

	resetRenderer(): void {
		this.viewport.resetRenderer();
	}

	refreshVisibleRows(): void {
		this.viewport.refreshVisibleRows();
	}

	requestRestore(): void {
		// Keep agent-specific restore tuning narrow here. If more agents need
		// custom restore behavior, extract a dedicated restore-policy module
		// instead of growing TerminalAttachmentController into that owner.
		if (this.sessionAgentId === "codex") {
			this.viewport.forceResize();
		}
		this.session.requestRestore();
	}

	getBufferDebugInfo(): {
		activeBuffer: "ALTERNATE" | "NORMAL";
		normalLength: number;
		normalBaseY: number;
		normalScrollbackLines: number;
		alternateLength: number;
		viewportRows: number;
		scrollbackOption: number;
		sessionState: string | null;
	} {
		return this.viewport.getBufferDebugInfo(this.session.sessionState);
	}

	readBufferLines(): string[] {
		return this.viewport.readBufferLines();
	}

	async stop(): Promise<void> {
		await this.session.stop();
	}

	dispose(): void {
		this.hide();
		this.park();
		this.session.dispose();
		this.viewport.dispose();
	}
}
