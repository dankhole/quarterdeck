import type { RuntimeCapabilities } from "@/runtime/types";

export type BrowserHostIntegrationKind = "clipboard_read" | "clipboard_write" | "notification_audio";

export interface BrowserHostIntegrationAttempt {
	kind: BrowserHostIntegrationKind;
	blocked: boolean;
}

export interface BrowserHostIntegrationDependencies {
	readClipboardText: () => Promise<string>;
	writeClipboardText: (text: string) => Promise<void>;
	onAttempt?: (attempt: BrowserHostIntegrationAttempt) => void;
}

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

export class BrowserHostIntegrations {
	private capabilities: RuntimeCapabilities;

	constructor(
		capabilities: RuntimeCapabilities,
		private readonly dependencies: BrowserHostIntegrationDependencies = {
			readClipboardText: defaultReadClipboardText,
			writeClipboardText: defaultWriteClipboardText,
		},
	) {
		this.capabilities = { ...capabilities };
	}

	configureCapabilities(capabilities: RuntimeCapabilities): void {
		this.capabilities = { ...capabilities };
	}

	private beginAttempt(kind: BrowserHostIntegrationKind): boolean {
		const blocked = !this.capabilities.nativeUiAvailable;
		this.dependencies.onAttempt?.({ kind, blocked });
		if (blocked) {
			console.warn(`[host-integration] Blocked ${kind}: native UI is disabled by launch configuration.`);
		}
		return !blocked;
	}

	async readClipboardText(): Promise<string> {
		if (!this.beginAttempt("clipboard_read")) {
			throw new Error("Clipboard integration is disabled for this runtime.");
		}
		return await this.dependencies.readClipboardText();
	}

	async writeClipboardText(text: string, fallback?: () => boolean): Promise<void> {
		if (!this.beginAttempt("clipboard_write")) {
			throw new Error("Clipboard integration is disabled for this runtime.");
		}
		try {
			await this.dependencies.writeClipboardText(text);
		} catch (error) {
			if (!fallback?.()) {
				throw error;
			}
		}
	}

	runNotificationAudio<T>(action: () => T): T | null {
		if (!this.beginAttempt("notification_audio")) {
			return null;
		}
		return action();
	}
}

export const browserHostIntegrations = new BrowserHostIntegrations({
	nativeUiAvailable: false,
});
