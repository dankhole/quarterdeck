import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainEvent } from "electron";
import {
	type DesktopAppCommand,
	type DesktopCommandAvailability,
	type DesktopNotificationContext,
	type DesktopNotificationTarget,
	type DesktopProjectOpenRequest,
	type DesktopQuitPreflightRequest,
	type DesktopQuitPreflightResponse,
	desktopAppCommandSchema,
	desktopCommandAvailabilitySchema,
	desktopNotificationContextSchema,
	desktopNotificationTargetSchema,
	desktopProjectOpenRequestSchema,
	desktopQuitPreflightResponseSchema,
} from "../../src/shared/desktop-bridge-contract.js";
import {
	DESKTOP_AVAILABILITY_CHANNEL,
	DESKTOP_COMMAND_CHANNEL,
	DESKTOP_NOTIFICATION_CONTEXT_CHANNEL,
	DESKTOP_NOTIFICATION_TARGET_CHANNEL,
	DESKTOP_PREFLIGHT_CHANNEL,
	DESKTOP_PREFLIGHT_RELEASE_CHANNEL,
	DESKTOP_PREFLIGHT_REPLY_CHANNEL,
	DESKTOP_PROJECT_OPEN_CHANNEL,
} from "./desktop-ipc-channels.js";
import { type ApprovedRenderer, isApprovedDocumentSender } from "./renderer-admission.js";
import type { RuntimeSelection } from "./runtime-selection.js";
import { isProductPage } from "./security-policy.js";

export {
	DESKTOP_COMMAND_CHANNEL,
	DESKTOP_PREFLIGHT_CHANNEL,
	DESKTOP_PREFLIGHT_REPLY_CHANNEL,
} from "./desktop-ipc-channels.js";

interface PendingPreflight {
	request: DesktopQuitPreflightRequest;
	documentId: string;
	finish: (response: DesktopQuitPreflightResponse | null) => void;
}

export class DesktopRendererCommands {
	private publication: { documentId: string; value: DesktopCommandAvailability } | null = null;
	private readonly onAvailability: (event: IpcMainEvent, payload: unknown) => void;
	private readonly onContext: (event: IpcMainEvent, payload: unknown) => void;
	private pending: PendingPreflight | null = null;
	private readonly seals = new Map<
		string,
		{
			documentId: string;
			request: DesktopQuitPreflightRequest;
			deadline: number;
			contents: ApprovedRenderer["contents"];
		}
	>();
	private readonly retiredNavigationHolds: {
		request: DesktopQuitPreflightRequest;
		contents: ApprovedRenderer["contents"];
	}[] = [];
	private readonly onReply: (event: IpcMainEvent, payload: unknown) => void;

	constructor(
		private readonly ipc: Pick<IpcMain, "on" | "removeListener">,
		private readonly getRenderer: () => ApprovedRenderer | null,
		private readonly selection: RuntimeSelection,
		private readonly deadlineMs = 5000,
		private readonly callbacks: {
			onAvailability?: () => void;
			onContext?: (context: DesktopNotificationContext) => void;
		} = {},
	) {
		this.onAvailability = (event, payload) => {
			const envelope = this.documentEnvelope(event, payload, "availability");
			const parsed = desktopCommandAvailabilitySchema.safeParse(envelope?.availability);
			if (!envelope || !parsed.success || parsed.data.runtimeGeneration !== envelope.runtimeGeneration) return;
			this.publication = { documentId: envelope.documentId as string, value: parsed.data };
			this.callbacks.onAvailability?.();
		};
		this.onContext = (event, payload) => {
			const envelope = this.documentEnvelope(event, payload, "context");
			const parsed = desktopNotificationContextSchema.safeParse(envelope?.context);
			if (envelope && parsed.success) this.callbacks.onContext?.(parsed.data);
		};
		this.onReply = (event, payload) => {
			const pending = this.pending;
			if (!pending || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
			const envelope = payload as Record<string, unknown>;
			if (
				Object.keys(envelope).length !== 2 ||
				envelope.documentId !== pending.documentId ||
				this.getRenderer()?.documentId !== pending.documentId
			)
				return;
			const parsed = desktopQuitPreflightResponseSchema.safeParse(envelope.response);
			if (!parsed.success || !isApprovedDocumentSender(event, this.getRenderer(), pending.request.runtimeGeneration))
				return;
			if (
				parsed.data.requestId !== pending.request.requestId ||
				parsed.data.runtimeGeneration !== pending.request.runtimeGeneration
			)
				return;
			pending.finish(parsed.data);
		};
		this.ipc.on(DESKTOP_PREFLIGHT_REPLY_CHANNEL, this.onReply);
		this.ipc.on(DESKTOP_AVAILABILITY_CHANNEL, this.onAvailability);
		this.ipc.on(DESKTOP_NOTIFICATION_CONTEXT_CHANNEL, this.onContext);
	}

	private documentEnvelope(event: IpcMainEvent, payload: unknown, field: string): Record<string, unknown> | null {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
		const envelope = payload as Record<string, unknown>;
		const renderer = this.getRenderer();
		if (
			Object.keys(envelope).length !== 3 ||
			!Object.hasOwn(envelope, field) ||
			typeof envelope.runtimeGeneration !== "string" ||
			!renderer?.documentId ||
			envelope.documentId !== renderer.documentId ||
			!isApprovedDocumentSender(event, renderer, envelope.runtimeGeneration)
		)
			return null;
		return envelope;
	}

	availability(): DesktopCommandAvailability | null {
		const renderer = this.getRenderer();
		const publication = this.publication;
		return publication &&
			renderer?.documentId === publication.documentId &&
			renderer?.generation === publication.value.runtimeGeneration
			? publication.value
			: null;
	}

	clearDocument(): void {
		this.pending?.finish(null);
		// Navigation revokes authority; it must not reopen the old document's input while replacement is pending.
		for (const seal of this.seals.values())
			if (seal.request.freezeMode === "navigation") this.retiredNavigationHolds.push(seal);
		this.seals.clear();
		this.publication = null;
		this.callbacks.onAvailability?.();
	}

	forgetRetiredNavigation(): void {
		this.retiredNavigationHolds.length = 0;
	}

	notificationTarget(target: DesktopNotificationTarget): boolean {
		const renderer = this.getRenderer();
		const parsed = desktopNotificationTargetSchema.safeParse(target);
		if (
			!parsed.success ||
			!renderer?.documentId ||
			renderer.generation !== target.runtimeGeneration ||
			renderer.contents.isDestroyed() ||
			!isProductPage(renderer.contents.getURL())
		)
			return false;
		renderer.contents.send(DESKTOP_NOTIFICATION_TARGET_CHANNEL, parsed.data);
		return true;
	}

	openProject(request: DesktopProjectOpenRequest): boolean {
		const renderer = this.getRenderer();
		const parsed = desktopProjectOpenRequestSchema.safeParse(request);
		const selected = this.selection.get();
		if (
			!parsed.success ||
			!renderer?.documentId ||
			renderer.generation !== request.runtimeGeneration ||
			selected?.generation !== request.runtimeGeneration ||
			this.availability()?.runtimeConnected !== true ||
			this.availability()?.projectLaunchReady !== true ||
			!this.availability()?.commands.includes("open-project") ||
			renderer.contents.isDestroyed() ||
			!isProductPage(renderer.contents.getURL())
		)
			return false;
		renderer.contents.send(DESKTOP_PROJECT_OPEN_CHANNEL, parsed.data);
		return true;
	}

	dispatch(command: DesktopAppCommand["command"]): boolean {
		const renderer = this.getRenderer();
		const selected = this.selection.get();
		const availability = this.availability();
		if (
			!renderer ||
			!availability?.commands.includes(command) ||
			renderer.contents.isDestroyed() ||
			!isProductPage(renderer.contents.getURL()) ||
			(selected && renderer.generation !== selected.generation)
		)
			return false;
		if (command !== "settings" && command !== "diagnostics" && (!selected || !availability.runtimeConnected))
			return false;
		const payload = desktopAppCommandSchema.parse({ command, runtimeGeneration: renderer.generation });
		renderer.contents.send(DESKTOP_COMMAND_CHANNEL, payload);
		return true;
	}

	requestPreflight(
		reason: DesktopQuitPreflightRequest["reason"],
		seal = false,
		freezeMode?: "navigation",
	): Promise<DesktopQuitPreflightResponse | null> {
		this.pending?.finish(null);
		const renderer = this.getRenderer();
		const selected = this.selection.get();
		if (
			!renderer?.generation ||
			!renderer.documentId ||
			renderer.contents.isDestroyed() ||
			!isProductPage(renderer.contents.getURL())
		)
			return Promise.resolve(null);
		const documentId = renderer.documentId;
		const request: DesktopQuitPreflightRequest = {
			requestId: randomUUID(),
			runtimeGeneration: renderer.generation,
			reason,
		};
		if (seal) {
			request.freezeUntil = Date.now() + 30_000;
			if (freezeMode && reason === "reload") request.freezeMode = freezeMode;
			this.seals.set(request.requestId, {
				documentId,
				request,
				deadline: performance.now() + 30_000,
				contents: renderer.contents,
			});
		}
		return new Promise((resolve) => {
			const onAborted = (): void => finish(null);
			const finish = (response: DesktopQuitPreflightResponse | null): void => {
				if (this.pending?.request !== request) return;
				clearTimeout(timer);
				selected?.signal.removeEventListener("abort", onAborted);
				this.pending = null;
				resolve(response);
			};
			const timer = setTimeout(() => finish(null), this.deadlineMs);
			this.pending = { request, documentId, finish };
			selected?.signal.addEventListener("abort", onAborted, { once: true });
			try {
				renderer.contents.send(DESKTOP_PREFLIGHT_CHANNEL, request);
			} catch {
				finish(null);
			}
		});
	}

	isSealValid(response: DesktopQuitPreflightResponse): boolean {
		const seal = this.seals.get(response.requestId);
		return Boolean(
			seal &&
				seal.request.runtimeGeneration === response.runtimeGeneration &&
				seal.documentId === this.getRenderer()?.documentId &&
				Date.now() < (seal.request.freezeUntil ?? 0) &&
				performance.now() < seal.deadline,
		);
	}

	releasePreflight(): void {
		const renderer = this.getRenderer();
		for (const hold of this.retiredNavigationHolds) {
			if (hold.contents.isDestroyed()) continue;
			try {
				hold.contents.send(DESKTOP_PREFLIGHT_RELEASE_CHANNEL, {
					requestId: hold.request.requestId,
					runtimeGeneration: hold.request.runtimeGeneration,
				});
			} catch {
				/* Retired documents may already be gone. */
			}
		}
		this.retiredNavigationHolds.length = 0;
		for (const seal of this.seals.values()) {
			if (renderer?.documentId !== seal.documentId || renderer.contents.isDestroyed()) continue;
			try {
				renderer.contents.send(DESKTOP_PREFLIGHT_RELEASE_CHANNEL, {
					requestId: seal.request.requestId,
					runtimeGeneration: seal.request.runtimeGeneration,
				});
			} catch {
				/* A closed document has no input lease to release. */
			}
		}
		this.seals.clear();
	}

	dispose(): void {
		this.pending?.finish(null);
		this.releasePreflight();
		this.ipc.removeListener(DESKTOP_PREFLIGHT_REPLY_CHANNEL, this.onReply);
		this.ipc.removeListener(DESKTOP_AVAILABILITY_CHANNEL, this.onAvailability);
		this.ipc.removeListener(DESKTOP_NOTIFICATION_CONTEXT_CHANNEL, this.onContext);
	}
}
