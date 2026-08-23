import { describe, expect, it, vi } from "vitest";

import { BrowserHostIntegrations } from "@/runtime/browser-host-integrations";

describe("BrowserHostIntegrations", () => {
	it("does not invoke browser host APIs when native UI is disabled", async () => {
		const readClipboardText = vi.fn(async () => {
			throw new Error("forbidden clipboard read invoked");
		});
		const playNotificationAudio = vi.fn(() => {
			throw new Error("forbidden notification audio invoked");
		});
		const writeClipboardText = vi.fn(async () => {
			throw new Error("forbidden clipboard write invoked");
		});
		const onAttempt = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const integrations = new BrowserHostIntegrations(
			{ nativeUiAvailable: false },
			{ readClipboardText, writeClipboardText, onAttempt },
		);

		await expect(integrations.readClipboardText()).rejects.toThrow("disabled");
		await expect(integrations.writeClipboardText("secret")).rejects.toThrow("disabled");
		expect(integrations.runNotificationAudio(playNotificationAudio)).toBeNull();

		expect(readClipboardText).not.toHaveBeenCalled();
		expect(writeClipboardText).not.toHaveBeenCalled();
		expect(playNotificationAudio).not.toHaveBeenCalled();
		expect(onAttempt.mock.calls.map(([attempt]) => attempt)).toEqual([
			{ kind: "clipboard_read", blocked: true },
			{ kind: "clipboard_write", blocked: true },
			{ kind: "notification_audio", blocked: true },
		]);
		warn.mockRestore();
	});

	it("uses injected browser integrations when enabled", async () => {
		const readClipboardText = vi.fn(async () => "copied");
		const writeClipboardText = vi.fn(async () => {});
		const playNotificationAudio = vi.fn(() => "played");
		const integrations = new BrowserHostIntegrations(
			{ nativeUiAvailable: true },
			{ readClipboardText, writeClipboardText },
		);

		await expect(integrations.readClipboardText()).resolves.toBe("copied");
		await expect(integrations.writeClipboardText("text")).resolves.toBeUndefined();
		expect(integrations.runNotificationAudio(playNotificationAudio)).toBe("played");
		expect(writeClipboardText).toHaveBeenCalledWith("text");
		expect(playNotificationAudio).toHaveBeenCalledOnce();
	});
});
