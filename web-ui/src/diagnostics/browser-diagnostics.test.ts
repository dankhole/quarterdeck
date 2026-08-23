import { afterEach, describe, expect, it, vi } from "vitest";

import {
	_testing,
	getBrowserDiagnosticsSnapshot,
	handleBrowserDiagnosticsStreamMessage,
	initializeBrowserDiagnostics,
	recordBrowserEvent,
	recordBrowserLog,
	refreshBrowserDiagnosticData,
	setBrowserDiagnosticsConnected,
	setBrowserDiagnosticsLiveSubscription,
} from "@/diagnostics/browser-diagnostics";

describe("browser diagnostics recorder", () => {
	afterEach(() => {
		_testing.reset();
		vi.restoreAllMocks();
		sessionStorage.clear();
	});

	it("retains essential events before the panel opens and acknowledges bounded batches", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ accepted: 2, rejected: 0, duplicate: 0, highestAcceptedSequence: 10_000 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		initializeBrowserDiagnostics();
		recordBrowserEvent("browser.before_panel", { status: "failed" }, {}, { level: "warn", essential: true });
		handleBrowserDiagnosticsStreamMessage({
			type: "diagnostics_state",
			runtimeInstanceId: "runtime-1",
			browserCapability: "capability-1",
			consoleLogLevel: "warn",
			recording: { active: false, startedAt: null, expiresAt: null, scope: null },
			recentRecords: [],
		});

		await _testing.flushBrowserDiagnostics();

		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(init?.headers).toMatchObject({
			"x-quarterdeck-diagnostic-capability": "capability-1",
		});
		const sent = JSON.parse(String(init?.body)) as { records: Array<{ name: string }> };
		expect(sent.records.some((record) => record.name === "browser.before_panel")).toBe(true);
		expect(getBrowserDiagnosticsSnapshot().pendingCount).toBe(0);
	});

	it("bounds records before queueing and keeps the in-memory queue independent from the smaller storage tail", async () => {
		initializeBrowserDiagnostics();
		for (let index = 0; index < 100; index += 1) {
			recordBrowserEvent(`browser.large-${index}`, { value: "x".repeat(20_000) }, {}, { essential: true });
		}
		_testing.persistTailNow();
		await Promise.resolve();

		const snapshot = getBrowserDiagnosticsSnapshot();
		expect(snapshot.pendingCount).toBe(100);
		expect(snapshot.timeline.every((record) => JSON.stringify(record).length < 9 * 1_024)).toBe(true);
		expect((sessionStorage.getItem("quarterdeck.diagnostics.browser-tail.v1") ?? "").length * 2).toBeLessThanOrEqual(
			256 * 1_024,
		);
	});

	it("rejects malformed runtime responses instead of poisoning browser diagnostic state", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ health: "invalid" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		handleBrowserDiagnosticsStreamMessage({
			type: "diagnostics_state",
			runtimeInstanceId: "runtime-1",
			browserCapability: "capability-1",
			consoleLogLevel: "warn",
			recording: { active: false, startedAt: null, expiresAt: null, scope: null },
			recentRecords: [],
		});

		await expect(refreshBrowserDiagnosticData()).rejects.toThrow();
		expect(getBrowserDiagnosticsSnapshot().remoteData).toBeNull();
	});

	it("does not retain arbitrary generic browser log text or data in production", async () => {
		initializeBrowserDiagnostics();
		recordBrowserLog("error", "toast", "sentinel private task text", {
			arbitrary: "sentinel private diff content",
		});
		await Promise.resolve();

		const snapshot = getBrowserDiagnosticsSnapshot();
		expect(JSON.stringify(snapshot.timeline)).not.toContain("sentinel private");
		expect(snapshot.timeline.at(-1)?.payload).toEqual({
			tag: "toast",
			messageLength: "sentinel private task text".length,
			dataSummary: { type: "object", fieldCount: 1 },
		});
	});

	it("hydrates the canonical timeline when live delivery is explicitly enabled", async () => {
		const record = {
			version: 1 as const,
			id: "runtime-1:1",
			sequence: 1,
			timestamp: 1,
			monotonicOffsetMs: 1,
			runtimeInstanceId: "runtime-1",
			source: "runtime" as const,
			kind: "event" as const,
			level: "warn" as const,
			name: "runtime.test",
			context: {},
			payload: {},
		};
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ subscribed: true, revision: 1, records: [record] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ subscribed: false, revision: 2, records: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		handleBrowserDiagnosticsStreamMessage({
			type: "diagnostics_state",
			runtimeInstanceId: "runtime-1",
			browserCapability: "capability-1",
			consoleLogLevel: "warn",
			recording: { active: false, startedAt: null, expiresAt: null, scope: null },
			recentRecords: [],
		});

		await expect(setBrowserDiagnosticsLiveSubscription(true)).resolves.toBe(true);
		expect(getBrowserDiagnosticsSnapshot().timeline.map((entry) => entry.name)).toEqual(["runtime.test"]);
		await expect(setBrowserDiagnosticsLiveSubscription(false)).resolves.toBe(false);
		expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
			{ subscribed: true, revision: 1 },
			{ subscribed: false, revision: 2 },
		]);
	});

	it("ignores a stale subscription response after a newer panel state wins", async () => {
		let resolveFirstResponse!: (response: Response) => void;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirstResponse = resolve;
		});
		vi.spyOn(globalThis, "fetch")
			.mockImplementationOnce(async () => await firstResponse)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ subscribed: false, revision: 2, records: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		handleBrowserDiagnosticsStreamMessage({
			type: "diagnostics_state",
			runtimeInstanceId: "runtime-1",
			browserCapability: "capability-1",
			consoleLogLevel: "warn",
			recording: { active: false, startedAt: null, expiresAt: null, scope: null },
			recentRecords: [],
		});

		const staleSubscribe = setBrowserDiagnosticsLiveSubscription(true);
		await expect(setBrowserDiagnosticsLiveSubscription(false)).resolves.toBe(false);
		resolveFirstResponse(
			new Response(
				JSON.stringify({
					subscribed: true,
					revision: 1,
					records: [
						{
							version: 1,
							id: "runtime-1:1",
							sequence: 1,
							timestamp: 1,
							monotonicOffsetMs: 1,
							runtimeInstanceId: "runtime-1",
							source: "runtime",
							kind: "event",
							level: "warn",
							name: "runtime.stale",
							context: {},
							payload: {},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		await expect(staleSubscribe).resolves.toBe(false);
		expect(getBrowserDiagnosticsSnapshot().timeline).toEqual([]);
	});

	it("distinguishes an open runtime socket from a ready diagnostic capability", () => {
		setBrowserDiagnosticsConnected(true);
		expect(getBrowserDiagnosticsSnapshot()).toMatchObject({
			connected: true,
			diagnosticCapabilityReady: false,
		});

		handleBrowserDiagnosticsStreamMessage({
			type: "diagnostics_state",
			runtimeInstanceId: "runtime-1",
			browserCapability: "capability-1",
			consoleLogLevel: "warn",
			recording: { active: false, startedAt: null, expiresAt: null, scope: null },
			recentRecords: [],
		});
		expect(getBrowserDiagnosticsSnapshot().diagnosticCapabilityReady).toBe(true);

		setBrowserDiagnosticsConnected(false);
		expect(getBrowserDiagnosticsSnapshot().diagnosticCapabilityReady).toBe(false);
	});
});
