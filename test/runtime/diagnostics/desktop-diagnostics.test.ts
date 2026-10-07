import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DesktopDiagnosticState,
	type DesktopDiagnosticsPayload,
	desktopDiagnosticsPayloadSchema,
} from "../../../src/core/api/desktop-diagnostics.js";
import { runtimeDiagnosticDescriptorSchema } from "../../../src/core/api/diagnostics.js";
import {
	collectDiagnosticCapture,
	probeRuntimeDiagnosticInstance,
	selectRuntimeDiagnosticInstance,
} from "../../../src/diagnostics/client.js";
import {
	createDesktopRuntimeDiagnosticsIngestor,
	getDesktopDiagnosticJournalState,
} from "../../../src/diagnostics/desktop-diagnostics.js";
import { createRuntimeDiagnostics, type RuntimeDiagnostics } from "../../../src/diagnostics/runtime-diagnostics.js";
import {
	discoverRuntimeDiagnosticInstances,
	RuntimeDiagnosticInstance,
} from "../../../src/diagnostics/runtime-instance.js";
import { DesktopRuntimeChannel } from "../../../src/server/desktop-runtime-channel.js";

function state(): DesktopDiagnosticState {
	return {
		surface: "product",
		quitting: false,
		window: { present: true, visible: true, focused: false },
		runtime: { phase: "ready", helperPid: 12345, generation: randomUUID(), ownership: "owned" },
		update: { phase: "idle", pending: false },
	};
}

describe("desktop diagnostics roles and private projection", () => {
	let stateHome: string;
	let diagnostics: RuntimeDiagnostics;
	beforeEach(async () => {
		stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-projection-"));
		diagnostics = await createRuntimeDiagnostics({
			stateHome,
			host: "127.0.0.1",
			port: 4242,
			quarterdeckVersion: "test",
		});
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await diagnostics.close();
		await rm(stateHome, { recursive: true, force: true });
	});

	function packet(): DesktopDiagnosticsPayload {
		return {
			desktopInstanceId: randomUUID(),
			records: [{ sequence: 1, observedAt: 1000, event: { kind: "startup", phase: "ready" }, state: state() }],
		};
	}

	it("defaults legacy descriptors to runtime and reserves missing endpoints for desktop evidence", () => {
		const { processKind: _processKind, ...legacy } = diagnostics.instance.getDescriptor();
		expect(runtimeDiagnosticDescriptorSchema.parse(legacy).processKind).toBe("runtime");
		expect(runtimeDiagnosticDescriptorSchema.safeParse({ ...legacy, host: null, port: null }).success).toBe(false);
		expect(runtimeDiagnosticDescriptorSchema.safeParse({ ...legacy, processKind: "desktop" }).success).toBe(false);
		expect(
			runtimeDiagnosticDescriptorSchema.parse({ ...legacy, processKind: "desktop", host: null, port: null })
				.processKind,
		).toBe("desktop");
	});

	it("validates bounded metadata, deduplicates replay, and snapshots only the current parent projection", async () => {
		const ingestor = createDesktopRuntimeDiagnosticsIngestor(diagnostics);
		const payload = packet();
		expect(ingestor.ingest({ ...payload, environment: "synthetic-secret" })).toBe(false);
		expect(ingestor.ingest({ ...payload, records: Array.from({ length: 101 }, () => payload.records[0]) })).toBe(
			false,
		);
		expect(
			ingestor.ingest({
				...payload,
				records: [{ ...payload.records[0], state: { ...payload.records[0]?.state, argv: "synthetic-secret" } }],
			}),
		).toBe(false);
		expect(ingestor.ingest(payload)).toBe(true);
		expect(ingestor.ingest(payload)).toBe(true);
		expect(ingestor.ingest({ ...payload, desktopInstanceId: randomUUID() })).toBe(false);
		expect(diagnostics.getRecords({ name: "desktop" })).toHaveLength(1);
		const observed = {
			state: payload.records[0]?.state,
			desktopInstanceId: payload.desktopInstanceId,
			observedAt: 1000,
		};
		expect(getDesktopDiagnosticJournalState(diagnostics.getRecords())).toEqual(observed);
		const capture = await diagnostics.collectCaptureData({ providers: ["desktop"] });
		expect(capture.snapshot.providers[0]?.data).toEqual(observed);
		expect(JSON.stringify(capture)).not.toContain("synthetic-secret");
		ingestor.dispose();
		expect(ingestor.ingest(payload)).toBe(false);
		expect((await diagnostics.collectCaptureData({ providers: ["desktop"] })).snapshot.providers[0]?.status).toBe(
			"unavailable",
		);
	});

	it("selects authenticated runtime evidence without probing desktop endpoints", async () => {
		await diagnostics.markReady("127.0.0.1", 4242);
		const desktop = await RuntimeDiagnosticInstance.create({
			stateHome,
			processKind: "desktop",
			host: null,
			port: null,
			quarterdeckVersion: "test",
		});
		await desktop.markReady(null, null);
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						descriptor: diagnostics.instance.getPublicDescriptor(),
						health: diagnostics.recorder.getHealth(),
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetch);
		const selected = await selectRuntimeDiagnosticInstance({ stateHome });
		expect(selected?.descriptor.runtimeInstanceId).toBe(diagnostics.runtimeInstanceId);
		expect(fetch).toHaveBeenCalledTimes(1);
		const desktopInstance = (await discoverRuntimeDiagnosticInstances(stateHome)).find(
			(entry) => entry.descriptor.processKind === "desktop",
		);
		if (!desktopInstance) throw new Error("Missing desktop descriptor.");
		expect(await probeRuntimeDiagnosticInstance(desktopInstance)).toEqual({
			reachable: false,
			instanceMatches: false,
		});
		expect((await collectDiagnosticCapture(desktopInstance)).descriptor.processKind).toBe("desktop");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(
			(await selectRuntimeDiagnosticInstance({ stateHome, instanceId: desktop.getDescriptor().runtimeInstanceId }))
				?.descriptor.processKind,
		).toBe("desktop");
	});

	it("reports intentionally journal-only desktop evidence without a false unreachable-runtime doctor finding", async () => {
		const desktop = await createRuntimeDiagnostics({
			stateHome,
			processKind: "desktop",
			host: null,
			port: null,
			quarterdeckVersion: "test",
		});
		try {
			const observed = state();
			desktop.recordEvent(
				"desktop.startup",
				{ event: { kind: "startup", phase: "ready" }, state: observed },
				{ operationId: desktop.runtimeInstanceId },
				{ essential: true },
			);
			await desktop.recorder.flush();
			const instance = (await discoverRuntimeDiagnosticInstances(stateHome)).find(
				(entry) => entry.descriptor.runtimeInstanceId === desktop.runtimeInstanceId,
			);
			if (!instance) throw new Error("Missing desktop descriptor.");
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			const capture = await collectDiagnosticCapture(instance);
			expect(capture.health).toBeNull();
			expect(capture.snapshot.providers).toContainEqual(
				expect.objectContaining({ name: "recorder", status: "unavailable" }),
			);
			expect(capture.snapshot.providers).toContainEqual(
				expect.objectContaining({
					name: "desktop",
					status: "completed",
					data: expect.objectContaining({ state: observed }),
				}),
			);
			expect(capture.findings.some((finding) => finding.code === "RUNTIME_DESCRIPTOR_UNREACHABLE")).toBe(false);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await desktop.close();
		}
	});

	it("routes only validated metadata from the matching live private parent channel", async () => {
		const processEvents: EventEmitter = process;
		const originalSend = Object.getOwnPropertyDescriptor(process, "send");
		const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
		const messageListeners = new Set(process.listeners("message"));
		const disconnectListeners = new Set(process.listeners("disconnect"));
		const ingestor = createDesktopRuntimeDiagnosticsIngestor(diagnostics);
		try {
			Object.defineProperty(process, "send", { configurable: true, value: () => true });
			Object.defineProperty(process, "connected", { configurable: true, value: true });
			const channel = new DesktopRuntimeChannel();
			const startupId = randomUUID();
			processEvents.emit("message", {
				type: "quarterdeck:desktop-startup",
				protocolVersion: 1,
				startupId,
				clientToken: "a".repeat(43),
				allowedOrigins: ["app://quarterdeck"],
			});
			await channel.startup;
			channel.setDiagnosticsHandler(ingestor.ingest);
			const message = { type: "quarterdeck:desktop-diagnostics", protocolVersion: 1, startupId, payload: packet() };
			expect(desktopDiagnosticsPayloadSchema.safeParse(message.payload).success).toBe(true);
			processEvents.emit("message", { ...message, startupId: randomUUID() });
			processEvents.emit("message", { ...message, payload: { ...message.payload, env: "synthetic-secret" } });
			expect(diagnostics.getRecords({ name: "desktop" })).toHaveLength(0);
			processEvents.emit("message", message);
			expect(diagnostics.getRecords({ name: "desktop" })).toHaveLength(1);
			process.emit("disconnect");
			processEvents.emit("message", {
				...message,
				payload: {
					...message.payload,
					records: message.payload.records.map((record) => ({ ...record, sequence: 2 })),
				},
			});
			expect(diagnostics.getRecords({ name: "desktop" })).toHaveLength(1);
		} finally {
			ingestor.dispose();
			for (const listener of process.listeners("message"))
				if (!messageListeners.has(listener)) process.off("message", listener);
			for (const listener of process.listeners("disconnect"))
				if (!disconnectListeners.has(listener)) process.off("disconnect", listener);
			if (originalSend) Object.defineProperty(process, "send", originalSend);
			else Reflect.deleteProperty(process, "send");
			if (originalConnected) Object.defineProperty(process, "connected", originalConnected);
			else Reflect.deleteProperty(process, "connected");
		}
	});
});
