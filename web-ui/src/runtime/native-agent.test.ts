import { describe, expect, it } from "vitest";

import { getTaskAgentNavbarHint, isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { createTestRuntimeConfigResponse } from "@/test-utils/runtime-config-factory";

function createRuntimeConfigResponse(
	selectedAgentId: RuntimeConfigResponse["selectedAgentId"],
	overrides?: Partial<RuntimeConfigResponse>,
): RuntimeConfigResponse {
	return createTestRuntimeConfigResponse({
		selectedAgentId,
		effectiveCommand: selectedAgentId,
		detectedCommands: ["claude", "codex"],
		...overrides,
	});
}

describe("native-agent helpers", () => {
	it("treats selected agent as task-ready when agent is installed", () => {
		expect(isTaskAgentSetupSatisfied(createRuntimeConfigResponse("claude"))).toBe(true);
		expect(isTaskAgentSetupSatisfied(null)).toBeNull();
	});

	it("does not show the navbar setup hint when agent is configured", () => {
		expect(getTaskAgentNavbarHint(createRuntimeConfigResponse("claude"))).toBeUndefined();
	});

	it("shows the navbar setup hint when no task agent path is ready", () => {
		const config = createRuntimeConfigResponse("claude", {
			agents: [
				{
					id: "claude",
					label: "Claude Code",
					binary: "claude",
					command: "claude",
					defaultArgs: [],
					installed: false,
					configured: true,
				},
			],
		});
		expect(getTaskAgentNavbarHint(config)).toBe("No agent configured");
		expect(
			getTaskAgentNavbarHint(config, {
				shouldUseNavigationPath: true,
			}),
		).toBeUndefined();
	});

	it("returns false when no launch-supported agents are available", () => {
		const config = createRuntimeConfigResponse("claude");
		config.agents = [];
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});
});
