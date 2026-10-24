import type { DesktopDiagnosticsPayload } from "../core/api/desktop-diagnostics.js";
import {
	type DesktopControlMessage,
	type DesktopControlResultMessage,
	type DesktopHostEffectAction,
	type DesktopHostEffectResult,
	type DesktopReadyMessage,
	type DesktopShutdownCompletion,
	type DesktopShutdownMessage,
	type DesktopStartupFailureMessage,
	type DesktopStartupMessage,
	desktopParentMessageSchema,
} from "../core/api/desktop-runtime-protocol.js";
import type { RuntimeShutdownOutcome } from "../core/api/runtime-shutdown.js";
import { DesktopHostEffectClient } from "./desktop-host-effect-client.js";

/** Owns private IPC only; the renderer cannot invoke this process channel. */
export class DesktopRuntimeChannel {
	readonly startup: Promise<DesktopStartupMessage>;
	private startupId: string | null = null;
	private shutdownHandler: (() => Promise<DesktopShutdownCompletion>) | null = null;
	private unconfirmedCustodyHold: NodeJS.Timeout | null = null;
	private readonly pendingShutdown = new Map<string, DesktopShutdownMessage>();
	private disconnected = false;
	private stopping = false;
	private diagnosticsHandler: ((payload: DesktopDiagnosticsPayload) => void) | null = null;
	private hostEffectGeneration: string | null = null;
	private readonly hostEffects = new DesktopHostEffectClient({
		getIdentity: () =>
			!this.disconnected && !this.stopping && this.startupId && this.hostEffectGeneration
				? { startupId: this.startupId, runtimeGeneration: this.hostEffectGeneration }
				: null,
		send: (message) => this.send(message),
	});
	private controlHandler:
		| ((method: DesktopControlMessage["method"]) => Promise<DesktopControlResultMessage["result"]>)
		| null = null;

	constructor() {
		if (!process.send || !process.connected) throw new Error("Desktop runtime requires a private parent channel.");
		// Provider hooks inherit the runtime environment, but are independent CLI commands.
		delete process.env.QUARTERDECK_DESKTOP_CHILD;
		this.startup = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Desktop startup handshake timed out.")), 10_000);
			process.on("message", (input: unknown) => {
				const parsed = desktopParentMessageSchema.safeParse(input);
				if (!parsed.success) return;
				const message = parsed.data;
				if (message.type === "quarterdeck:desktop-startup") {
					if (this.startupId) return;
					this.startupId = message.startupId;
					clearTimeout(timer);
					resolve(message);
				} else if (message.startupId === this.startupId && message.type === "quarterdeck:desktop-control") {
					void this.control(message);
				} else if (message.startupId === this.startupId && message.type === "quarterdeck:desktop-shutdown") {
					this.pendingShutdown.set(message.requestId, message);
					void this.stop();
				} else if (message.type === "quarterdeck:desktop-host-result") {
					this.hostEffects.accept(message);
				} else if (
					message.startupId === this.startupId &&
					message.type === "quarterdeck:desktop-diagnostics" &&
					!this.disconnected &&
					!this.stopping
				) {
					try {
						this.diagnosticsHandler?.(message.payload);
					} catch {
						// Recorder failure must not interrupt runtime lifecycle or host effects.
					}
				}
			});
			process.once("disconnect", () => {
				this.disconnected = true;
				// An awaited promise alone does not keep Node alive while custody
				// still includes unfenced automatic writers or unconfirmed drains.
				this.unconfirmedCustodyHold ??= setInterval(() => undefined, 60_000);
				this.hostEffects.dispose();
				clearTimeout(timer);
				if (!this.startupId) reject(new Error("Desktop parent disconnected before startup."));
				void this.stop();
			});
		});
	}

	setShutdownHandler(handler: () => Promise<DesktopShutdownCompletion>): void {
		this.shutdownHandler = handler;
		if (this.disconnected || this.pendingShutdown.size > 0) void this.stop();
	}

	setDiagnosticsHandler(handler: (payload: DesktopDiagnosticsPayload) => void): void {
		this.diagnosticsHandler = handler;
	}

	setControlHandler(
		handler: (method: DesktopControlMessage["method"]) => Promise<DesktopControlResultMessage["result"]>,
	): void {
		this.controlHandler = handler;
	}

	private async control(message: DesktopControlMessage): Promise<void> {
		if (this.disconnected) return;
		let result: DesktopControlResultMessage["result"] = { method: "failed", code: "unavailable" };
		try {
			if (!this.stopping && this.controlHandler) result = await this.controlHandler(message.method);
		} catch {
			/* Private failures are returned without paths, environment, or credentials. */
		}
		await this.send({
			type: "quarterdeck:desktop-control-result",
			protocolVersion: 1,
			startupId: message.startupId,
			requestId: message.requestId,
			result,
		}).catch(() => undefined);
	}

	async ready(message: Omit<DesktopReadyMessage, "type" | "protocolVersion" | "startupId">): Promise<void> {
		if (this.disconnected || !this.startupId) throw new Error("Desktop parent is unavailable.");
		await this.send({ type: "quarterdeck:desktop-ready", protocolVersion: 1, startupId: this.startupId, ...message });
		this.hostEffectGeneration = message.ownership === "owned" ? message.runtimeGeneration : null;
	}

	requestHostEffect(action: DesktopHostEffectAction, runtimeGeneration: string): Promise<DesktopHostEffectResult> {
		return this.hostEffects.request(action, runtimeGeneration);
	}

	async fail(code: DesktopStartupFailureMessage["code"], message: string): Promise<void> {
		if (!this.startupId || this.disconnected) return;
		await this.send({
			type: "quarterdeck:desktop-failed",
			protocolVersion: 1,
			startupId: this.startupId,
			code,
			message,
		}).catch(() => undefined);
	}

	private async send(message: unknown): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			if (!process.send || !process.connected) return reject(new Error("Desktop parent is unavailable."));
			process.send(message, (error) => (error ? reject(error) : resolve()));
		});
	}

	private async stop(): Promise<void> {
		if (this.stopping || !this.shutdownHandler) return;
		this.stopping = true;
		this.hostEffects.dispose();
		let outcome: RuntimeShutdownOutcome;
		let persistenceSettled = false;
		try {
			// Only the runtime owner can prove that automatic writers were fenced
			// and drained. Promise resolution alone is not that proof.
			const completion = await this.shutdownHandler();
			outcome = completion.outcome;
			persistenceSettled = completion.persistenceSettled === true;
			if (outcome.safeToExit && !persistenceSettled) {
				outcome = {
					status: "incomplete",
					safeToExit: false,
					safeToReleaseOwnership: false,
					reasons: ["quiescence_failed"],
				};
			}
		} catch {
			outcome = {
				status: "incomplete",
				safeToExit: false,
				safeToReleaseOwnership: false,
				reasons: ["quiescence_failed"],
			};
		}
		const requests = [...this.pendingShutdown.values()];
		this.pendingShutdown.clear();
		for (const request of requests) {
			if (this.disconnected) break;
			await this.send({
				type: "quarterdeck:desktop-shutdown-result",
				protocolVersion: 1,
				startupId: request.startupId,
				requestId: request.requestId,
				outcome,
				persistenceSettled,
			}).catch(() => undefined);
		}
		if (persistenceSettled && this.unconfirmedCustodyHold) {
			clearInterval(this.unconfirmedCustodyHold);
			this.unconfirmedCustodyHold = null;
		}
		if (outcome.safeToExit) process.exit(0);
		this.stopping = false;
		if (this.disconnected) {
			// Parent death is not permission to interrupt automatic persistence.
			// Without proof, retain custody even if the remaining handles are unref'd.
			if (persistenceSettled) process.exit(1);
		} else if (this.pendingShutdown.size > 0) {
			void this.stop();
		}
	}
}
