import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
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
	selectedAgentId: CONFIG_DEFAULTS.selectedAgentId,
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: CONFIG_DEFAULTS.agentAutonomousModeEnabled,
	debugModeEnabled: false,
	effectiveCommand: "claude",
	globalConfigPath: "/tmp/global-config.json",
	projectConfigPath: "/tmp/project/.quarterdeck/config.json",
	readyForReviewNotificationsEnabled: CONFIG_DEFAULTS.readyForReviewNotificationsEnabled,
	shellAutoRestartEnabled: CONFIG_DEFAULTS.shellAutoRestartEnabled,
	showTrashWorktreeNotice: CONFIG_DEFAULTS.showTrashWorktreeNotice,
	unmergedChangesIndicatorEnabled: CONFIG_DEFAULTS.unmergedChangesIndicatorEnabled,
	behindBaseIndicatorEnabled: CONFIG_DEFAULTS.behindBaseIndicatorEnabled,
	skipTaskCheckoutConfirmation: CONFIG_DEFAULTS.skipTaskCheckoutConfirmation,
	skipHomeCheckoutConfirmation: CONFIG_DEFAULTS.skipHomeCheckoutConfirmation,
	audibleNotificationsEnabled: CONFIG_DEFAULTS.audibleNotificationsEnabled,
	audibleNotificationVolume: CONFIG_DEFAULTS.audibleNotificationVolume,
	audibleNotificationEvents: { ...CONFIG_DEFAULTS.audibleNotificationEvents },
	audibleNotificationsOnlyWhenHidden: CONFIG_DEFAULTS.audibleNotificationsOnlyWhenHidden,
	commitPromptTemplate: "",
	openPrPromptTemplate: "",
	commitPromptTemplateDefault: "",
	openPrPromptTemplateDefault: "",
	promptShortcuts: [],
	detectedCommands: ["claude"],
	agents: [createTestAgentDef("claude"), createTestAgentDef("codex")],
	shortcuts: [],
	showSummaryOnCards: CONFIG_DEFAULTS.showSummaryOnCards,
	autoGenerateSummary: CONFIG_DEFAULTS.autoGenerateSummary,
	summaryStaleAfterSeconds: CONFIG_DEFAULTS.summaryStaleAfterSeconds,
	focusedTaskPollMs: CONFIG_DEFAULTS.focusedTaskPollMs,
	backgroundTaskPollMs: CONFIG_DEFAULTS.backgroundTaskPollMs,
	homeRepoPollMs: CONFIG_DEFAULTS.homeRepoPollMs,
	statuslineEnabled: CONFIG_DEFAULTS.statuslineEnabled,
	llmConfigured: false,
};

export function createTestRuntimeConfigResponse(overrides: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
	return { ...DEFAULT_RUNTIME_CONFIG_RESPONSE, ...overrides };
}
