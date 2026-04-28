import { SlotVisibilityLifecycle } from "@/terminal/slot-visibility-lifecycle";
import {
	type PersistentTerminalSubscriber,
	TerminalAttachmentController,
} from "@/terminal/terminal-attachment-controller";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import type { PersistentTerminalAppearance } from "@/terminal/terminal-viewport";
import type { TerminalWritePoolRole } from "@/terminal/terminal-write-diagnostics";

const INTERRUPT_IDLE_SETTLE_MS = 250;

export type { PersistentTerminalAppearance } from "@/terminal/terminal-viewport";
export { updateGlobalTerminalFontWeight } from "@/terminal/terminal-viewport";

export class TerminalSlot {
	readonly slotId: number;
	private readonly attachment: TerminalAttachmentController;
	private readonly visibilityLifecycle: SlotVisibilityLifecycle;
	private poolRoleForDiagnostics: TerminalWritePoolRole | null = null;
	private disposed = false;

	constructor(slotId: number, appearance: PersistentTerminalAppearance) {
		this.slotId = slotId;
		this.attachment = new TerminalAttachmentController(this.slotId, appearance, {
			getPoolRole: () => this.poolRoleForDiagnostics,
			isDisposed: () => this.disposed,
		});
		this.visibilityLifecycle = this.createVisibilityLifecycle();
	}

	private get visibleContainer(): HTMLDivElement | null {
		return this.attachment.visibleContainer;
	}

	private get stageContainer(): HTMLDivElement | null {
		return this.attachment.stageContainer;
	}

	private createVisibilityLifecycle(): SlotVisibilityLifecycle {
		return new SlotVisibilityLifecycle(this.slotId, {
			getTaskId: () => this.connectedTaskId,
			getProjectId: () => this.connectedProjectId,
			hasVisibleContainer: () => this.visibleContainer !== null,
			hasIoSocket: () => this.attachment.hasIoSocket,
			hasControlSocket: () => this.attachment.hasControlSocket,
			refreshTerminal: () => this.attachment.refreshVisibleRows(),
			reconnectSockets: () => {
				this.attachment.ensureConnected();
			},
			isDisposed: () => this.disposed,
		});
	}

	/** The task this slot is currently connected to, or null if idle. */
	get connectedTaskId(): string | null {
		return this.attachment.connectedTaskId;
	}

	/** The project this slot is currently connected to, or null if idle. */
	get connectedProjectId(): string | null {
		return this.attachment.connectedProjectId;
	}

	/**
	 * Re-open IO + control sockets if they have been closed (e.g. after sleep).
	 * No-op if sockets are already open.
	 */
	ensureConnected(): void {
		this.attachment.ensureConnected();
	}

	connectToTask(taskId: string, projectId: string): void {
		this.attachment.connectToTask(taskId, projectId);
	}

	async disconnectFromTask(): Promise<void> {
		await this.attachment.disconnectFromTask();
	}

	/**
	 * Register a one-shot callback that fires when notifyConnectionReady() runs.
	 * Cleared by disconnectFromTask().
	 */
	onceConnectionReady(callback: () => void): void {
		this.attachment.onceConnectionReady(callback);
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.attachment.setAppearance(appearance);
	}

	setFontWeight(weight: number): void {
		this.attachment.setFontWeight(weight);
	}

	/**
	 * Move this slot's host element into a stage container. Called by the pool
	 * when a terminal container becomes available. After this call, fitAddon.fit()
	 * returns real dimensions even when the slot is hidden.
	 */
	attachToStageContainer(container: HTMLDivElement): void {
		this.attachment.attachToStageContainer(container);
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		return this.attachment.subscribe(subscriber);
	}

	show(appearance: PersistentTerminalAppearance, options: { autoFocus?: boolean; isVisible?: boolean }): void {
		if (this.disposed) {
			return;
		}
		this.attachment.show(appearance, options);
	}

	hide(): void {
		this.attachment.hide();
	}

	/**
	 * Move the host element back to the off-screen parking root and clear the
	 * stage container reference. Call this when the DOM container that held the
	 * terminal is about to be removed (e.g. dedicated terminal panel unmount)
	 * so the xterm canvas stays in the live DOM and avoids WebGL context loss.
	 */
	park(): void {
		this.attachment.park();
	}

	get sessionState(): string | null {
		return this.attachment.sessionState;
	}

	writeText(text: string): void {
		this.attachment.writeText(text);
	}

	focus(): void {
		this.attachment.focus();
	}

	input(text: string): boolean {
		return this.attachment.input(text);
	}

	paste(text: string): boolean {
		return this.attachment.paste(text);
	}

	clear(): void {
		this.attachment.clear();
	}

	reset(): void {
		this.attachment.reset();
	}

	resetRenderer(): void {
		this.attachment.resetRenderer();
	}

	setPoolRoleForDiagnostics(role: TerminalWritePoolRole | null): void {
		this.poolRoleForDiagnostics = role;
	}

	/**
	 * Request a fresh restore snapshot from the server, replacing the entire
	 * local terminal buffer with the authoritative state from the headless
	 * mirror. Use this to repair terminals that have drifted into a weird
	 * visual state. The server pauses live output during the snapshot to
	 * prevent data loss.
	 */
	requestRestore(): void {
		this.attachment.requestRestore();
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
		return this.attachment.getBufferDebugInfo();
	}

	readBufferLines(): string[] {
		return this.attachment.readBufferLines();
	}

	waitForLikelyPrompt(timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let buffer = "";
			let sawInterruptAcknowledgement = false;
			let settled = false;
			let idleTimer: number | null = null;

			const cleanup = (result: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				unsubscribe();
				resolve(result);
			};

			const scheduleIdleCompletion = () => {
				if (!sawInterruptAcknowledgement) {
					return;
				}
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				idleTimer = window.setTimeout(() => {
					cleanup(true);
				}, INTERRUPT_IDLE_SETTLE_MS);
			};

			const unsubscribe = this.subscribe({
				onOutputText: (text: string) => {
					buffer = appendTerminalHeuristicText(buffer, text);
					if (hasLikelyShellPrompt(buffer)) {
						cleanup(true);
						return;
					}
					if (hasInterruptAcknowledgement(buffer)) {
						sawInterruptAcknowledgement = true;
					}
					scheduleIdleCompletion();
				},
			});

			const timeoutId = window.setTimeout(() => {
				cleanup(false);
			}, timeoutMs);
		});
	}

	async stop(): Promise<void> {
		await this.attachment.stop();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.visibilityLifecycle.dispose();
		this.attachment.dispose();
		this.disposed = true;
	}
}
