import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClaudeHooksSettings } from "../../src/claude-hooks";
import { buildCodexHooksConfig } from "../../src/codex-hooks";

import { buildQuarterdeckCommandParts, buildShellCommandLine, resolveQuarterdeckCommandParts } from "../../src/core";
import {
	buildQuarterdeckCommandLine,
	buildQuarterdeckHookCommandLine,
	buildQuarterdeckHookCommandParts,
	resolveBundledHookEntryPath,
} from "../../src/core/quarterdeck-command";
import * as desktopAdmission from "../../src/desktop-install/admission.js";
import { prepareAgentLaunch } from "../../src/terminal";
import { QUARTERDECK_PI_HOOK_COMMAND_ENV } from "../../src/terminal/pi-lifecycle-extension";

const originalExecPath = process.execPath;
const originalArgv = process.argv;
const originalExecArgv = process.execArgv;
const originalConnected = process.connected;
const originalSend = process.send;
let fixtureRoot: string | undefined;
let admissionFd: number | undefined;

afterEach(() => {
	Object.defineProperty(process, "execPath", { configurable: true, value: originalExecPath });
	process.argv = originalArgv;
	process.execArgv = originalExecArgv;
	Object.defineProperty(process, "connected", { configurable: true, value: originalConnected });
	process.send = originalSend;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (admissionFd !== undefined) closeSync(admissionFd);
	admissionFd = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function createBundledInvocation() {
	fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-launcher-")));
	const runtime = join(fixtureRoot, "Applications/Quarterdeck.app/Contents/Resources/runtime");
	const execPath = join(runtime, "bin/nodeHost");
	const wrapper = join(runtime, "bin/node");
	const cli = join(runtime, "dist/cli.js");
	mkdirSync(dirname(execPath), { recursive: true });
	writeFileSync(execPath, "synthetic Node host", { mode: 0o755 });
	writeFileSync(wrapper, "synthetic admission wrapper", { mode: 0o755 });
	const metadata = join(fixtureRoot, "installation");
	mkdirSync(metadata, { mode: 0o700 });
	const lock = join(metadata, "admission.lock");
	writeFileSync(lock, "", { mode: 0o600 });
	admissionFd = openSync(lock, "r");
	vi.stubEnv("QUARTERDECK_INSTALLATION_LOCK_FD", String(admissionFd));
	vi.stubEnv("QUARTERDECK_INSTALLATION_LOCK_PATH", lock);
	const hooksEntry = join(dirname(cli), "hooks.js");
	return { execPath, argv: [execPath, cli], execArgv: [], wrapper, cli, hooksEntry, lock };
}

function createSyntheticInvocation() {
	const context = createBundledInvocation();
	const root = fixtureRoot ?? "";
	const stateHome = join(root, "state");
	const userDataPath = join(root, "electron-user-data");
	const projectPath = join(root, "project");
	const control = join(root, "control");
	for (const path of [stateHome, userDataPath, projectPath, control]) mkdirSync(path);
	const hostSimulationConfigPath = join(root, "host-simulation.json");
	writeFileSync(hostSimulationConfigPath, "{}", { mode: 0o600 });
	const configPath = join(root, "desktop-lab-config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			version: 1,
			tempRoot: root,
			stateHome,
			userDataPath,
			projectPath,
			hostSimulationConfigPath,
			processEvidencePath: join(control, "processes.json"),
			showWindow: false,
		}),
		{ mode: 0o600 },
	);
	vi.stubEnv("QUARTERDECK_INSTALLATION_LOCK_FD", undefined);
	vi.stubEnv("QUARTERDECK_INSTALLATION_LOCK_PATH", undefined);
	vi.stubEnv("QUARTERDECK_AGENT_LAB", "1");
	// The runtime channel consumes this marker before preparing provider hooks.
	vi.stubEnv("QUARTERDECK_DESKTOP_CHILD", undefined);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	process.send = vi.fn(() => true);
	vi.stubEnv("QUARTERDECK_DESKTOP_LAB_CONFIG", configPath);
	vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);
	return {
		...context,
		configPath,
		stateHome,
		argv: [...context.argv, "--no-native-ui", "--simulate-host-integrations", hostSimulationConfigPath],
	};
}

describe("resolveQuarterdeckCommandParts", () => {
	it("resolves node plus script entrypoint", () => {
		const parts = resolveQuarterdeckCommandParts({
			execPath: "/usr/local/bin/node",
			argv: ["/usr/local/bin/node", "/tmp/.npx/123/node_modules/quarterdeck/dist/cli.js", "--port", "9123"],
		});
		expect(parts).toEqual(["/usr/local/bin/node", "/tmp/.npx/123/node_modules/quarterdeck/dist/cli.js"]);
	});

	it("resolves tsx launched cli entrypoint", () => {
		const parts = resolveQuarterdeckCommandParts({
			execPath: "/usr/local/bin/node",
			argv: ["/usr/local/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", "/repo/src/cli.ts", "--no-open"],
		});
		expect(parts).toEqual(["/usr/local/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", "/repo/src/cli.ts"]);
	});

	it("preserves node execArgv for source entrypoints", () => {
		const parts = resolveQuarterdeckCommandParts({
			execPath: "/usr/local/bin/node",
			execArgv: ["--import", "tsx"],
			argv: ["/usr/local/bin/node", "/repo/src/cli.ts", "--no-open"],
		});
		expect(parts).toEqual(["/usr/local/bin/node", "--import", "tsx", "/repo/src/cli.ts"]);
	});

	it("routes tsx-launched hook commands to the sibling hook-main.ts source entry", () => {
		fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-source-entry-")));
		const src = join(fixtureRoot, "src");
		mkdirSync(src, { recursive: true });
		const cli = join(src, "cli.ts");
		const hookMain = join(src, "hook-main.ts");
		writeFileSync(cli, "synthetic cli source");
		writeFileSync(hookMain, "synthetic hook entry source");
		const selfPath = join(src, "core/quarterdeck-command.ts");

		expect(
			buildQuarterdeckHookCommandParts(
				["hooks", "notify"],
				{
					execPath: "/usr/local/bin/node",
					argv: ["/usr/local/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", cli, "--no-open"],
				},
				selfPath,
			),
		).toEqual(["/usr/local/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", hookMain, "hooks", "notify"]);
		expect(
			buildQuarterdeckHookCommandParts(
				["hooks", "notify"],
				{
					execPath: "/usr/local/bin/node",
					execArgv: ["--import", "tsx"],
					argv: ["/usr/local/bin/node", cli, "--no-open"],
				},
				selfPath,
			),
		).toEqual(["/usr/local/bin/node", "--import", "tsx", hookMain, "hooks", "notify"]);
	});

	it("keeps the tsx-launched cli.ts when no sibling hook-main.ts exists", () => {
		expect(
			buildQuarterdeckHookCommandParts(
				["hooks", "notify"],
				{
					execPath: "/usr/local/bin/node",
					execArgv: ["--import", "tsx"],
					argv: ["/usr/local/bin/node", "/nonexistent/src/cli.ts"],
				},
				"/nonexistent/src/core/quarterdeck-command.ts",
			),
		).toEqual(["/usr/local/bin/node", "--import", "tsx", "/nonexistent/src/cli.ts", "hooks", "notify"]);
	});

	it("falls back to execPath when no entrypoint path is available", () => {
		const parts = resolveQuarterdeckCommandParts({
			execPath: "/usr/local/bin/quarterdeck",
			argv: ["/usr/local/bin/quarterdeck", "hooks", "ingest"],
		});
		expect(parts).toEqual(["/usr/local/bin/quarterdeck"]);
	});
});

describe("buildQuarterdeckCommandParts", () => {
	it("appends command arguments to resolved runtime invocation", () => {
		expect(
			buildQuarterdeckCommandParts(["hooks", "ingest"], {
				execPath: "/usr/local/bin/node",
				argv: ["/usr/local/bin/node", "/tmp/.npx/321/node_modules/quarterdeck/dist/cli.js"],
			}),
		).toEqual(["/usr/local/bin/node", "/tmp/.npx/321/node_modules/quarterdeck/dist/cli.js", "hooks", "ingest"]);
	});

	it("serializes the resolved invocation through the platform command-line owner", () => {
		const context = {
			execPath: "C:\\Quarterdeck %NAME% ! ^ & (runtime)\\node.exe",
			argv: ["C:\\Quarterdeck %NAME% ! ^ & (runtime)\\node.exe", "C:\\Quarterdeck source\\cli.js"],
		};
		const parts = buildQuarterdeckCommandParts(["hooks", "ingest", "--event", "activity"], context);
		const env = { SystemRoot: "C:\\Windows" };

		expect(buildQuarterdeckCommandLine(["hooks", "ingest", "--event", "activity"], context, "win32", env)).toBe(
			buildShellCommandLine(parts[0] ?? "", parts.slice(1), "win32", env),
		);
	});
});

describe.skipIf(process.platform === "win32")("bundled desktop hook commands", () => {
	it("keeps validated synthetic helper hooks on the wrapper after the child marker is consumed", () => {
		const context = createSyntheticInvocation();
		expect(buildQuarterdeckCommandParts(["hooks", "notify"], context)).toEqual([
			context.wrapper,
			context.cli,
			"hooks",
			"notify",
		]);
	});

	it("requires admission for the canonical app even with a valid synthetic configuration", () => {
		const context = createSyntheticInvocation();
		vi.spyOn(desktopAdmission, "desktopStableAppPath").mockReturnValue(
			join(fixtureRoot ?? "", "Applications/Quarterdeck.app"),
		);
		expect(() => resolveQuarterdeckCommandParts(context)).toThrow("could not verify native installation admission");
	});

	it.each(["QUARTERDECK_AGENT_LAB", "QUARTERDECK_DESKTOP_LAB_CONFIG"])(
		"rejects synthetic environment without %s",
		(key) => {
			const context = createSyntheticInvocation();
			vi.stubEnv(key, undefined);
			expect(() => resolveQuarterdeckCommandParts(context)).toThrow(
				"could not verify native installation admission",
			);
		},
	);
	it.each(["disconnected", "missing send"])("rejects a synthetic helper with %s IPC", (kind) => {
		const context = createSyntheticInvocation();
		if (kind === "disconnected") Object.defineProperty(process, "connected", { configurable: true, value: false });
		else process.send = undefined;
		expect(() => resolveQuarterdeckCommandParts(context)).toThrow("could not verify native installation admission");
	});

	it("rejects changed lab config, runtime state, and host simulation identity", () => {
		const context = createSyntheticInvocation();
		vi.stubEnv("QUARTERDECK_STATE_HOME", dirname(context.stateHome));
		expect(() => resolveQuarterdeckCommandParts(context)).toThrow("could not verify native installation admission");
		vi.stubEnv("QUARTERDECK_STATE_HOME", context.stateHome);
		expect(() => resolveQuarterdeckCommandParts({ ...context, argv: context.argv.slice(0, -1) })).toThrow(
			"could not verify native installation admission",
		);
		writeFileSync(context.configPath, "{}");
		expect(() => resolveQuarterdeckCommandParts(context)).toThrow("could not verify native installation admission");
	});

	it("re-enters native admission while retaining the CLI and Node arguments", () => {
		const context = createBundledInvocation();
		expect(buildQuarterdeckCommandParts(["hooks", "notify"], { ...context, execArgv: ["--no-warnings"] })).toEqual([
			context.wrapper,
			"--no-warnings",
			context.cli,
			"hooks",
			"notify",
		]);
	});

	it("does not accept admission environment strings without the inherited descriptor", () => {
		const context = createBundledInvocation();
		vi.stubEnv("QUARTERDECK_INSTALLATION_LOCK_FD", "199");
		expect(() => resolveQuarterdeckCommandParts(context)).toThrow("could not verify native installation admission");
	});

	it("does not accept a descriptor for a different lock inode", () => {
		const context = createBundledInvocation();
		const replacement = join(dirname(context.lock), "replacement.lock");
		writeFileSync(replacement, "", { mode: 0o600 });
		vi.stubEnv("QUARTERDECK_INSTALLATION_LOCK_PATH", replacement);
		expect(() => resolveQuarterdeckCommandParts(context)).toThrow("could not verify native installation admission");
	});

	it.each(["missing", "symlink", "not-executable"])("refuses a %s admission wrapper", (kind) => {
		const context = createBundledInvocation();
		rmSync(context.wrapper);
		if (kind === "symlink") symlinkSync(context.execPath, context.wrapper);
		if (kind === "not-executable") writeFileSync(context.wrapper, "invalid wrapper", { mode: 0o600 });
		expect(() => resolveQuarterdeckCommandParts(context)).toThrow("could not verify native installation admission");
	});

	it("preserves ordinary Node and unrelated executables even with desktop environment strings", () => {
		createBundledInvocation();
		for (const execPath of ["/usr/local/bin/node", "/external/runtime/bin/nodeHost"]) {
			expect(resolveQuarterdeckCommandParts({ execPath, argv: [execPath, "/source/cli.js"] })).toEqual([
				execPath,
				"/source/cli.js",
			]);
		}
	});

	it("routes Claude, Codex, and Pi commands through admission without rewriting the provider", async () => {
		const context = createBundledInvocation();
		Object.defineProperty(process, "execPath", { configurable: true, value: context.execPath });
		process.argv = context.argv;
		process.execArgv = [];
		vi.stubEnv("HOME", fixtureRoot);
		vi.stubEnv("USERPROFILE", fixtureRoot);
		vi.stubEnv("QUARTERDECK_STATE_HOME", undefined);

		// Inside the bundled dist/cli.js, hook commands are rewritten to the sibling
		// dist/hooks.js so provider hooks avoid starting the full server bundle, and
		// they still acquire admission through the wrapper.
		mkdirSync(dirname(context.cli), { recursive: true });
		writeFileSync(context.cli, "synthetic cli");
		writeFileSync(context.hooksEntry, "synthetic hooks entry");
		expect(buildQuarterdeckHookCommandParts(["hooks", "notify"], context, context.cli)).toEqual([
			context.wrapper,
			context.hooksEntry,
			"hooks",
			"notify",
		]);

		// This test runs from source, which has no sibling bundle, so generated
		// commands keep the exact admitted command serving the runtime.
		const prefix = buildShellCommandLine(context.wrapper, [context.cli], process.platform);
		for (const groups of [buildClaudeHooksSettings().hooks, buildCodexHooksConfig()]) {
			for (const matchers of Object.values(groups)) {
				for (const matcher of matchers) {
					for (const hook of matcher.hooks) expect(hook.command.startsWith(`${prefix} `)).toBe(true);
				}
			}
		}

		const launch = await prepareAgentLaunch({
			taskId: "synthetic-pi-task",
			projectId: "synthetic-project",
			agentId: "pi",
			binary: "/external/provider/pi",
			args: [],
			cwd: fixtureRoot ?? tmpdir(),
			prompt: "",
		});
		expect(JSON.parse(launch.env[QUARTERDECK_PI_HOOK_COMMAND_ENV] ?? "null")).toEqual([
			context.wrapper,
			context.cli,
			"hooks",
			"notify",
		]);
		expect(launch.binary).toBe("/external/provider/pi");
	});
});

describe("resolveBundledHookEntryPath", () => {
	let hookFixtureRoot: string | undefined;

	afterEach(() => {
		if (hookFixtureRoot) rmSync(hookFixtureRoot, { recursive: true, force: true });
		hookFixtureRoot = undefined;
	});

	it("resolves the sibling dist/hooks.js next to a real dist/cli.js", () => {
		hookFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-entry-")));
		const distDir = join(hookFixtureRoot, "dist");
		mkdirSync(distDir, { recursive: true });
		const cli = join(distDir, "cli.js");
		const hooks = join(distDir, "hooks.js");
		writeFileSync(cli, "synthetic cli");
		writeFileSync(hooks, "synthetic hooks entry");

		expect(resolveBundledHookEntryPath(cli)).toBe(hooks);
	});

	it("returns null when no sibling dist/hooks.js exists", () => {
		hookFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-entry-")));
		const distDir = join(hookFixtureRoot, "dist");
		mkdirSync(distDir, { recursive: true });
		const cli = join(distDir, "cli.js");
		writeFileSync(cli, "synthetic cli");

		expect(resolveBundledHookEntryPath(cli)).toBeNull();
	});

	it("returns null for a tsx/dev entrypoint that is not the bundled cli.js", () => {
		hookFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-entry-")));
		const srcEntry = join(hookFixtureRoot, "cli.ts");
		writeFileSync(srcEntry, "synthetic source entrypoint");

		expect(resolveBundledHookEntryPath(srcEntry)).toBeNull();
	});

	it("returns null when the self path cannot be resolved at all", () => {
		expect(resolveBundledHookEntryPath("/nonexistent/dist/cli.js")).toBeNull();
	});

	it("resolves through an npm-global bin symlink layout to the real cli.js's sibling", () => {
		hookFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-entry-")));
		const packageDist = join(hookFixtureRoot, "lib/node_modules/quarterdeck/dist");
		mkdirSync(packageDist, { recursive: true });
		const realCli = join(packageDist, "cli.js");
		const realHooks = join(packageDist, "hooks.js");
		writeFileSync(realCli, "synthetic cli");
		writeFileSync(realHooks, "synthetic hooks entry");
		const globalBin = join(hookFixtureRoot, "bin");
		mkdirSync(globalBin, { recursive: true });
		const symlinkedCli = join(globalBin, "cli.js");
		symlinkSync(realCli, symlinkedCli);

		expect(resolveBundledHookEntryPath(symlinkedCli)).toBe(realHooks);
	});

	it("rejects a symlinked hooks.js candidate the same way resolveNodeExecutable rejects tampered Node binaries", () => {
		hookFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-entry-")));
		const distDir = join(hookFixtureRoot, "dist");
		mkdirSync(distDir, { recursive: true });
		const cli = join(distDir, "cli.js");
		writeFileSync(cli, "synthetic cli");
		const elsewhere = join(hookFixtureRoot, "attacker-controlled.js");
		writeFileSync(elsewhere, "not the real hooks entry");
		symlinkSync(elsewhere, join(distDir, "hooks.js"));

		expect(resolveBundledHookEntryPath(cli)).toBeNull();
	});

	// A literal backslash in a filename is POSIX-only; on win32 "dist\\cli.js" is a real subdirectory path.
	it.runIf(process.platform !== "win32")(
		"recognizes a Windows-style path separator independently of the host platform",
		() => {
			// POSIX filenames may literally contain a backslash character, so a real file
			// can end in "\\cli.js" without the directory actually being Windows-shaped.
			// This exercises the suffix check with an injected Windows separator exactly
			// as it would run on win32, where realpathSync already returns "\\"-joined paths.
			hookFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-entry-")));
			const cli = join(hookFixtureRoot, "dist\\cli.js");
			const hooks = join(hookFixtureRoot, "hooks.js");
			writeFileSync(cli, "synthetic cli");
			writeFileSync(hooks, "synthetic hooks entry");

			expect(resolveBundledHookEntryPath(cli, "\\")).toBe(hooks);
			// The default (host-native) separator must not match this backslash-suffixed name.
			expect(resolveBundledHookEntryPath(cli)).toBeNull();
		},
	);
});

describe("buildQuarterdeckHookCommandParts / buildQuarterdeckHookCommandLine", () => {
	let hookFixtureRoot: string | undefined;

	afterEach(() => {
		if (hookFixtureRoot) rmSync(hookFixtureRoot, { recursive: true, force: true });
		hookFixtureRoot = undefined;
	});

	it("targets the bundled lightweight hook entry when dist/hooks.js exists", () => {
		hookFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-entry-")));
		const distDir = join(hookFixtureRoot, "dist");
		mkdirSync(distDir, { recursive: true });
		writeFileSync(join(distDir, "cli.js"), "synthetic cli");
		writeFileSync(join(distDir, "hooks.js"), "synthetic hooks entry");
		const context = { execPath: "/usr/local/bin/node", argv: ["/usr/local/bin/node", join(distDir, "cli.js")] };

		expect(buildQuarterdeckHookCommandParts(["hooks", "notify"], context, join(distDir, "cli.js"))).toEqual([
			"/usr/local/bin/node",
			join(distDir, "hooks.js"),
			"hooks",
			"notify",
		]);
	});

	it("falls back to the current command when the bundled hook entry is missing", () => {
		hookFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "quarterdeck-hook-entry-")));
		const distDir = join(hookFixtureRoot, "dist");
		mkdirSync(distDir, { recursive: true });
		writeFileSync(join(distDir, "cli.js"), "synthetic cli");
		const context = { execPath: "/usr/local/bin/node", argv: ["/usr/local/bin/node", join(distDir, "cli.js")] };

		expect(buildQuarterdeckHookCommandParts(["hooks", "notify"], context, join(distDir, "cli.js"))).toEqual([
			"/usr/local/bin/node",
			join(distDir, "cli.js"),
			"hooks",
			"notify",
		]);
	});

	it("serializes through buildShellCommandLine exactly like buildQuarterdeckCommandLine's fallback", () => {
		const context = {
			execPath: "C:\\Quarterdeck %NAME% ! ^ & (runtime)\\node.exe",
			argv: ["C:\\Quarterdeck %NAME% ! ^ & (runtime)\\node.exe", "C:\\Quarterdeck source\\cli.js"],
		};
		const env = { SystemRoot: "C:\\Windows" };

		expect(
			buildQuarterdeckHookCommandLine(
				["hooks", "ingest", "--event", "activity"],
				context,
				"win32",
				env,
				"/nonexistent/self/path.ts",
			),
		).toBe(buildQuarterdeckCommandLine(["hooks", "ingest", "--event", "activity"], context, "win32", env));
	});
});
