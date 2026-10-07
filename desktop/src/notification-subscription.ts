import { randomUUID } from "node:crypto";
import { type RawData, WebSocket } from "ws";
import {
	type RuntimeNotificationPreferences,
	runtimeNotificationPreferencesSchema,
	runtimeNotificationPresentationStateSchema,
	runtimeStateStreamNotificationPreferencesMessageSchema,
	runtimeStateStreamNotificationPresentationMessageSchema,
} from "../../src/core/api/notification-presentation.js";
import { RUNTIME_MANAGEMENT_GENERATION_HEADER } from "../../src/core/api/runtime-management.js";
import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "../../src/core/api/runtime-protocol.js";
import { runtimeStateStreamMessageSchema } from "../../src/core/api/streams.js";
import {
	type DesktopNotificationFocus,
	DesktopNotificationPolicy,
	type DesktopTaskNotification,
} from "./notification-policy.js";
import type { SelectedRuntime } from "./runtime-selection.js";
import { DESKTOP_ORIGIN, DESKTOP_TOKEN_HEADER } from "./security-policy.js";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const RENEW_INTERVAL_MS = 5_000;
type SocketFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
export interface DesktopNotificationSubscriptionOptions {
	runtime: SelectedRuntime;
	buildId: string;
	getFocus: () => DesktopNotificationFocus;
	onNotification: (event: DesktopTaskNotification & { projectName: string; silent: boolean }) => void;
	onBadge: (count: number) => void;
	createSocket?: SocketFactory;
}

/** An authenticated main-process subscriber stays active without a visible or healthy renderer. */
export class DesktopNotificationSubscription {
	private readonly policy = new DesktopNotificationPolicy();
	private readonly projectNames = new Map<string, string>();
	private socket: WebSocket | null = null;
	private stopped = false;
	private ready = false;
	private grantedEpoch: string | null = null;
	private preferences: RuntimeNotificationPreferences | null = null;
	private renewalTimer: ReturnType<typeof setInterval> | null = null;
	private deliveryTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private baselineTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;

	constructor(private readonly options: DesktopNotificationSubscriptionOptions) {
		if (options.runtime.signal.aborted) {
			this.stopped = true;
			return;
		}
		options.runtime.signal.addEventListener("abort", this.stop, { once: true });
		this.connect();
	}

	stop = (): void => {
		if (this.stopped) return;
		this.stopped = true;
		this.options.runtime.signal.removeEventListener("abort", this.stop);
		this.clearConnection();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.options.onBadge(0);
	};

	refreshFocus(): void {
		this.deliver();
	}
	resolveTarget(event: Pick<DesktopTaskNotification, "projectId" | "taskId">): {
		projectId: string | null;
		taskId: string | null;
	} {
		return this.policy.resolveTarget(event.projectId, event.taskId);
	}

	private clearConnection(): void {
		this.ready = false;
		this.grantedEpoch = null;
		this.policy.setOwned(false);
		if (this.renewalTimer) clearInterval(this.renewalTimer);
		if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
		if (this.baselineTimer) clearTimeout(this.baselineTimer);
		this.renewalTimer = null;
		this.deliveryTimer = null;
		this.baselineTimer = null;
		const socket = this.socket;
		this.socket = null;
		socket?.removeAllListeners();
		socket?.on("error", () => undefined);
		if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
	}

	private connect(): void {
		if (this.stopped || this.options.runtime.signal.aborted) return;
		const url = new URL("/api/runtime/ws", this.options.runtime.origin);
		url.protocol = "ws:";
		url.searchParams.set("notificationPresentation", "desktop");
		url.searchParams.set("notificationOnly", "true");
		url.searchParams.set("documentVisible", "false");
		url.searchParams.set("clientId", randomUUID());
		url.searchParams.set("browserBuildId", this.options.buildId);
		const createSocket = this.options.createSocket ?? ((target, options) => new WebSocket(target, options));
		let socket: WebSocket;
		try {
			socket = createSocket(url.toString(), {
				headers: {
					Origin: DESKTOP_ORIGIN,
					[DESKTOP_TOKEN_HEADER]: this.options.runtime.clientToken,
					[RUNTIME_MANAGEMENT_GENERATION_HEADER]: this.options.runtime.generation,
				},
				handshakeTimeout: 5_000,
				maxPayload: MAX_MESSAGE_BYTES,
				followRedirects: false,
			});
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		const current = () => this.socket === socket && !this.stopped && !this.options.runtime.signal.aborted;
		socket.on("message", (data: RawData) => {
			if (current()) this.receive(data);
		});
		socket.on("error", () => {
			if (current()) socket.close();
		});
		socket.on("close", () => {
			if (!current()) return;
			this.clearConnection();
			this.options.onBadge(0);
			this.scheduleReconnect();
		});
		this.baselineTimer = setTimeout(() => {
			if (current() && !this.ready) socket.close();
		}, 5_000);
		this.baselineTimer.unref();
		this.renewalTimer = setInterval(() => {
			if (current() && this.ready && this.grantedEpoch && socket.readyState === WebSocket.OPEN)
				socket.send(
					JSON.stringify({
						type: "notification_presentation_renew",
						runtimeGeneration: this.options.runtime.generation,
						epoch: this.grantedEpoch,
					}),
				);
		}, RENEW_INTERVAL_MS);
		this.renewalTimer.unref();
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.options.runtime.signal.aborted || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(
			() => {
				this.reconnectTimer = null;
				this.connect();
			},
			Math.min(5_000, 500 * 2 ** Math.min(this.reconnectAttempt++, 4)),
		);
		this.reconnectTimer.unref();
	}

	private receive(data: RawData): void {
		try {
			const bytes = Array.isArray(data)
				? Buffer.concat(data)
				: data instanceof ArrayBuffer
					? Buffer.from(data)
					: data;
			if (bytes.byteLength > MAX_MESSAGE_BYTES) return;
			const raw: unknown = JSON.parse(bytes.toString("utf8"));
			const presentation = runtimeStateStreamNotificationPresentationMessageSchema.safeParse(raw);
			if (presentation.success) {
				if (presentation.data.state.runtimeGeneration !== this.options.runtime.generation) {
					this.stop();
					return;
				}
				const state = presentation.data.state;
				if (state.owner !== "desktop" || state.epoch !== this.grantedEpoch) this.grantedEpoch = null;
				if (presentation.data.granted === true && state.owner === "desktop") this.grantedEpoch = state.epoch;
				if (presentation.data.granted === false) this.grantedEpoch = null;
				this.policy.setOwned(this.ready && this.grantedEpoch !== null);
				this.deliver();
				// Claims are admitted on upgrade. Reconnect once the public owner returns
				// to browsers; an active desktop owner is left undisturbed.
				if (this.ready && state.owner === "browser") this.socket?.close();
				return;
			}
			const preferences = runtimeStateStreamNotificationPreferencesMessageSchema.safeParse(raw);
			if (preferences.success) {
				this.preferences = preferences.data.preferences;
				this.deliver();
				return;
			}
			const parsed = runtimeStateStreamMessageSchema.safeParse(raw);
			if (!parsed.success) return;
			const message = parsed.data;
			if (message.type === "snapshot") {
				if (message.runtimeProtocolVersion !== QUARTERDECK_RUNTIME_PROTOCOL_VERSION) {
					this.stop();
					return;
				}
				this.policy.seed(
					message.projects.map((project) => project.id),
					message.notificationSummariesByProject ?? {},
					message.notificationRevisionsByProject ?? {},
				);
				this.projectNames.clear();
				for (const project of message.projects) this.projectNames.set(project.id, project.name);
				if ("notificationPreferences" in message) {
					const settings = runtimeNotificationPreferencesSchema.safeParse(message.notificationPreferences);
					if (settings.success) this.preferences = settings.data;
				}
				if ("notificationPresentation" in message) {
					const state = runtimeNotificationPresentationStateSchema.safeParse(message.notificationPresentation);
					if (!state.success || state.data.runtimeGeneration !== this.options.runtime.generation) {
						this.stop();
						return;
					}
					if (state.data.owner !== "desktop" || state.data.epoch !== this.grantedEpoch) this.grantedEpoch = null;
				}
				this.ready = true;
				if (this.baselineTimer) clearTimeout(this.baselineTimer);
				this.baselineTimer = null;
				this.reconnectAttempt = 0;
				this.policy.setOwned(this.grantedEpoch !== null);
			} else if (this.ready && message.type === "task_notification") {
				this.policy.applyDelta(
					message.projectId,
					message.notificationRevision,
					message.summaries,
					message.removedTaskIds ?? [],
					message.replace ?? false,
					Date.now(),
				);
			} else if (message.type === "projects_updated") {
				this.policy.pruneProjects(message.projects.map((project) => project.id));
				this.projectNames.clear();
				for (const project of message.projects) this.projectNames.set(project.id, project.name);
			}
			this.deliver();
		} catch {
			/* Malformed private stream data never produces an OS effect or leaks payload content. */
		}
	}

	private deliver(): void {
		if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
		this.deliveryTimer = null;
		for (const event of this.policy.flush(Date.now(), this.preferences, this.options.getFocus())) {
			try {
				this.options.onNotification({
					...event,
					projectName: this.projectNames.get(event.projectId) ?? "Quarterdeck",
					silent: this.preferences?.volume === 0,
				});
			} catch {
				/* Denied native notifications leave authoritative in-app indicators usable. */
			}
		}
		this.options.onBadge(this.policy.badgeCount());
		const due = this.policy.nextDeadline();
		if (due !== null && !this.stopped)
			this.deliveryTimer = setTimeout(() => this.deliver(), Math.max(0, due - Date.now()));
	}
}
