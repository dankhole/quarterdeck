import type { ChildProcess, ExecFileException } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
	resolveWindowsBinaryPath: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
}));

vi.mock("../../../src/core/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
	resolveWindowsBinaryPath: commandDiscoveryMocks.resolveWindowsBinaryPath,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: childProcessMocks.execFile,
	};
});

import {
	buildRuntimeConfigResponse as buildRuntimeConfigResponseWithCapabilities,
	detectInstalledCommands,
	parseCodexFeaturesListOutput,
	resetAgentAvailabilityCache,
	resolveAgentCommand,
	resolveAgentCommandForLaunch,
	setAgentAvailabilityDiagnosticSink,
} from "../../../src/config";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

function buildRuntimeConfigResponse(
	runtimeConfig: Parameters<typeof buildRuntimeConfigResponseWithCapabilities>[0],
	runtimeCapabilities: Parameters<typeof buildRuntimeConfigResponseWithCapabilities>[1] = {
		nativeUiAvailable: true,
		hostIntegrationMode: "native",
	},
) {
	return buildRuntimeConfigResponseWithCapabilities(runtimeConfig, runtimeCapabilities);
}

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

function readExecFileCallback(args: unknown[]): ExecFileCallback {
	const callback = args.at(-1);
	if (typeof callback !== "function") {
		throw new Error("execFile mock expected a callback");
	}
	return callback as ExecFileCallback;
}

function mockSuccessfulAgentProbe(): void {
	childProcessMocks.execFile.mockImplementation((binary: string, args: string[], ...rest: unknown[]) => {
		const callback = readExecFileCallback(rest);
		if (args[0] === "--version") {
			if (binary === "claude") {
				callback(null, "2.1.198 (Claude Code)\n", "");
				return {} as ChildProcess;
			}
			callback(null, binary === "pi" ? "0.84.3\n" : "0.147.0\n", "");
			return {} as ChildProcess;
		}
		if (args[0] === "features" && args[1] === "list") {
			callback(null, "hooks                                stable             true\n", "");
			return {} as ChildProcess;
		}
		callback(null, "", "");
		return {} as ChildProcess;
	});
}

beforeEach(() => {
	vi.useRealTimers();
	resetAgentAvailabilityCache();
	setAgentAvailabilityDiagnosticSink(null);
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
	commandDiscoveryMocks.resolveWindowsBinaryPath.mockReset();
	commandDiscoveryMocks.resolveWindowsBinaryPath.mockReturnValue(null);
	childProcessMocks.execFile.mockReset();
	mockSuccessfulAgentProbe();
	delete process.env.QUARTERDECK_DEBUG_MODE;
	delete process.env.DEBUG_MODE;
	delete process.env.debug_mode;
});

describe("agent-registry", () => {
	it("detects installed commands from the inherited PATH", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const detected = detectInstalledCommands();

		expect(detected).toEqual(["claude"]);
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledTimes(4);
	});

	it("treats shell-only agents as unavailable", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "npx");

		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toBeNull();
	});

	it("disables Claude when the detected version is below the supported floor", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "2.1.197 (Claude Code)\n", "");
				return {} as ChildProcess;
			}
			callback(null, "", "");
			return {} as ChildProcess;
		});

		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "claude" }));
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "claude" }));
		const claude = response.agents.find((agent) => agent.id === "claude");

		expect(resolved).toBeNull();
		expect(claude?.installed).toBe(false);
		expect(claude?.status).toBe("upgrade_required");
		expect(claude?.statusMessage).toContain("2.1.198");
	});

	it("disables Claude when its version cannot be determined", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "Claude Code\n", "");
				return {} as ChildProcess;
			}
			callback(null, "", "");
			return {} as ChildProcess;
		});

		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "claude" }));
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "claude" }));
		const claude = response.agents.find((agent) => agent.id === "claude");

		expect(resolved).toBeNull();
		expect(claude?.installed).toBe(false);
		expect(claude?.status).toBe("upgrade_required");
		expect(claude?.statusMessage).toContain("2.1.198");
	});

	it("disables Codex when the detected version is below the supported floor", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "0.146.9\n", "");
				return {} as ChildProcess;
			}
			if (args[0] === "features" && args[1] === "list") {
				callback(null, "hooks                                stable             true\n", "");
				return {} as ChildProcess;
			}
			callback(null, "", "");
			return {} as ChildProcess;
		});

		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const codex = response.agents.find((agent) => agent.id === "codex");

		expect(resolved).toBeNull();
		expect(codex?.installed).toBe(false);
		expect(codex?.status).toBe("upgrade_required");
		expect(codex?.statusMessage).toContain("0.147.0");
	});

	it("caches availability probes across repeated config loads", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");

		await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));

		const versionCalls = childProcessMocks.execFile.mock.calls.filter((call) => call[1]?.[0] === "--version");
		const featuresCalls = childProcessMocks.execFile.mock.calls.filter(
			(call) => call[1]?.[0] === "features" && call[1]?.[1] === "list",
		);
		expect(versionCalls).toHaveLength(1);
		expect(featuresCalls).toHaveLength(1);
	});

	it("dedupes concurrent Codex availability probes", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			setTimeout(() => {
				if (args[0] === "--version") {
					callback(null, "0.147.0\n", "");
					return;
				}
				if (args[0] === "features" && args[1] === "list") {
					callback(null, "hooks                                stable             true\n", "");
					return;
				}
				callback(null, "", "");
			}, 0);
			return {} as ChildProcess;
		});

		await Promise.all([
			buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" })),
			buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" })),
		]);

		const versionCalls = childProcessMocks.execFile.mock.calls.filter((call) => call[1]?.[0] === "--version");
		const featuresCalls = childProcessMocks.execFile.mock.calls.filter(
			(call) => call[1]?.[0] === "features" && call[1]?.[1] === "list",
		);
		expect(versionCalls).toHaveLength(1);
		expect(featuresCalls).toHaveLength(1);
	});

	it("serves stale cached Codex availability while refreshing in the background", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");

		const initial = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		expect(initial.agents.find((agent) => agent.id === "codex")?.installed).toBe(true);

		vi.setSystemTime(Date.now() + 31_000);
		childProcessMocks.execFile.mockImplementation(() => ({}) as ChildProcess);

		const stale = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const versionCalls = childProcessMocks.execFile.mock.calls.filter((call) => call[1]?.[0] === "--version");
		const featuresCalls = childProcessMocks.execFile.mock.calls.filter(
			(call) => call[1]?.[0] === "features" && call[1]?.[1] === "list",
		);

		expect(stale.agents.find((agent) => agent.id === "codex")?.installed).toBe(true);
		expect(versionCalls).toHaveLength(2);
		expect(featuresCalls).toHaveLength(1);
	});

	it("does not cache a transient timeout as agent unavailability", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		let versionAttempt = 0;
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				versionAttempt += 1;
				if (versionAttempt === 1) {
					callback(
						Object.assign(new Error("timed out"), {
							code: null,
							killed: true,
							signal: "SIGTERM" as NodeJS.Signals,
						}),
						"",
						"",
					);
					return {} as ChildProcess;
				}
				callback(null, "0.147.0\n", "");
				return {} as ChildProcess;
			}
			callback(null, "hooks stable true\n", "");
			return {} as ChildProcess;
		});

		await expect(resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" }))).resolves.toBeNull();
		await expect(
			resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" })),
		).resolves.toMatchObject({
			agentId: "codex",
		});

		expect(versionAttempt).toBe(2);
	});

	it("awaits an expired availability refresh for launches instead of serving stale data", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");

		await expect(
			resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" })),
		).resolves.toMatchObject({
			agentId: "codex",
		});
		vi.setSystemTime(Date.now() + 31_000);

		await expect(
			resolveAgentCommandForLaunch(createTestRuntimeConfigState({ selectedAgentId: "codex" })),
		).resolves.toMatchObject({ agentId: "codex" });
		const versionCalls = childProcessMocks.execFile.mock.calls.filter((call) => call[1]?.[0] === "--version");
		const featuresCalls = childProcessMocks.execFile.mock.calls.filter(
			(call) => call[1]?.[0] === "features" && call[1]?.[1] === "list",
		);
		expect(versionCalls).toHaveLength(2);
		expect(featuresCalls).toHaveLength(2);
	});

	it("refreshes a fresh cached failure before launching a newly installed agent", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
		await expect(resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" }))).resolves.toBeNull();

		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		await expect(
			resolveAgentCommandForLaunch(createTestRuntimeConfigState({ selectedAgentId: "codex" })),
		).resolves.toMatchObject({ agentId: "codex" });

		expect(childProcessMocks.execFile).toHaveBeenCalledTimes(2);
	});

	it("retries one transient availability probe for startup launch resolution", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		let versionAttempt = 0;
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				versionAttempt += 1;
				if (versionAttempt === 1) {
					callback(
						Object.assign(new Error("timed out"), {
							code: null,
							killed: true,
							signal: "SIGTERM" as NodeJS.Signals,
						}),
						"",
						"",
					);
					return {} as ChildProcess;
				}
				callback(null, "0.147.0\n", "");
				return {} as ChildProcess;
			}
			callback(null, "hooks stable true\n", "");
			return {} as ChildProcess;
		});

		await expect(
			resolveAgentCommandForLaunch(createTestRuntimeConfigState({ selectedAgentId: "codex" }), {
				retryTransient: true,
			}),
		).resolves.toMatchObject({ agentId: "codex" });
		expect(versionAttempt).toBe(2);
	});

	it("preserves a precise transient launch error and records content-safe probe diagnostics", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		const diagnostics = vi.fn();
		setAgentAvailabilityDiagnosticSink(diagnostics);
		childProcessMocks.execFile.mockImplementation((_binary: string, _args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			callback(
				Object.assign(new Error("sensitive raw launcher error"), {
					code: null,
					killed: true,
					signal: "SIGTERM" as NodeJS.Signals,
				}),
				"",
				"",
			);
			return {} as ChildProcess;
		});

		await expect(
			resolveAgentCommandForLaunch(createTestRuntimeConfigState({ selectedAgentId: "codex" })),
		).rejects.toMatchObject({
			reason: "probe_timeout",
			transient: true,
			message: expect.stringContaining("timed out"),
		});
		expect(diagnostics).toHaveBeenCalledWith({
			name: "agent.availability_probe_completed",
			payload: expect.objectContaining({
				agentId: "codex",
				probeKind: "version",
				outcome: "probe_timeout",
			}),
			level: "warn",
		});
		expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("sensitive raw launcher error");
	});

	it("uses the tree-aware timeout owner instead of execFile's root-only timeout", async () => {
		vi.useFakeTimers();
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		const kill = vi.fn(() => true);
		let capturedProbeCallback = false;
		let probeCallback: ExecFileCallback = () => {
			throw new Error("Expected the version probe callback.");
		};
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			if (args.includes("/pid")) return {} as ChildProcess;
			const options = rest[0] as Record<string, unknown>;
			expect(options).not.toHaveProperty("timeout");
			probeCallback = readExecFileCallback(rest);
			capturedProbeCallback = true;
			return { pid: 4321, kill } as unknown as ChildProcess;
		});

		const resolution = resolveAgentCommandForLaunch(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		await vi.advanceTimersByTimeAsync(3_000);
		if (process.platform === "win32") {
			expect(childProcessMocks.execFile.mock.calls.some((call) => call[1]?.includes("/pid"))).toBe(true);
		} else {
			expect(kill).toHaveBeenCalledWith("SIGTERM");
		}
		expect(capturedProbeCallback).toBe(true);
		probeCallback(
			Object.assign(new Error("terminated after timeout"), {
				killed: true,
				signal: "SIGTERM" as NodeJS.Signals,
			}),
			"",
			"",
		);

		await expect(resolution).rejects.toMatchObject({ reason: "probe_timeout", transient: true });
	});

	it("classifies an unrelated probe signal as a failure rather than a timeout", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		const diagnostics = vi.fn();
		setAgentAvailabilityDiagnosticSink(diagnostics);
		childProcessMocks.execFile.mockImplementation((_binary: string, _args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			callback(
				Object.assign(new Error("process aborted"), {
					code: null,
					killed: false,
					signal: "SIGABRT" as NodeJS.Signals,
				}),
				"",
				"",
			);
			return {} as ChildProcess;
		});

		await expect(
			resolveAgentCommandForLaunch(createTestRuntimeConfigState({ selectedAgentId: "codex" })),
		).rejects.toMatchObject({
			reason: "probe_failed",
			transient: true,
			message: expect.stringContaining("could not run"),
		});
		expect(diagnostics).toHaveBeenCalledWith({
			name: "agent.availability_probe_completed",
			payload: expect.objectContaining({ outcome: "probe_failed" }),
			level: "warn",
		});
	});

	it("disables Codex when native hook support cannot be confirmed", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "0.147.0\n", "");
				return {} as ChildProcess;
			}
			if (args[0] === "features" && args[1] === "list") {
				callback(null, "shell_tool                          stable             true\n", "");
				return {} as ChildProcess;
			}
			callback(null, "", "");
			return {} as ChildProcess;
		});

		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const codex = response.agents.find((agent) => agent.id === "codex");

		expect(resolved).toBeNull();
		expect(codex?.installed).toBe(false);
		expect(codex?.status).toBe("upgrade_required");
		expect(codex?.statusMessage).toContain("native hook support");
	});

	it("runs Windows command-shim availability probes through ComSpec", async () => {
		const originalPlatform = process.platform;
		const originalEnv = { ...process.env };
		const comSpec = "C:\\Windows\\System32\\cmd.exe";
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env = {
				ComSpec: comSpec,
				PATH: "",
				PATHEXT: ".COM;.EXE;.BAT;.CMD",
			};
			commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
			commandDiscoveryMocks.resolveWindowsBinaryPath.mockReturnValue({
				extension: ".cmd",
				path: "C:\\tools\\codex.cmd",
			});
			childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
				const callback = readExecFileCallback(rest);
				const commandLine = args.join(" ");
				if (commandLine.includes("--version")) {
					callback(null, "0.147.0\n", "");
					return {} as ChildProcess;
				}
				if (commandLine.includes("features") && commandLine.includes("list")) {
					callback(null, "hooks                                stable             true\n", "");
					return {} as ChildProcess;
				}
				callback(null, "", "");
				return {} as ChildProcess;
			});

			const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" }));

			expect(resolved?.agentId).toBe("codex");
			expect(childProcessMocks.execFile).toHaveBeenCalledTimes(2);
			expect(childProcessMocks.execFile.mock.calls.every((call) => call[0] === comSpec)).toBe(true);
			expect(childProcessMocks.execFile.mock.calls[0]?.[1]).toEqual(
				expect.arrayContaining(["/d", "/v:off", "/s", "/c"]),
			);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
			process.env = originalEnv;
		}
	});

	it("detects Pi from the inherited PATH", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "pi");

		const detected = detectInstalledCommands();
		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "pi" }));

		expect(detected).toEqual(["pi"]);
		expect(resolved).toEqual({
			agentId: "pi",
			label: "Pi",
			command: "pi",
			binary: "pi",
			args: [],
		});
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledWith("claude");
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledWith("codex");
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledWith("pi");
	});

	it("disables Pi when the detected version does not exactly match the supported release", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "pi");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "0.84.2\n", "");
				return {} as ChildProcess;
			}
			callback(null, "", "");
			return {} as ChildProcess;
		});

		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "pi" }));
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "pi" }));
		const pi = response.agents.find((agent) => agent.id === "pi");

		expect(resolved).toBeNull();
		expect(pi?.installed).toBe(false);
		expect(pi?.status).toBe("upgrade_required");
		expect(pi?.statusMessage).toContain("exactly 0.84.3");
		expect(pi?.statusMessage).toContain("@earendil-works/pi-coding-agent@0.84.3");
	});

	it("rejects an untested newer Pi release", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "pi");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "0.85.0\n", "");
				return {} as ChildProcess;
			}
			callback(null, "", "");
			return {} as ChildProcess;
		});

		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "pi" }));
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "pi" }));
		const pi = response.agents.find((agent) => agent.id === "pi");

		expect(resolved).toBeNull();
		expect(pi?.status).toBe("upgrade_required");
		expect(pi?.statusMessage).toContain("Detected Pi 0.85.0");
		expect(pi?.statusMessage).toContain("exactly 0.84.3");
	});

	it("disables Pi when its version cannot be determined", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "pi");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "pi\n", "");
				return {} as ChildProcess;
			}
			callback(null, "", "");
			return {} as ChildProcess;
		});

		const resolved = await resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "pi" }));
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "pi" }));
		const pi = response.agents.find((agent) => agent.id === "pi");

		expect(resolved).toBeNull();
		expect(pi?.installed).toBe(false);
		expect(pi?.status).toBe("upgrade_required");
		expect(pi?.statusMessage).toContain("exactly 0.84.3");
	});
});

describe("buildRuntimeConfigResponse", () => {
	it("reports launch-config-derived native UI availability", async () => {
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState(), {
			nativeUiAvailable: false,
			hostIntegrationMode: "unavailable",
		});

		expect(response.runtimeCapabilities).toEqual({
			nativeUiAvailable: false,
			hostIntegrationMode: "unavailable",
		});
	});

	it("reports the runtime host platform for browser open-target commands", async () => {
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState());
		const expectedPlatform =
			process.platform === "darwin"
				? "mac"
				: process.platform === "win32"
					? "windows"
					: process.platform === "linux"
						? "linux"
						: "other";

		expect(response.runtimePlatform).toBe(expectedPlatform);
	});

	it("includes curated agent definitions with empty default args", async () => {
		const config = createTestRuntimeConfigState();

		const response = await buildRuntimeConfigResponse(config);

		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "pi"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "pi")?.defaultArgs).toEqual([]);
	});

	it("omits autonomous flags from curated agent commands when disabled", async () => {
		const config = createTestRuntimeConfigState();
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const response = await buildRuntimeConfigResponse(config);

		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "pi"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "claude")?.command).toBe("claude");
		expect(response.agents.find((agent) => agent.id === "codex")?.command).toBe("codex");
		expect(response.agents.find((agent) => agent.id === "pi")?.command).toBe("pi");
	});

	it("sets debug mode from runtime environment variables", async () => {
		process.env.QUARTERDECK_DEBUG_MODE = "true";
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState());
		expect(response.debugModeEnabled).toBe(true);
	});

	it("supports debug_mode fallback env name", async () => {
		process.env.debug_mode = "1";
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState());
		expect(response.debugModeEnabled).toBe(true);
	});

	it("publishes launch-scoped native UI availability", async () => {
		const response = await buildRuntimeConfigResponse(createTestRuntimeConfigState(), {
			nativeUiAvailable: false,
			hostIntegrationMode: "unavailable",
		});
		expect(response.runtimeCapabilities.nativeUiAvailable).toBe(false);
	});
});

describe("parseCodexFeaturesListOutput", () => {
	it("accepts column output where the feature row is not `removed`", () => {
		expect(parseCodexFeaturesListOutput("hooks                                stable             true\n")).toBe(true);
	});

	it("rejects output where the feature row is marked removed (aligned columns)", () => {
		expect(parseCodexFeaturesListOutput("hooks                                removed            false\n")).toBe(
			false,
		);
	});

	it("tolerates tab-separated columns", () => {
		expect(parseCodexFeaturesListOutput("hooks\tstable\ttrue\n")).toBe(true);
		expect(parseCodexFeaturesListOutput("hooks\tremoved\tfalse\n")).toBe(false);
	});

	it("tolerates single-space-separated columns", () => {
		expect(parseCodexFeaturesListOutput("hooks stable true\n")).toBe(true);
		expect(parseCodexFeaturesListOutput("hooks removed false\n")).toBe(false);
	});

	it("rejects output where the feature row is present but disabled", () => {
		expect(parseCodexFeaturesListOutput("hooks stable false\n")).toBe(false);
	});

	it("treats missing feature rows as unsupported", () => {
		expect(parseCodexFeaturesListOutput("shell_tool stable true\n")).toBe(false);
		expect(parseCodexFeaturesListOutput("")).toBe(false);
	});

	it("does not false-match on other feature names that contain `hooks`", () => {
		expect(parseCodexFeaturesListOutput("plugin_hooks stable true\n")).toBe(false);
		expect(parseCodexFeaturesListOutput("codex_hooks stable true\n")).toBe(false);
	});
});
