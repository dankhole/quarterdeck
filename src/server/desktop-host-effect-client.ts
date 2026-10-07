import { randomUUID } from "node:crypto";
import {
	type DesktopHostEffectAction,
	type DesktopHostEffectRequestMessage,
	type DesktopHostEffectResult,
	desktopHostEffectActionSchema,
	desktopHostEffectResultMessageSchema,
	QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION,
} from "../core/api/desktop-runtime-protocol.js";

interface PendingHostEffect {
	message: DesktopHostEffectRequestMessage;
	finish: (result: DesktopHostEffectResult) => void;
}

export interface DesktopHostEffectClientOptions {
	getIdentity: () => { startupId: string; runtimeGeneration: string } | null;
	send: (message: DesktopHostEffectRequestMessage) => Promise<void>;
	deadlineMs?: number;
	maxPending?: number;
}

/** Correlates only this helper's current owned generation with its private parent. */
export class DesktopHostEffectClient {
	private readonly pending = new Map<string, PendingHostEffect>();
	private sequence = 0;
	private closed = false;
	constructor(private readonly options: DesktopHostEffectClientOptions) {}

	request(action: DesktopHostEffectAction, runtimeGeneration: string): Promise<DesktopHostEffectResult> {
		const identity = this.options.getIdentity();
		if (this.closed || !identity || identity.runtimeGeneration !== runtimeGeneration)
			return Promise.resolve({ status: "failed", reason: "disconnected" });
		if (!desktopHostEffectActionSchema.safeParse(action).success)
			return Promise.resolve({ status: "failed", reason: "denied" });
		if (this.pending.size >= (this.options.maxPending ?? 8))
			return Promise.resolve({ status: "failed", reason: "busy" });
		const message: DesktopHostEffectRequestMessage = {
			type: "quarterdeck:desktop-host-request",
			protocolVersion: QUARTERDECK_DESKTOP_RUNTIME_PROTOCOL_VERSION,
			...identity,
			requestId: randomUUID(),
			sequence: ++this.sequence,
			action,
		};
		return new Promise((resolve) => {
			const finish = (result: DesktopHostEffectResult): void => {
				if (!this.pending.delete(message.requestId)) return;
				clearTimeout(timer);
				resolve(result);
			};
			const timer = setTimeout(
				() => finish({ status: "failed", reason: "timeout" }),
				this.options.deadlineMs ?? 120_000,
			);
			this.pending.set(message.requestId, { message, finish });
			try {
				void this.options.send(message).catch(() => finish({ status: "failed", reason: "disconnected" }));
			} catch {
				finish({ status: "failed", reason: "disconnected" });
			}
		});
	}

	accept(input: unknown): void {
		const parsed = desktopHostEffectResultMessageSchema.safeParse(input);
		if (!parsed.success) return;
		const response = parsed.data;
		const pending = this.pending.get(response.requestId);
		const identity = this.options.getIdentity();
		if (
			!pending ||
			!identity ||
			response.startupId !== identity.startupId ||
			response.runtimeGeneration !== identity.runtimeGeneration ||
			response.startupId !== pending.message.startupId ||
			response.runtimeGeneration !== pending.message.runtimeGeneration ||
			response.sequence !== pending.message.sequence
		)
			return;
		const picker = pending.message.action.method === "pick-directory";
		if (
			response.result.status !== "failed" &&
			(picker ? response.result.status === "opened" : response.result.status !== "opened")
		)
			return;
		pending.finish(response.result);
	}

	dispose(): void {
		this.closed = true;
		for (const pending of this.pending.values()) pending.finish({ status: "failed", reason: "disconnected" });
	}
}
