import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopRuntimeOwnedProcessTrees } from "../../src/server/owned-process-shutdown.js";
import { queryOwnedProcessSnapshot } from "../../src/server/owned-process-snapshot.js";
import {
	createDesktopLaunchEnvironmentResolver,
	type DesktopLaunchEnvironmentOptions,
	sanitizeDesktopHelperEnvironment,
} from "../src/launch-environment.js";

const children: ChildProcess[] = [];
afterEach(async () => {
	await stopRuntimeOwnedProcessTrees({
		getRootPids: () =>
			children
				.filter((child) => child.exitCode === null && child.signalCode === null)
				.flatMap((child) => (child.pid ? [child.pid] : [])),
		stopSessions: () => {},
		graceMs: 0,
		timeoutMs: 1_000,
	});
	// Keep direct ChildProcess authority if the sandbox prevents a tree snapshot.
	await Promise.all(
		children.map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 250);
				child.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}),
	);
	children.splice(0);
	vi.restoreAllMocks();
});

function spawnFixture(script: string, options: SpawnOptions): ChildProcess {
	const child = spawn(process.execPath, ["-e", script], options);
	children.push(child);
	return child;
}

function environmentOptions(overrides: Partial<DesktopLaunchEnvironmentOptions> = {}): DesktopLaunchEnvironmentOptions {
	return {
		nodePath: "/Applications/Quarterdeck Test.app/runtime/bin/node",
		inheritedEnvironment: {
			PATH: "/synthetic/agents/bin",
			HOME: "/synthetic/home",
			USER: "synthetic",
			SECRET_TEST_TOKEN: "synthetic-secret",
		},
		platform: "darwin",
		getLoginShell: () => "/bin/zsh",
		captureTimeoutMs: 1_000,
		cleanupTimeoutMs: 2_000,
		...overrides,
	};
}

describe("desktop launch environment", () => {
	it("preserves provider configuration, strips injection, and prepends the pinned Node directory", () => {
		const inherited = {
			PATH: "/synthetic/bin:.:relative:/usr/bin:/synthetic/bin",
			HOME: "/synthetic/home",
			CODEX_HOME: "/synthetic/config",
			ANTHROPIC_API_KEY: "synthetic-provider-secret",
			NODE_OPTIONS: "--require malicious.js --inspect=0.0.0.0:9229",
			ELECTRON_RUN_AS_NODE: "1",
			VSCODE_INSPECTOR_OPTIONS: "synthetic-inspector",
			NODE_CHANNEL_FD: "9",
			DYLD_INSERT_LIBRARIES: "/synthetic/injection.dylib",
			"BASH_FUNC_override%%": "() { injected; }",
			INVALID_VALUE: "invalid\0value",
		};
		const environment = sanitizeDesktopHelperEnvironment(inherited, "/Bundle With Spaces/runtime/bin/node");
		expect(environment.HOME).toBe(inherited.HOME);
		expect(environment.CODEX_HOME).toBe(inherited.CODEX_HOME);
		expect(environment.ANTHROPIC_API_KEY).toBe(inherited.ANTHROPIC_API_KEY);
		expect(environment.PATH?.split(":")).toEqual([
			"/Bundle With Spaces/runtime/bin",
			"/synthetic/bin",
			"/usr/bin",
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		]);
		for (const name of [
			"NODE_OPTIONS",
			"ELECTRON_RUN_AS_NODE",
			"VSCODE_INSPECTOR_OPTIONS",
			"NODE_CHANNEL_FD",
			"DYLD_INSERT_LIBRARIES",
			"BASH_FUNC_override%%",
			"INVALID_VALUE",
		]) {
			expect(environment[name]).toBeUndefined();
		}
		expect(inherited.NODE_OPTIONS).toContain("--inspect");
	});

	it.each([
		{ isolatedLab: true, mode: "login-shell" as const },
		{ mode: "inherit" as const },
		{ inheritedEnvironment: { QUARTERDECK_AGENT_LAB: "1", PATH: "/synthetic/fake-agent" } },
		{ inheritedEnvironment: { TERM_PROGRAM: "Apple_Terminal", PATH: "/synthetic/terminal/bin" } },
	])("reuses explicit, lab, and terminal launch environments without a shell", async (override) => {
		const getLoginShell = vi.fn(() => "/bin/zsh");
		const spawnCapture = vi.fn(() => {
			throw new Error("shell must not run");
		});
		const options = environmentOptions({ ...override, getLoginShell, spawnCapture });
		const resolveEnvironment = createDesktopLaunchEnvironmentResolver(options);
		const result = await resolveEnvironment();
		expect(result.source).toBe("inherited");
		expect(result.environment.PATH).toContain(options.inheritedEnvironment.PATH);
		expect(getLoginShell).not.toHaveBeenCalled();
		expect(spawnCapture).not.toHaveBeenCalled();
	});

	it("captures through a private pipe using only the fixed noninteractive login command", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		const spawnCapture = vi.fn((executable: string, args: string[], options: SpawnOptions) => {
			expect(executable).toBe("/bin/zsh");
			expect(args).toEqual(["-l", "-c", "exec /usr/bin/env -0 >&3"]);
			expect(args).not.toContain("-i");
			expect(options.stdio).toEqual(["ignore", "ignore", "ignore", "pipe"]);
			expect(options.shell).toBe(false);
			return spawnFixture(
				"console.log('startup noise'); console.error('startup error'); require('node:fs').writeSync(3, Buffer.from('PATH=/synthetic/login/bin\\0CUSTOM_VALUE=one=two\\nthree\\0NODE_OPTIONS=--inspect\\0'));",
				options,
			);
		});
		const resolver = createDesktopLaunchEnvironmentResolver(environmentOptions({ spawnCapture }));
		const first = resolver();
		expect(resolver()).toBe(first);
		const result = await first;
		expect(result.source).toBe("login-shell");
		expect(result.environment.PATH?.split(":").slice(0, 2)).toEqual([
			"/Applications/Quarterdeck Test.app/runtime/bin",
			"/synthetic/login/bin",
		]);
		expect(result.environment.CUSTOM_VALUE).toBe("one=two\nthree");
		expect(result.environment.SECRET_TEST_TOKEN).toBe("synthetic-secret");
		expect(result.environment.NODE_OPTIONS).toBeUndefined();
		expect(await resolver()).toBe(result);
		expect(spawnCapture).toHaveBeenCalledTimes(1);
		expect(consoleError).not.toHaveBeenCalled();
		expect(consoleLog).not.toHaveBeenCalled();
	});

	it("does not allow inherited SHELL or an arbitrary executable to become a command", async () => {
		const spawnCapture = vi.fn(() => {
			throw new Error("must not execute an unapproved shell");
		});
		const result = await createDesktopLaunchEnvironmentResolver(
			environmentOptions({
				inheritedEnvironment: { SHELL: "/tmp/untrusted-shell", PATH: "/synthetic/bin" },
				getLoginShell: () => "/tmp/untrusted-shell",
				spawnCapture,
			}),
		)();
		expect(result).toMatchObject({
			source: "fallback",
			failureReason: "unsupported_shell",
			processCleanup: "not_needed",
		});
		expect(spawnCapture).not.toHaveBeenCalled();
	});

	it.each(["MALFORMED\\0", "DUPLICATE=1\\0DUPLICATE=2\\0", "BAD-NAME=value\\0", "MISSING_TERMINATOR=value"])(
		"rejects malformed environment records without exposing values",
		async (encoded) => {
			const bytes = encoded.replaceAll("\\0", "\0");
			const result = await createDesktopLaunchEnvironmentResolver(
				environmentOptions({
					spawnCapture: (_executable, _args, options) =>
						spawnFixture(`require('node:fs').writeSync(3, Buffer.from(${JSON.stringify(bytes)}));`, options),
				}),
			)();
			expect(result).toMatchObject({ source: "fallback", failureReason: "capture_invalid" });
			expect(result.environment.SECRET_TEST_TOKEN).toBe("synthetic-secret");
			if (result.source === "fallback") {
				expect(
					JSON.stringify({ failureReason: result.failureReason, processCleanup: result.processCleanup }),
				).not.toContain("synthetic-secret");
			}
		},
	);

	it("bounds capture output and performs only one attempt after failure", async () => {
		const spawnCapture = vi.fn((_executable: string, _args: string[], options: SpawnOptions) =>
			spawnFixture("require('node:fs').writeSync(3, Buffer.alloc(1024, 65)); setInterval(() => {}, 1000);", options),
		);
		const resolver = createDesktopLaunchEnvironmentResolver(
			environmentOptions({ spawnCapture, maxCaptureBytes: 64 }),
		);
		const result = await resolver();
		expect(result).toMatchObject({
			source: "fallback",
			failureReason: "capture_output_limit",
			processCleanup: "stopped",
		});
		expect(await resolver()).toBe(result);
		expect(spawnCapture).toHaveBeenCalledTimes(1);
	});

	it("kills only the timed-out capture's exact child tree", async () => {
		const unrelated = spawnFixture("setInterval(() => {}, 1000);", { stdio: "ignore" });
		let descendantPid = 0;
		let captureChild: ChildProcess | null = null;
		const result = await createDesktopLaunchEnvironmentResolver(
			environmentOptions({
				captureTimeoutMs: 400,
				spawnCapture: (_executable, _args, options) => {
					const child = spawnFixture(
						"const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {stdio:'ignore'}); process.once('SIGTERM', () => { child.kill('SIGKILL'); process.exit(); }); require('node:fs').writeSync(3, 'CHILD_PID=' + child.pid + '\\0'); setInterval(() => {}, 1000);",
						options,
					);
					captureChild = child;
					const channel = child.stdio[3];
					if (channel instanceof Readable)
						channel.on("data", (chunk: Buffer) => {
							descendantPid = Number(chunk.toString("utf8").match(/CHILD_PID=(\d+)/u)?.[1]);
						});
					return child;
				},
			}),
		)();
		expect(result).toMatchObject({ source: "fallback", failureReason: "capture_timeout", processCleanup: "stopped" });
		expect(descendantPid).toBeGreaterThan(0);
		const snapshot = await queryOwnedProcessSnapshot();
		const capturePid = (captureChild as ChildProcess | null)?.pid;
		expect(snapshot.find((row) => row.pid === capturePid && !row.zombie)).toBeUndefined();
		expect(snapshot.find((row) => row.pid === descendantPid && !row.zombie)).toBeUndefined();
		expect(snapshot.find((row) => row.pid === unrelated.pid && !row.zombie)).toBeDefined();
	});

	it("bounds unconfirmed cleanup and returns content-safe failure metadata", async () => {
		const result = await createDesktopLaunchEnvironmentResolver(
			environmentOptions({
				captureTimeoutMs: 25,
				cleanupTimeoutMs: 25,
				spawnCapture: (_executable, _args, options) => spawnFixture("setInterval(() => {}, 1000);", options),
				stopCaptureTree: async () => await new Promise<"unconfirmed">(() => {}),
			}),
		)();
		expect(result).toMatchObject({
			source: "fallback",
			failureReason: "capture_timeout",
			processCleanup: "unconfirmed",
		});
	});
});
