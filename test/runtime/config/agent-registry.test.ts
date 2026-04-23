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

import { buildRuntimeConfigResponse, detectInstalledCommands, resolveAgentCommand } from "../../../src/config";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

beforeEach(() => {
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
	childProcessMocks.spawnSync.mockReset();
	childProcessMocks.spawnSync.mockReturnValue({
		stdout: "0.30.0\n",
		stderr: "",
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
		childProcessMocks.spawnSync.mockReturnValue({
			stdout: "0.29.0\n",
			stderr: "",
		});

		const resolved = resolveAgentCommand(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const response = buildRuntimeConfigResponse(createTestRuntimeConfigState({ selectedAgentId: "codex" }));
		const codex = response.agents.find((agent) => agent.id === "codex");

		expect(resolved).toBeNull();
		expect(codex?.installed).toBe(false);
		expect(codex?.status).toBe("upgrade_required");
		expect(codex?.statusMessage).toContain("0.30.0");
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
