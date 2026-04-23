import { describe, expect, it } from "vitest";

import { getTaskAgentNavbarHint, isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import { createSelectedAgentRuntimeConfigResponse } from "@/test-utils/runtime-config-factory";

describe("native-agent helpers", () => {
	it("treats selected agent as task-ready when agent is installed", () => {
		expect(
			isTaskAgentSetupSatisfied(
				createSelectedAgentRuntimeConfigResponse("claude", {
					detectedCommands: ["claude", "codex"],
				}),
			),
		).toBe(true);
		expect(isTaskAgentSetupSatisfied(null)).toBeNull();
	});

	it("does not show the navbar setup hint when agent is configured", () => {
		expect(
			getTaskAgentNavbarHint(
				createSelectedAgentRuntimeConfigResponse("claude", {
					detectedCommands: ["claude", "codex"],
				}),
			),
		).toBeUndefined();
	});

	it("shows the navbar setup hint when no task agent path is ready", () => {
		const config = createSelectedAgentRuntimeConfigResponse("claude", {
			detectedCommands: ["claude", "codex"],
			agents: [
				{
					id: "claude",
					label: "Claude Code",
					binary: "claude",
					command: "claude",
					defaultArgs: [],
					status: "missing",
					statusMessage: null,
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
		const config = createSelectedAgentRuntimeConfigResponse("claude", {
			detectedCommands: ["claude", "codex"],
		});
		config.agents = [];
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});
});
