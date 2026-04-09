import type { RuntimeAgentDefinition, RuntimeConfigResponse } from "@/runtime/types";

// Hardcoded test labels/binaries so the factory doesn't import @runtime-agent-catalog,
// which some test files mock without including the RUNTIME_AGENT_CATALOG export.
const TEST_AGENT_LABELS: Record<string, { label: string; binary: string }> = {
	claude: { label: "Claude Code", binary: "claude" },
	codex: { label: "OpenAI Codex", binary: "codex" },
};

export function createTestAgentDef(
	id: RuntimeAgentDefinition["id"],
	overrides?: Partial<RuntimeAgentDefinition>,
): RuntimeAgentDefinition {
	const info = TEST_AGENT_LABELS[id];
	return {
		id,
		label: info?.label ?? id,
		binary: info?.binary ?? id,
		command: info?.binary ?? id,
		defaultArgs: [],
		installed: true,
		configured: true,
		...overrides,
	};
}

const DEFAULT_RUNTIME_CONFIG_RESPONSE: RuntimeConfigResponse = {
	selectedAgentId: "claude",
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: true,
	debugModeEnabled: false,
	effectiveCommand: "claude",
	globalConfigPath: "/tmp/global-config.json",
	projectConfigPath: "/tmp/project/.quarterdeck/config.json",
	readyForReviewNotificationsEnabled: true,
	shellAutoRestartEnabled: true,
	showTrashWorktreeNotice: true,
	unmergedChangesIndicatorEnabled: false,
	audibleNotificationsEnabled: true,
	audibleNotificationVolume: 0.7,
	audibleNotificationEvents: { permission: true, review: true, failure: true, completion: true },
	audibleNotificationsOnlyWhenHidden: true,
	commitPromptTemplate: "",
	openPrPromptTemplate: "",
	commitPromptTemplateDefault: "",
	openPrPromptTemplateDefault: "",
	promptShortcuts: [],
	detectedCommands: ["claude"],
	agents: [createTestAgentDef("claude"), createTestAgentDef("codex")],
	shortcuts: [],
	showSummaryOnCards: false,
	autoGenerateSummary: false,
	summaryStaleAfterSeconds: 300,
	llmConfigured: false,
};

export function createTestRuntimeConfigResponse(overrides: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
	return { ...DEFAULT_RUNTIME_CONFIG_RESPONSE, ...overrides };
}
