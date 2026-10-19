import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClaudeHooksSettings } from "../../src/claude-hooks";
import { buildCodexHooksConfig } from "../../src/codex-hooks";
import { buildStatuslineCommand } from "../../src/commands/statusline";

import {
	buildQuarterdeckCommandLine,
	buildQuarterdeckCommandParts,
	buildShellCommandLine,
	resolveQuarterdeckCommandParts,
} from "../../src/core";
import * as desktopAdmission from "../../src/desktop-install/admission.js";
import { prepareAgentLaunch } from "../../src/terminal";
import { QUARTERDECK_PI_HOOK_COMMAND_ENV } from "../../src/terminal/pi-lifecycle-extension";

const originalExecPath = process.execPath;
const originalArgv = process.argv;
const originalExecArgv = process.execArgv;
let fixtureRoot: string | undefined;
let admissionFd: number | undefined;

afterEach(() => {
	Object.defineProperty(process, "execPath", { configurable: true, value: originalExecPath });
	process.argv = originalArgv;
	process.execArgv = originalExecArgv;
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
	return { execPath, argv: [execPath, cli], execArgv: [], wrapper, cli, lock };
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
	vi.stubEnv("QUARTERDECK_DESKTOP_CHILD", "1");
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
	it("keeps validated noncanonical synthetic runtime hooks on the native wrapper without a descriptor", () => {
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

	it.each(["QUARTERDECK_AGENT_LAB", "QUARTERDECK_DESKTOP_CHILD", "QUARTERDECK_DESKTOP_LAB_CONFIG"])(
		"rejects synthetic environment without %s",
		(key) => {
			const context = createSyntheticInvocation();
			vi.stubEnv(key, undefined);
			expect(() => resolveQuarterdeckCommandParts(context)).toThrow(
				"could not verify native installation admission",
			);
		},
	);

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

	it("routes Claude, Codex, Pi, and statusline commands through admission without rewriting the provider", async () => {
		const context = createBundledInvocation();
		Object.defineProperty(process, "execPath", { configurable: true, value: context.execPath });
		process.argv = context.argv;
		process.execArgv = [];
		vi.stubEnv("HOME", fixtureRoot);
		vi.stubEnv("USERPROFILE", fixtureRoot);
		vi.stubEnv("QUARTERDECK_STATE_HOME", undefined);

		const prefix = buildShellCommandLine(context.wrapper, [context.cli], process.platform);
		for (const groups of [buildClaudeHooksSettings().hooks, buildCodexHooksConfig()]) {
			for (const matchers of Object.values(groups)) {
				for (const matcher of matchers) {
					for (const hook of matcher.hooks) expect(hook.command.startsWith(`${prefix} `)).toBe(true);
				}
			}
		}
		expect(buildStatuslineCommand()).toBe(`${prefix} 'statusline'`);

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
