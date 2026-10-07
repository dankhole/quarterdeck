import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLabLaunchConfig } from "../src/lab-launch-config.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; configPath: string; input: Record<string, unknown> } {
	const root = realpathSync(mkdtempSync("/tmp/quarterdeck-desktop-config-"));
	roots.push(root);
	for (const name of ["state", "electron", "project"]) mkdirSync(join(root, name));
	writeFileSync(join(root, "host.json"), "{}", { mode: 0o600 });
	const input = {
		version: 1,
		tempRoot: root,
		stateHome: join(root, "state"),
		userDataPath: join(root, "electron"),
		projectPath: join(root, "project"),
		hostSimulationConfigPath: join(root, "host.json"),
		processEvidencePath: join(root, "processes.json"),
	};
	const configPath = join(root, "desktop.json");
	writeFileSync(configPath, JSON.stringify(input), { mode: 0o600 });
	return { root, configPath, input };
}

describe("isolated desktop launch configuration", () => {
	it("accepts private temporary fixture paths and evidence in the temporary root", () => {
		const { configPath, input } = fixture();
		expect(readLabLaunchConfig(configPath)).toEqual({ ...input, showWindow: false });
	});

	it("does not confuse a harness-overridden TMPDIR with its isolation boundary", () => {
		const { configPath, input, root } = fixture();
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = root;
		try {
			expect(readLabLaunchConfig(configPath)).toEqual({ ...input, showWindow: false });
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
		}
	});

	it("rejects state outside the fixture, shared Electron/runtime storage, and unknown launch options", () => {
		const { configPath, input } = fixture();
		for (const change of [
			{ stateHome: realpathSync("/tmp") },
			{ userDataPath: input.stateHome },
			{ arbitraryCommand: "shell" },
		]) {
			writeFileSync(configPath, JSON.stringify({ ...input, ...change }), { mode: 0o600 });
			expect(() => readLabLaunchConfig(configPath)).toThrow();
		}
	});

	it("rejects evidence symlinks instead of writing through them", () => {
		const { root, configPath } = fixture();
		symlinkSync(join(root, "host.json"), join(root, "processes.json"));
		expect(() => readLabLaunchConfig(configPath)).toThrow("symbolic link");
	});

	it("requires explicit lab configuration and private permissions", () => {
		expect(() => readLabLaunchConfig(undefined)).toThrow("isolated Agent Lab");
		const { root, input } = fixture();
		const configPath = join(root, "public.json");
		writeFileSync(configPath, JSON.stringify(input), { mode: 0o644 });
		expect(() => readLabLaunchConfig(configPath)).toThrow("private file");
	});
	it("shows a test window only when the validated configuration explicitly requests it", () => {
		const { configPath, input } = fixture();
		writeFileSync(configPath, JSON.stringify({ ...input, showWindow: true }), { mode: 0o600 });
		expect(readLabLaunchConfig(configPath).showWindow).toBe(true);
		writeFileSync(configPath, JSON.stringify({ ...input, showWindow: "true" }), { mode: 0o600 });
		expect(() => readLabLaunchConfig(configPath)).toThrow();
	});
});
