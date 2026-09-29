import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserHostIntegrations } from "@/runtime/browser-host-integrations";
import type { RuntimeBrowserHostIntegrationEventRequest } from "@/runtime/types";

function createEventReporter() {
	return vi.fn<(event: RuntimeBrowserHostIntegrationEventRequest) => Promise<void>>(async () => {});
}

describe("BrowserHostIntegrations", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("initiates native promise-backed clipboard writes before the API data arrives", async () => {
		let resolve!: (value: string) => void;
		const promise = new Promise<string>((nextResolve) => {
			resolve = nextResolve;
		});
		const content: Record<string, Promise<Blob>>[] = [];
		vi.stubGlobal(
			"ClipboardItem",
			class {
				constructor(data: Record<string, Promise<Blob>>) {
					content.push(data);
				}
			},
		);
		const write = vi.fn(async () => {
			await content[0]?.["text/plain"];
		});
		vi.stubGlobal("navigator", { clipboard: { write } });
		const integrations = new BrowserHostIntegrations({ nativeUiAvailable: true, hostIntegrationMode: "native" });
		const copying = integrations.writeClipboardText(promise);
		expect(write).toHaveBeenCalledOnce();
		resolve("full transcript");
		await copying;
		expect((await content[0]?.["text/plain"])?.size).toBe(15);
	});

	it("does not replace the simulated clipboard when deferred content fails", async () => {
		const reportSimulatedEvent = createEventReporter();
		const integrations = new BrowserHostIntegrations(
			{ nativeUiAvailable: false, hostIntegrationMode: "simulated" },
			{ readClipboardText: vi.fn(), writeClipboardText: vi.fn(), reportSimulatedEvent },
		);
		await integrations.writeClipboardText("previous");
		await expect(integrations.writeClipboardText(Promise.reject(new Error("read failed")))).rejects.toThrow(
			"read failed",
		);
		await expect(integrations.readClipboardText()).resolves.toBe("previous");
		expect(reportSimulatedEvent.mock.calls.filter(([event]) => event.kind === "clipboard_write")).toHaveLength(1);
	});
	it("fails closed before invoking browser host APIs when integrations are unavailable", async () => {
		const readClipboardText = vi.fn(async () => {
			throw new Error("forbidden clipboard read invoked");
		});
		const playNotificationAudio = vi.fn(() => {
			throw new Error("forbidden notification audio invoked");
		});
		const writeClipboardText = vi.fn(async () => {
			throw new Error("forbidden clipboard write invoked");
		});
		const reportSimulatedEvent = createEventReporter();
		const onAttempt = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const integrations = new BrowserHostIntegrations(
			{ nativeUiAvailable: false, hostIntegrationMode: "unavailable" },
			{ readClipboardText, writeClipboardText, reportSimulatedEvent, onAttempt },
		);

		await expect(integrations.readClipboardText()).rejects.toThrow("disabled");
		await expect(integrations.writeClipboardText("secret")).rejects.toThrow("disabled");
		expect(integrations.runNotificationAudio(null, playNotificationAudio)).toEqual({
			outcome: "unavailable",
			value: null,
		});

		expect(readClipboardText).not.toHaveBeenCalled();
		expect(writeClipboardText).not.toHaveBeenCalled();
		expect(playNotificationAudio).not.toHaveBeenCalled();
		expect(reportSimulatedEvent).not.toHaveBeenCalled();
		expect(onAttempt.mock.calls.map(([attempt]) => attempt)).toEqual([
			{ kind: "clipboard_read", blocked: true, mode: "unavailable" },
			{ kind: "clipboard_write", blocked: true, mode: "unavailable" },
			{ kind: "notification_audio", blocked: true, mode: "unavailable" },
		]);
		warn.mockRestore();
	});

	it("uses injected browser integrations in native mode", async () => {
		const readClipboardText = vi.fn(async () => "copied");
		const writeClipboardText = vi.fn(async () => {});
		const reportSimulatedEvent = createEventReporter();
		const playNotificationAudio = vi.fn(() => "played");
		const integrations = new BrowserHostIntegrations(
			{ nativeUiAvailable: true, hostIntegrationMode: "native" },
			{ readClipboardText, writeClipboardText, reportSimulatedEvent },
		);

		await expect(integrations.readClipboardText()).resolves.toBe("copied");
		await expect(integrations.writeClipboardText("text")).resolves.toBeUndefined();
		expect(integrations.runNotificationAudio(null, playNotificationAudio)).toEqual({
			outcome: "native",
			value: "played",
		});
		expect(writeClipboardText).toHaveBeenCalledWith("text");
		expect(playNotificationAudio).toHaveBeenCalledOnce();
		expect(reportSimulatedEvent).not.toHaveBeenCalled();
	});

	it("uses an in-memory clipboard and records semantic events in simulated mode", async () => {
		const readClipboardText = vi.fn(async () => {
			throw new Error("real clipboard read invoked");
		});
		const writeClipboardText = vi.fn(async () => {
			throw new Error("real clipboard write invoked");
		});
		const reportSimulatedEvent = createEventReporter();
		const playNotificationAudio = vi.fn(() => {
			throw new Error("real audio invoked");
		});
		const integrations = new BrowserHostIntegrations(
			{ nativeUiAvailable: false, hostIntegrationMode: "simulated" },
			{ readClipboardText, writeClipboardText, reportSimulatedEvent },
		);

		await integrations.writeClipboardText("lab text");
		await expect(integrations.readClipboardText()).resolves.toBe("lab text");
		const audioResult = integrations.runNotificationAudio(
			{ eventType: "permission", volume: 0.75, projectId: "project-1", taskId: "task-1" },
			playNotificationAudio,
		);
		expect(audioResult).toMatchObject({ outcome: "simulated", value: null });
		if (audioResult.outcome !== "simulated") {
			throw new Error("Expected simulated notification audio.");
		}
		await audioResult.acknowledgement;

		expect(readClipboardText).not.toHaveBeenCalled();
		expect(writeClipboardText).not.toHaveBeenCalled();
		expect(playNotificationAudio).not.toHaveBeenCalled();
		expect(reportSimulatedEvent.mock.calls.map(([event]) => event)).toEqual([
			{ kind: "clipboard_write", characterCount: 8 },
			{ kind: "clipboard_read", characterCount: 8 },
			{
				kind: "notification_audio",
				eventType: "permission",
				volume: 0.75,
				projectId: "project-1",
				taskId: "task-1",
			},
		]);
	});

	it("does not commit a simulated clipboard write when event recording fails", async () => {
		const reportSimulatedEvent = createEventReporter();
		reportSimulatedEvent.mockRejectedValueOnce(new Error("ledger unavailable"));
		const integrations = new BrowserHostIntegrations(
			{ nativeUiAvailable: false, hostIntegrationMode: "simulated" },
			{
				readClipboardText: vi.fn(async () => "real clipboard"),
				writeClipboardText: vi.fn(async () => {}),
				reportSimulatedEvent,
			},
		);

		await expect(integrations.writeClipboardText("not committed")).rejects.toThrow("ledger unavailable");
		reportSimulatedEvent.mockResolvedValueOnce();
		await expect(integrations.readClipboardText()).resolves.toBe("");
		expect(reportSimulatedEvent).toHaveBeenLastCalledWith({ kind: "clipboard_read", characterCount: 0 });
	});

	it("exposes simulated notification recording failures through its acknowledgement", async () => {
		const reportSimulatedEvent = createEventReporter();
		reportSimulatedEvent.mockRejectedValueOnce(new Error("ledger unavailable"));
		const playNotificationAudio = vi.fn(() => {
			throw new Error("real audio invoked");
		});
		const integrations = new BrowserHostIntegrations(
			{ nativeUiAvailable: false, hostIntegrationMode: "simulated" },
			{
				readClipboardText: vi.fn(async () => ""),
				writeClipboardText: vi.fn(async () => {}),
				reportSimulatedEvent,
			},
		);

		const result = integrations.runNotificationAudio(
			{ eventType: "review", volume: 0.5, projectId: null, taskId: null },
			playNotificationAudio,
		);
		expect(result.outcome).toBe("simulated");
		if (result.outcome !== "simulated") {
			throw new Error("Expected simulated notification audio.");
		}
		await expect(result.acknowledgement).rejects.toThrow("ledger unavailable");
		expect(playNotificationAudio).not.toHaveBeenCalled();
	});
});
