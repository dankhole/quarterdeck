import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));

vi.mock("../../../src/core/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: childProcessMocks.spawnSync,
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

beforeEach(() => {
	resetAgentAvailabilityCache();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
	childProcessMocks.spawnSync.mockReset();
	childProcessMocks.spawnSync.mockImplementation((_, args: string[]) => {
		if (args[0] === "--version") {
			return {
				stdout: "0.124.0\n",
				stderr: "",
			};
		}
		if (args[0] === "features" && args[1] === "list") {
			return {
				stdout: "codex_hooks                         stable             true\n",
				stderr: "",
			};
		}
		return {
			stdout: "",
			stderr: "",
		};
	});
	delete process.env.QUARTERDECK_DEBUG_MODE;
	delete process.env.DEBUG_MODE;
	delete process.env.debug_mode;
});

describe("agent-registry", () => {
	it("detects installed commands from the inherited PATH", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const detected = detectInstalledCommands();

		expect(detected).toEqual(["claude"]);
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledTimes(3);
	});

	it("treats shell-only agents as unavailable", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "npx");

		const resolved = resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toBeNull();
	});

	it("disables Codex when the detected version is below the supported floor", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		childProcessMocks.spawnSync.mockImplementation((_, args: string[]) => {
			if (args[0] === "--version") {
				return {
					stdout: "0.123.0\n",
					stderr: "",
				};
			}
			if (args[0] === "features" && args[1] === "list") {
				return {
					stdout: "codex_hooks                         stable             true\n",
					stderr: "",
				};
			}
			return {
				stdout: "",
				stderr: "",
			};
		});

		const resolved = resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const response = buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const codex = response.agents.find((agent) => agent.id === "codex");

		expect(resolved).toBeNull();
		expect(codex?.installed).toBe(false);
		expect(codex?.status).toBe("upgrade_required");
		expect(codex?.statusMessage).toContain("0.124.0");
	});

	it("caches availability probes across repeated config loads", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");

		buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));

		const versionCalls = childProcessMocks.spawnSync.mock.calls.filter((call) => call[1]?.[0] === "--version");
		const featuresCalls = childProcessMocks.spawnSync.mock.calls.filter(
			(call) => call[1]?.[0] === "features" && call[1]?.[1] === "list",
		);
		expect(versionCalls).toHaveLength(1);
		expect(featuresCalls).toHaveLength(1);
	});

	it("disables Codex when native hook support cannot be confirmed", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "codex");
		childProcessMocks.spawnSync.mockImplementation((_, args: string[]) => {
			if (args[0] === "--version") {
				return {
					stdout: "0.124.0\n",
					stderr: "",
				};
			}
			if (args[0] === "features" && args[1] === "list") {
				return {
					stdout: "shell_tool                          stable             true\n",
					stderr: "",
				};
			}
			return {
				stdout: "",
				stderr: "",
			};
		});

		const resolved = resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const response = buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const codex = response.agents.find((agent) => agent.id === "codex");

		expect(resolved).toBeNull();
		expect(codex?.installed).toBe(false);
		expect(codex?.status).toBe("upgrade_required");
		expect(codex?.statusMessage).toContain("native hook support");
	});
});

describe("buildRuntimeConfigResponse", () => {
	it("includes curated agent definitions with empty default args", () => {
		const config = createTestRuntimeConfigState();

		const response = buildRuntimeConfigResponse(config);

		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
	});

	it("omits autonomous flags from curated agent commands when disabled", () => {
		const config = createTestRuntimeConfigState();
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const response = buildRuntimeConfigResponse(config);

		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "claude")?.command).toBe("claude");
		expect(response.agents.find((agent) => agent.id === "codex")?.command).toBe("codex");
	});

	it("sets debug mode from runtime environment variables", () => {
		process.env.QUARTERDECK_DEBUG_MODE = "true";
		const response = buildRuntimeConfigResponse(createTestRuntimeConfigState());
		expect(response.debugModeEnabled).toBe(true);
	});

	it("supports debug_mode fallback env name", () => {
		process.env.debug_mode = "1";
		const response = buildRuntimeConfigResponse(createTestRuntimeConfigState());
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
