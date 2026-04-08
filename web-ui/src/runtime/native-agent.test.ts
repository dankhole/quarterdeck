import { describe, expect, it } from "vitest";

import { getTaskAgentNavbarHint, isTaskAgentSetupSatisfied } from "@/runtime/native-agent";
import type { RuntimeConfigResponse } from "@/runtime/types";

function createRuntimeConfigResponse(
	selectedAgentId: RuntimeConfigResponse["selectedAgentId"],
	overrides?: Partial<RuntimeConfigResponse>,
): RuntimeConfigResponse {
	const nextConfig: RuntimeConfigResponse = {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: selectedAgentId,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project/.quarterdeck/config.json",
		readyForReviewNotificationsEnabled: true,
		showTrashWorktreeNotice: true,
		audibleNotificationsEnabled: true,
		audibleNotificationVolume: 0.7,
		audibleNotificationEvents: { permission: true, review: true, failure: true, completion: true },
		audibleNotificationsOnlyWhenHidden: true,
		detectedCommands: ["claude", "codex"],
		agents: [
			{
				id: "claude",
				label: "Claude Code",
				binary: "claude",
				command: "claude",
				defaultArgs: [],
				installed: true,
				configured: true,
			},
			{
				id: "codex",
				label: "OpenAI Codex",
				binary: "codex",
				command: "codex",
				defaultArgs: [],
				installed: true,
				configured: true,
			},
		],
		commitPromptTemplate: "",
		openPrPromptTemplate: "",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
		shortcuts: [],
		showSummaryOnCards: false,
		autoGenerateSummary: false,
		summaryStaleAfterSeconds: 300,
		llmConfigured: false,
	};
	return {
		...nextConfig,
		...overrides,
	};
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

	it("ignores non-launch agents when checking native CLI availability", () => {
		const config = createRuntimeConfigResponse("claude");
		config.agents = [
			{
				id: "gemini",
				label: "Gemini CLI",
				binary: "gemini",
				command: "gemini",
				defaultArgs: [],
				installed: true,
				configured: false,
			},
		];
		expect(isTaskAgentSetupSatisfied(config)).toBe(false);
	});
});
