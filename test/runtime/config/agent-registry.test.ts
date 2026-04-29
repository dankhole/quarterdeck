import type { ChildProcess, ExecFileException } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
}));

vi.mock("../../../src/core/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: childProcessMocks.execFile,
	};
});

import {
	buildRuntimeConfigResponse,
	detectInstalledCommands,
	parseCodexFeaturesListOutput,
	resetAgentAvailabilityCache,
	resolveAgentCommand,
} from "../../../src/config";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

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
			callback(null, binary === "pi" ? "0.70.2\n" : "0.124.0\n", "");
			return {} as ChildProcess;
		}
		if (args[0] === "features" && args[1] === "list") {
			callback(null, "codex_hooks                         stable             true\n", "");
			return {} as ChildProcess;
		}
		callback(null, "", "");
		return {} as ChildProcess;
	});
}

beforeEach(() => {
	vi.useRealTimers();
	resetAgentAvailabilityCache();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
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

	it("disables Codex when the detected version is below the supported floor", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "0.123.0\n", "");
				return {} as ChildProcess;
			}
			if (args[0] === "features" && args[1] === "list") {
				callback(null, "codex_hooks                         stable             true\n", "");
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
		expect(codex?.statusMessage).toContain("0.124.0");
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
					callback(null, "0.124.0\n", "");
					return;
				}
				if (args[0] === "features" && args[1] === "list") {
					callback(null, "codex_hooks                         stable             true\n", "");
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

	it("disables Codex when native hook support cannot be confirmed", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "0.124.0\n", "");
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

	it("disables Pi when the detected version is below the supported floor", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "pi");
		childProcessMocks.execFile.mockImplementation((_binary: string, args: string[], ...rest: unknown[]) => {
			const callback = readExecFileCallback(rest);
			if (args[0] === "--version") {
				callback(null, "0.70.1\n", "");
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
		expect(pi?.statusMessage).toContain("0.70.2");
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
		expect(pi?.statusMessage).toContain("0.70.2");
	});
});

describe("buildRuntimeConfigResponse", () => {
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
});

describe("parseCodexFeaturesListOutput", () => {
	it("accepts column output where the feature row is not `removed`", () => {
		expect(parseCodexFeaturesListOutput("codex_hooks                         stable             true\n")).toBe(true);
	});

	it("rejects output where the feature row is marked removed (aligned columns)", () => {
		expect(parseCodexFeaturesListOutput("codex_hooks                         removed            false\n")).toBe(
			false,
		);
	});

	it("tolerates tab-separated columns", () => {
		expect(parseCodexFeaturesListOutput("codex_hooks\tstable\ttrue\n")).toBe(true);
		expect(parseCodexFeaturesListOutput("codex_hooks\tremoved\tfalse\n")).toBe(false);
	});

	it("tolerates single-space-separated columns", () => {
		expect(parseCodexFeaturesListOutput("codex_hooks stable true\n")).toBe(true);
		expect(parseCodexFeaturesListOutput("codex_hooks removed false\n")).toBe(false);
	});

	it("rejects output where the feature row is present but disabled", () => {
		expect(parseCodexFeaturesListOutput("codex_hooks stable false\n")).toBe(false);
	});

	it("treats missing feature rows as unsupported", () => {
		expect(parseCodexFeaturesListOutput("shell_tool stable true\n")).toBe(false);
		expect(parseCodexFeaturesListOutput("")).toBe(false);
	});

	it("does not false-match on a feature whose name is a prefix of codex_hooks", () => {
		expect(parseCodexFeaturesListOutput("codex_hooks_other stable true\n")).toBe(false);
	});
});
