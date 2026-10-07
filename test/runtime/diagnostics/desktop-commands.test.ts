import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDiagnosticsCommand } from "../../../src/commands/diagnostics.js";
import type { DesktopDiagnosticState } from "../../../src/core/api/desktop-diagnostics.js";
import { createRuntimeDiagnostics, type RuntimeDiagnostics } from "../../../src/diagnostics/runtime-diagnostics.js";

describe("desktop journal-only diagnostic commands", () => {
	let stateHome: string;
	let diagnostics: RuntimeDiagnostics;
	let output: string[];
	let fetch: ReturnType<typeof vi.fn>;
	let originalExitCode: NodeJS.Process["exitCode"];
	const state: DesktopDiagnosticState = {
		surface: "startup_failed",
		quitting: false,
		window: { present: true, visible: true, focused: false },
		runtime: { phase: "failed", helperPid: null, generation: null, ownership: null },
		update: { phase: "disabled", pending: false, reason: "synthetic" },
	};
	beforeEach(async () => {
		stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-commands-"));
		vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);
		diagnostics = await createRuntimeDiagnostics({
			stateHome,
			processKind: "desktop",
			host: null,
			port: null,
			quarterdeckVersion: "test",
		});
		diagnostics.recordEvent(
			"desktop.startup",
			{ event: { kind: "startup", phase: "failed", failureCode: "bundle_invalid" }, state },
			{ operationId: diagnostics.runtimeInstanceId },
			{ essential: true },
		);
		await diagnostics.markFailed(new Error("fixed failure"));
		await diagnostics.recorder.flush();
		output = [];
		vi.spyOn(console, "log").mockImplementation((value: unknown) => output.push(String(value)));
		vi.spyOn(console, "error").mockImplementation((value: unknown) => output.push(String(value)));
		fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
	});
	afterEach(async () => {
		process.exitCode = originalExitCode;
		await diagnostics.close();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(stateHome, { recursive: true, force: true });
	});

	async function run(args: string[]) {
		const program = new Command();
		registerDiagnosticsCommand(program);
		await program.parseAsync(["diagnostics", ...args], { from: "user" });
	}

	it("labels desktop evidence in list and reads last observed state from status", async () => {
		await run(["list"]);
		expect(output.join("\n")).toContain("desktop");
		expect(output.join("\n")).toContain("journal-only");
		expect(output.join("\n")).not.toContain("null:null");
		output = [];
		await run(["status", "--json"]);
		expect(JSON.parse(output[0] ?? "null")).toMatchObject({
			descriptor: { processKind: "desktop", status: "failed" },
			reachable: false,
			health: null,
			lastObservedDesktopState: { state },
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("watches retained desktop records while its process is alive without HTTP", async () => {
		await run(["watch", "--duration", "10ms", "--event", "desktop.startup", "--jsonl"]);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0] ?? "null")).toMatchObject({ name: "desktop.startup", payload: { state } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("exports pre-helper startup evidence through the canonical bundle command", async () => {
		const bundlePath = join(stateHome, "export");
		await run(["capture", "--output", bundlePath, "--json"]);
		expect(JSON.parse(output[0] ?? "null")).toMatchObject({
			path: bundlePath,
			runtimeInstanceId: diagnostics.runtimeInstanceId,
		});
		const descriptor = await readFile(join(bundlePath, "runtime", "descriptor.json"), "utf8");
		expect(descriptor).toContain('"processKind": "desktop"');
		expect(descriptor).not.toContain(diagnostics.instance.getDescriptor().diagnosticToken);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses marks through a journal-only descriptor without writing its journal", async () => {
		const before = diagnostics.getRecords().length;
		await run(["mark", "synthetic mark"]);
		expect(process.exitCode).toBe(3);
		expect(output.join("\n")).toContain("journal-only");
		expect(diagnostics.getRecords()).toHaveLength(before);
		expect(fetch).not.toHaveBeenCalled();
	});
});
