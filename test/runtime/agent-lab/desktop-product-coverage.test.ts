import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertTaskActionLayout,
	fenceDesktopTerminalProcessing,
} from "../../../scripts/agent-lab/desktop-product-coverage";
import type { RuntimeHostIntegrationEvent } from "../../../src/core/api/host-integrations";

describe("packaged terminal-processing fences", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	const read = (
		sequence: number,
		characterCount = 12,
	): Extract<RuntimeHostIntegrationEvent, { kind: "clipboard_read" }> => ({
		sequence,
		timestamp: "2026-01-01T00:00:00.000Z",
		origin: "browser",
		kind: "clipboard_read",
		outcome: "simulated",
		characterCount,
	});
	it("captures its baseline before requesting a read and rejects a previously recorded matching read", async () => {
		const order: string[] = [];
		const readEvents = vi.fn(async () => {
			order.push("ledger");
			return [read(4)];
		});
		const requestClipboardRead = vi.fn(async () => {
			order.push("OSC 52 request");
		});
		let completed = false;
		const pending = fenceDesktopTerminalProcessing({
			readEvents,
			requestClipboardRead,
			characterCount: 12,
			label: "historical redraw",
		}).then((sequence) => {
			completed = true;
			return sequence;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(completed).toBe(false);
		expect(order.slice(0, 3)).toEqual(["ledger", "OSC 52 request", "ledger"]);
		readEvents.mockResolvedValue([read(4), read(5)]);
		await vi.advanceTimersByTimeAsync(100);
		await expect(pending).resolves.toBe(5);
		expect(requestClipboardRead).toHaveBeenCalledOnce();
	});
	it("accepts an inline action receipt without requesting a later terminal command", async () => {
		let events: RuntimeHostIntegrationEvent[] = [read(4)];
		const readEvents = vi.fn(async () => events);
		const emitHistoricalFrameWithReceipt = vi.fn(async () => {
			events = [read(4), read(5)];
		});
		await expect(
			fenceDesktopTerminalProcessing({
				readEvents,
				requestClipboardRead: emitHistoricalFrameWithReceipt,
				characterCount: 12,
				label: "historical redraw",
			}),
		).resolves.toBe(5);
		expect(emitHistoricalFrameWithReceipt).toHaveBeenCalledOnce();
		expect(readEvents).toHaveBeenCalledTimes(2);
	});
	it("requires a fresh simulated clipboard read with the expected clipboard length", async () => {
		const readEvents = vi
			.fn(async (): Promise<RuntimeHostIntegrationEvent[]> => [read(4)])
			.mockResolvedValueOnce([read(4)])
			.mockResolvedValue([read(4), read(5, 99), { ...read(6), kind: "clipboard_write" }]);
		const pending = fenceDesktopTerminalProcessing({
			readEvents,
			requestClipboardRead: vi.fn(async () => {}),
			characterCount: 12,
			label: "bare Escape",
		});
		let completed = false;
		void pending.then(() => {
			completed = true;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(completed).toBe(false);
		readEvents.mockResolvedValue([read(4), read(7)]);
		await vi.advanceTimersByTimeAsync(100);
		await expect(pending).resolves.toBe(7);
	});
	it("fails after the bounded receipt deadline instead of treating typed input as processing proof", async () => {
		const requestClipboardRead = vi.fn(async () => {});
		const failure = expect(
			fenceDesktopTerminalProcessing({
				readEvents: vi.fn(async () => [read(4)]),
				requestClipboardRead,
				characterCount: 12,
				label: "historical redraw",
			}),
		).rejects.toThrow("terminal-processing receipt after historical redraw");
		await vi.advanceTimersByTimeAsync(20_000);
		await failure;
		expect(requestClipboardRead).toHaveBeenCalledOnce();
	});
	it("fails without sending input when its ledger baseline cannot be read", async () => {
		const requestClipboardRead = vi.fn(async () => {});
		await expect(
			fenceDesktopTerminalProcessing({
				readEvents: vi.fn(async () => {
					throw new Error("synthetic ledger unavailable");
				}),
				requestClipboardRead,
				characterCount: 12,
				label: "historical redraw",
			}),
		).rejects.toThrow("synthetic ledger unavailable");
		expect(requestClipboardRead).not.toHaveBeenCalled();
	});
});

describe("packaged task-action layout assertions", () => {
	const first = { left: 0, right: 10, top: 0, bottom: 10 };
	it("accepts one horizontal row only before wrapping is required", () => {
		const boxes = [first, { left: 10, right: 20, top: 0, bottom: 10 }];
		expect(() => assertTaskActionLayout(boxes, false)).not.toThrow();
		expect(() => assertTaskActionLayout(boxes, true)).toThrow("wrapping");
	});
	it("accepts non-overlapping wrapped rows and rejects overlapping controls", () => {
		expect(() => assertTaskActionLayout([first, { left: 0, right: 10, top: 10, bottom: 20 }], true)).not.toThrow();
		expect(() => assertTaskActionLayout([first, { left: 5, right: 15, top: 0, bottom: 10 }], false)).toThrow(
			"overlap",
		);
	});
});
