import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
}));

vi.mock("../../../src/core/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
}));

import { buildRuntimeConfigResponse, detectInstalledCommands, resolveAgentCommand } from "../../../src/config";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

beforeEach(() => {
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
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
});

describe("buildRuntimeConfigResponse", () => {
	it("includes curated agent definitions with empty default args", () => {
		const config = createTestRuntimeConfigState();

		const response = buildRuntimeConfigResponse(config);

		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
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
