import type { RuntimeBrowserHostIntegrationEventRequest, RuntimeCapabilities } from "@/runtime/types";
export type BrowserHostIntegrationKind = "clipboard_read" | "clipboard_write" | "notification_audio";

export interface BrowserHostIntegrationAttempt {
	kind: BrowserHostIntegrationKind;
	blocked: boolean;
	mode: RuntimeCapabilities["hostIntegrationMode"];
}

export interface BrowserHostIntegrationDependencies {
	readClipboardText: () => Promise<string>;
	writeClipboardText: (text: string) => Promise<void>;
	reportSimulatedEvent: (event: RuntimeBrowserHostIntegrationEventRequest) => Promise<void>;
	onAttempt?: (attempt: BrowserHostIntegrationAttempt) => void;
}

export interface BrowserNotificationAudioDetails {
	eventType: "permission" | "review" | "failure";
	volume: number;
	projectId?: string | null;
	taskId?: string | null;
}

export type BrowserNotificationAudioResult<T> =
	| { outcome: "native"; value: T | null }
	| { outcome: "simulated"; value: null; acknowledgement: Promise<void> }
	| { outcome: "unavailable"; value: null };

function defaultReadClipboardText(): Promise<string> {
	if (!navigator.clipboard?.readText) {
		return Promise.reject(new Error("Clipboard API unavailable"));
	}
	return navigator.clipboard.readText();
}

function defaultWriteClipboardText(text: string): Promise<void> {
	if (!navigator.clipboard?.writeText) {
		return Promise.reject(new Error("Clipboard API unavailable"));
	}
	return navigator.clipboard.writeText(text);
}

async function defaultReportSimulatedEvent(event: RuntimeBrowserHostIntegrationEventRequest): Promise<void> {
	const response = await fetch("/api/agent-lab/host-events", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(event),
		keepalive: true,
	});
	if (!response.ok) {
		throw new Error(`Could not record simulated host event (HTTP ${response.status}).`);
	}
}

export class BrowserHostIntegrations {
	private capabilities: RuntimeCapabilities;
	private simulatedClipboardText = "";

	constructor(
		capabilities: RuntimeCapabilities,
		private readonly dependencies: BrowserHostIntegrationDependencies = {
			readClipboardText: defaultReadClipboardText,
			writeClipboardText: defaultWriteClipboardText,
			reportSimulatedEvent: defaultReportSimulatedEvent,
		},
	) {
		this.capabilities = { ...capabilities };
	}

	configureCapabilities(capabilities: RuntimeCapabilities): void {
		if (this.capabilities.hostIntegrationMode !== capabilities.hostIntegrationMode) {
			this.simulatedClipboardText = "";
		}
		this.capabilities = { ...capabilities };
	}

	private beginAttempt(kind: BrowserHostIntegrationKind): RuntimeCapabilities["hostIntegrationMode"] {
		const mode = this.capabilities.hostIntegrationMode;
		const blocked = mode === "unavailable";
		this.dependencies.onAttempt?.({ kind, blocked, mode });
		if (blocked) {
			console.warn(`[browser-integration] Blocked ${kind}: browser-local integrations are disabled.`);
		}
		return mode;
	}

	async readClipboardText(): Promise<string> {
		const mode = this.beginAttempt("clipboard_read");
		if (mode === "unavailable") {
			throw new Error("Clipboard integration is disabled for this runtime.");
		}
		if (mode === "simulated") {
			await this.dependencies.reportSimulatedEvent({
				kind: "clipboard_read",
				characterCount: this.simulatedClipboardText.length,
			});
			return this.simulatedClipboardText;
		}
		return await this.dependencies.readClipboardText();
	}

	async writeClipboardText(text: string, fallback?: () => boolean): Promise<void> {
		const mode = this.beginAttempt("clipboard_write");
		if (mode === "unavailable") {
			throw new Error("Clipboard integration is disabled for this runtime.");
		}
		if (mode === "simulated") {
			await this.dependencies.reportSimulatedEvent({
				kind: "clipboard_write",
				characterCount: text.length,
			});
			this.simulatedClipboardText = text;
			return;
		}
		try {
			await this.dependencies.writeClipboardText(text);
		} catch (error) {
			if (!fallback?.()) {
				throw error;
			}
		}
	}

	runNotificationAudio<T>(
		details: BrowserNotificationAudioDetails | null,
		action: () => T,
	): BrowserNotificationAudioResult<T> {
		const mode = this.beginAttempt("notification_audio");
		if (mode === "unavailable") {
			return { outcome: "unavailable", value: null };
		}
		if (mode === "simulated") {
			const acknowledgement = details
				? this.dependencies.reportSimulatedEvent({
						kind: "notification_audio",
						eventType: details.eventType,
						volume: Math.max(0, Math.min(1, details.volume)),
						projectId: details.projectId ?? null,
						taskId: details.taskId ?? null,
					})
				: Promise.resolve();
			return { outcome: "simulated", value: null, acknowledgement };
		}
		return { outcome: "native", value: action() };
	}
}

export const browserHostIntegrations = new BrowserHostIntegrations({
	nativeUiAvailable: false,
	hostIntegrationMode: "unavailable",
});
