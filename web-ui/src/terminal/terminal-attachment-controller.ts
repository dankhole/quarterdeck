import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { type PersistentTerminalSubscriber, TerminalSessionHandle } from "@/terminal/terminal-session-handle";
import { type PersistentTerminalAppearance, TerminalViewport } from "@/terminal/terminal-viewport";

export type { PersistentTerminalSubscriber } from "@/terminal/terminal-session-handle";

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
			onSummaryStateChange: (summary, previousState) => {
				this.handleSessionStateChange(summary, previousState);
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
		previousState: RuntimeTaskSessionSummary["state"] | undefined,
	): void {
		if (
			(this.visibleContainer ?? this.stageContainer) &&
			summary.state !== previousState &&
			previousState !== "running" &&
			previousState !== "awaiting_review" &&
			(summary.state === "running" || summary.state === "awaiting_review")
		) {
			this.viewport.forceResize();
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
