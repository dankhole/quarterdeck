import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopDiagnosticState } from "../../src/core/api/desktop-diagnostics.js";
import { createDesktopRuntimeDiagnosticsIngestor } from "../../src/diagnostics/desktop-diagnostics.js";
import { createRuntimeDiagnostics, type RuntimeDiagnostics } from "../../src/diagnostics/runtime-diagnostics.js";
import { discoverRuntimeDiagnosticInstances } from "../../src/diagnostics/runtime-instance.js";
import { createDesktopDiagnostics, type DesktopDiagnostics } from "../src/desktop-diagnostics.js";
import {
	createDesktopDiagnosticExporter,
	type DesktopDiagnosticExportOptions,
	type DesktopDiagnosticExportRuntime,
} from "../src/diagnostic-export.js";

describe("native canonical diagnostic export", () => {
	let directory: string;
	let stateHome: string;
	let desktop: DesktopDiagnostics;
	let helper: RuntimeDiagnostics | null;
	let runtime: DesktopDiagnosticExportRuntime | null;
	const state: DesktopDiagnosticState = {
		surface: "startup_failed",
		quitting: false,
		window: { present: false, visible: false, focused: false },
		runtime: { phase: "not_started", helperPid: null, generation: null, ownership: null },
		update: { phase: "disabled", pending: false, reason: "synthetic" },
	};
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-native-diagnostics-"));
		stateHome = join(directory, "state");
		helper = null;
		runtime = null;
		desktop = await createDesktopDiagnostics({ stateHome, quarterdeckVersion: "test", getState: () => state });
		desktop.record({ kind: "startup", phase: "failed", failureCode: "bundle_invalid" });
	});
	afterEach(async () => {
		await desktop.close();
		await helper?.close();
		vi.unstubAllGlobals();
		await rm(directory, { recursive: true, force: true });
	});

	function exporter(overrides: Partial<DesktopDiagnosticExportOptions> = {}) {
		return createDesktopDiagnosticExporter({
			stateHome,
			desktopInstanceId: desktop.instanceId,
			flushDesktop: () => desktop.flush(),
			getRuntime: () => runtime,
			chooseParentDirectory: async () => directory,
			...overrides,
		});
	}

	it("cancels before flushing, discovery, network access, or bundle writes", async () => {
		const flush = vi.fn();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const before = await readdir(directory);
		expect(await exporter({ chooseParentDirectory: async () => null, flushDesktop: flush })()).toEqual({
			status: "cancelled",
		});
		expect(flush).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(await readdir(directory)).toEqual(before);
	});

	it("exports the exact desktop startup journal when no helper was ever ready", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const outcome = await exporter()();
		expect(outcome).toMatchObject({ status: "exported", source: "desktop", partial: true });
		if (outcome.status !== "exported") throw new Error("Missing export.");
		const descriptor = JSON.parse(await readFile(join(outcome.path, "runtime", "descriptor.json"), "utf8"));
		expect(descriptor).toMatchObject({
			processKind: "desktop",
			runtimeInstanceId: desktop.instanceId,
			host: null,
			port: null,
		});
		expect(descriptor).not.toHaveProperty("diagnosticToken");
		expect(await readFile(join(outcome.path, "records.jsonl"), "utf8")).toContain('"failureCode":"bundle_invalid"');
		const manifest = JSON.parse(await readFile(join(outcome.path, "manifest.json"), "utf8"));
		expect(manifest.contentFlags).toEqual({
			includePaths: false,
			includeTaskText: false,
			includeTerminal: false,
			includeGitDiff: false,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	async function readyHelper() {
		helper = await createRuntimeDiagnostics({ stateHome, host: "127.0.0.1", port: 4242, quarterdeckVersion: "test" });
		await helper.markReady("127.0.0.1", 4242);
		const ingestor = createDesktopRuntimeDiagnosticsIngestor(helper);
		desktop.connect(ingestor.ingest);
		runtime = {
			diagnosticInstanceId: helper.runtimeInstanceId,
			origin: "http://127.0.0.1:4242",
			generation: randomUUID(),
			ownership: "owned",
		};
		const capture = await helper.collectCaptureData();
		const fetch = vi.fn(
			async (input: URL | string) =>
				new Response(
					JSON.stringify(
						String(input).includes("/status")
							? { descriptor: helper?.instance.getPublicDescriptor(), health: helper?.recorder.getHealth() }
							: capture,
					),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetch);
		return { fetch, capture };
	}

	it("exports authenticated owned-helper evidence including forwarded desktop metadata", async () => {
		const { fetch } = await readyHelper();
		const outcome = await exporter()();
		expect(outcome).toMatchObject({ status: "exported", source: "runtime" });
		if (outcome.status !== "exported") throw new Error("Missing export.");
		expect(fetch).toHaveBeenCalledTimes(2);
		const records = await readFile(join(outcome.path, "records.jsonl"), "utf8");
		expect(records).toContain('"name":"desktop.startup"');
		expect(records).toContain(desktop.instanceId);
		expect(await readFile(join(outcome.path, "runtime", "descriptor.json"), "utf8")).toContain(
			helper?.runtimeInstanceId,
		);
	});

	it("exports main evidence for an attached runtime without requesting or impersonating its recorder", async () => {
		const { fetch } = await readyHelper();
		if (!runtime) throw new Error("Missing runtime.");
		runtime = { ...runtime, ownership: "attached" };
		expect(await exporter()()).toMatchObject({ status: "exported", source: "desktop" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not authenticate a different same-home runtime occupying the selected origin", async () => {
		const { fetch } = await readyHelper();
		if (!runtime) throw new Error("Missing runtime.");
		runtime = { ...runtime, diagnosticInstanceId: randomUUID() };
		expect(await exporter()()).toMatchObject({ status: "exported", source: "desktop" });
		expect(fetch).not.toHaveBeenCalled();
		runtime = { ...runtime, diagnosticInstanceId: null };
		expect(await exporter()()).toMatchObject({ status: "exported", source: "desktop" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("falls back when the runtime generation changes or the authenticated identity is wrong", async () => {
		const { fetch } = await readyHelper();
		fetch.mockImplementationOnce(async () => {
			if (!runtime) throw new Error("Missing runtime.");
			runtime = { ...runtime, generation: randomUUID() };
			return new Response(
				JSON.stringify({
					descriptor: helper?.instance.getPublicDescriptor(),
					health: helper?.recorder.getHealth(),
				}),
				{ status: 200 },
			);
		});
		expect(await exporter()()).toMatchObject({ status: "exported", source: "desktop" });
		expect(fetch).toHaveBeenCalledTimes(1);
		fetch.mockClear();
		fetch.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({
						descriptor: { ...helper?.instance.getPublicDescriptor(), runtimeInstanceId: randomUUID() },
						health: helper?.recorder.getHealth(),
					}),
					{ status: 200 },
				),
		);
		expect(await exporter()()).toMatchObject({ status: "exported", source: "desktop" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("rejects a capture from a different runtime even after a matching authentication probe", async () => {
		const { fetch, capture } = await readyHelper();
		fetch.mockImplementation(
			async (input: URL | string) =>
				new Response(
					JSON.stringify(
						String(input).includes("/status")
							? { descriptor: helper?.instance.getPublicDescriptor(), health: helper?.recorder.getHealth() }
							: { ...capture, descriptor: { ...capture.descriptor, runtimeInstanceId: randomUUID() } },
					),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		expect(await exporter()()).toMatchObject({ status: "exported", source: "desktop" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("does not follow substituted journal paths or expose raw native failures", async () => {
		await desktop.flush();
		const instance = (await discoverRuntimeDiagnosticInstances(stateHome)).find(
			(entry) => entry.descriptor.runtimeInstanceId === desktop.instanceId,
		);
		if (!instance) throw new Error("Missing desktop descriptor.");
		await writeFile(
			instance.descriptorPath,
			JSON.stringify({ ...instance.descriptor, journalDirectory: join(directory, "private-elsewhere") }),
		);
		expect(await exporter()()).toEqual({ status: "failed", reason: "unavailable" });
		expect(
			await exporter({
				chooseParentDirectory: async () => {
					throw new Error("synthetic private native failure");
				},
			})(),
		).toEqual({ status: "failed", reason: "export_failed" });
		expect((await readdir(directory)).filter((name) => name.startsWith("quarterdeck-diagnostics-"))).toEqual([]);
	});
});
