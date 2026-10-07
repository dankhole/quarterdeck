import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopDiagnosticState, DesktopDiagnosticsPayload } from "../../src/core/api/desktop-diagnostics.js";
import { collectDiagnosticCapture } from "../../src/diagnostics/client.js";
import { discoverRuntimeDiagnosticInstances } from "../../src/diagnostics/runtime-instance.js";
import { createDesktopDiagnostics, type DesktopDiagnostics } from "../src/desktop-diagnostics.js";

function initialState(): DesktopDiagnosticState {
	return {
		surface: "starting",
		quitting: false,
		window: { present: false, visible: false, focused: false },
		runtime: { phase: "not_started", helperPid: null, generation: null, ownership: null },
		update: { phase: "disabled", pending: false, reason: "synthetic" },
	};
}

describe("desktop canonical diagnostics", () => {
	let stateHome: string;
	let state: DesktopDiagnosticState;
	let diagnostics: DesktopDiagnostics;
	beforeEach(async () => {
		stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-diagnostics-"));
		state = initialState();
		diagnostics = await createDesktopDiagnostics({ stateHome, quarterdeckVersion: "test", getState: () => state });
	});
	afterEach(async () => {
		await diagnostics.close();
		vi.unstubAllGlobals();
		await rm(stateHome, { recursive: true, force: true });
	});

	it("retains startup failure before any helper exists and exports it without an endpoint", async () => {
		state.surface = "startup_failed";
		expect(diagnostics.record({ kind: "startup", phase: "failed", failureCode: "bundle_invalid" })).toBe(true);
		await diagnostics.markFailed();
		await diagnostics.flush();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const instance = (await discoverRuntimeDiagnosticInstances(stateHome))[0];
		expect(instance).toBeDefined();
		if (!instance) throw new Error("Missing desktop descriptor.");
		expect(instance.descriptor).toMatchObject({ processKind: "desktop", host: null, port: null, status: "failed" });
		const capture = await collectDiagnosticCapture(instance);
		expect(fetch).not.toHaveBeenCalled();
		expect(capture.records).toContainEqual(
			expect.objectContaining({
				name: "desktop.startup",
				level: "warn",
				payload: { event: { kind: "startup", phase: "failed", failureCode: "bundle_invalid" }, state },
			}),
		);
		expect(capture.snapshot.providers).toContainEqual(
			expect.objectContaining({
				name: "desktop",
				status: "completed",
				data: expect.objectContaining({
					state,
					snapshotOrigin: "journal",
					desktopInstanceId: diagnostics.instanceId,
				}),
			}),
		);
		expect(capture.records.some((record) => record.name.startsWith("runtime.shutdown"))).toBe(false);
	});

	it("rejects content fields before recorder admission and preserves fixed metadata", async () => {
		const unsafe = {
			kind: "startup" as const,
			phase: "failed" as const,
			failureCode: "bundle_invalid" as const,
			environment: "synthetic-private-value",
		};
		expect(diagnostics.record(unsafe)).toBe(false);
		const unsafeState = { ...state, argv: "synthetic-private-value" };
		state = unsafeState;
		expect(diagnostics.record({ kind: "lifecycle", action: "activate" })).toBe(false);
		state = initialState();
		expect(
			diagnostics.record({ kind: "startup", phase: "environment_resolved", environmentSource: "fallback" }),
		).toBe(true);
		await diagnostics.flush();
		const instance = (await discoverRuntimeDiagnosticInstances(stateHome))[0];
		if (!instance) throw new Error("Missing desktop descriptor.");
		const capture = await collectDiagnosticCapture(instance);
		expect(JSON.stringify(capture)).not.toContain("synthetic-private-value");
	});

	it("replays at most one hundred canonical records, then forwards live metadata", () => {
		for (let index = 0; index < 130; index += 1) diagnostics.record({ kind: "lifecycle", action: "activate" });
		const packets: DesktopDiagnosticsPayload[] = [];
		diagnostics.connect((packet) => {
			packets.push(packet);
			return true;
		});
		expect(packets).toHaveLength(1);
		expect(packets[0]?.records).toHaveLength(100);
		expect(packets[0]?.desktopInstanceId).toBe(diagnostics.instanceId);
		diagnostics.record({ kind: "shutdown", phase: "requested", intent: "quit" });
		expect(packets[1]?.records).toHaveLength(1);
		expect(packets[1]?.records[0]?.sequence).toBeGreaterThan(packets[0]?.records.at(-1)?.sequence ?? 0);
		diagnostics.disconnect();
		diagnostics.record({ kind: "lifecycle", action: "wake" });
		expect(packets).toHaveLength(2);
	});

	it("keeps the canonical journal after projection failure and finalizes only its evidence descriptor", async () => {
		const forward = vi.fn(() => false);
		diagnostics.connect(forward);
		diagnostics.record({ kind: "lifecycle", action: "window_created" });
		expect(forward).toHaveBeenCalledTimes(1);
		await diagnostics.markReady();
		await diagnostics.close();
		const instance = (await discoverRuntimeDiagnosticInstances(stateHome))[0];
		if (!instance) throw new Error("Missing desktop descriptor.");
		const capture = await collectDiagnosticCapture(instance);
		expect(instance.descriptor.status).toBe("stopped");
		expect(capture.records.map((record) => record.name)).toEqual(
			expect.arrayContaining(["desktop.forward_unavailable", "desktop.lifecycle", "desktop.recorder_closed"]),
		);
		expect(capture.records.some((record) => record.name.startsWith("runtime.shutdown"))).toBe(false);
		const entries = await readdir(join(stateHome, "diagnostics", "instances"));
		expect(entries).toEqual([diagnostics.instanceId]);
		const descriptor = await readFile(instance.descriptorPath, "utf8");
		expect(descriptor).not.toContain("synthetic-private-value");
	});
});
