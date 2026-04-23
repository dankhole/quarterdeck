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
		status: "installed",
		statusMessage: null,
		installed: true,
		configured: true,
		...overrides,
	};
}

type RuntimeConfigResponseOverrides = Omit<
	Partial<RuntimeConfigResponse>,
	| "audibleNotificationEvents"
	| "audibleNotificationSuppressCurrentProject"
	| "agents"
	| "shortcuts"
	| "pinnedBranches"
	| "promptShortcuts"
	| "hiddenDefaultPromptShortcuts"
	| "detectedCommands"
> & {
	audibleNotificationEvents?: Partial<RuntimeConfigResponse["audibleNotificationEvents"]>;
	audibleNotificationSuppressCurrentProject?: Partial<
		RuntimeConfigResponse["audibleNotificationSuppressCurrentProject"]
	>;
	agents?: RuntimeConfigResponse["agents"];
	shortcuts?: RuntimeConfigResponse["shortcuts"];
	pinnedBranches?: RuntimeConfigResponse["pinnedBranches"];
	promptShortcuts?: RuntimeConfigResponse["promptShortcuts"];
	hiddenDefaultPromptShortcuts?: RuntimeConfigResponse["hiddenDefaultPromptShortcuts"];
	detectedCommands?: RuntimeConfigResponse["detectedCommands"];
};

export type TestAudibleNotificationConfig = Pick<
	RuntimeConfigResponse,
	| "audibleNotificationsEnabled"
	| "audibleNotificationVolume"
	| "audibleNotificationEvents"
	| "audibleNotificationsOnlyWhenHidden"
	| "audibleNotificationSuppressCurrentProject"
>;

type TestAudibleNotificationConfigOverrides = Omit<
	Partial<TestAudibleNotificationConfig>,
	"audibleNotificationEvents" | "audibleNotificationSuppressCurrentProject"
> & {
	audibleNotificationEvents?: Partial<TestAudibleNotificationConfig["audibleNotificationEvents"]>;
	audibleNotificationSuppressCurrentProject?: Partial<
		TestAudibleNotificationConfig["audibleNotificationSuppressCurrentProject"]
	>;
};

const DEFAULT_RUNTIME_CONFIG_RESPONSE: RuntimeConfigResponse = {
	selectedAgentId: CONFIG_DEFAULTS.selectedAgentId,
	selectedShortcutLabel: null,
	debugModeEnabled: false,
	effectiveCommand: "claude",
	globalConfigPath: "/tmp/global-config.json",
	projectConfigPath: "/tmp/.quarterdeck/projects/test-project/config.json",
	readyForReviewNotificationsEnabled: CONFIG_DEFAULTS.readyForReviewNotificationsEnabled,
	shellAutoRestartEnabled: CONFIG_DEFAULTS.shellAutoRestartEnabled,
	showTrashWorktreeNotice: CONFIG_DEFAULTS.showTrashWorktreeNotice,
	uncommittedChangesOnCardsEnabled: CONFIG_DEFAULTS.uncommittedChangesOnCardsEnabled,
	unmergedChangesIndicatorEnabled: CONFIG_DEFAULTS.unmergedChangesIndicatorEnabled,
	behindBaseIndicatorEnabled: CONFIG_DEFAULTS.behindBaseIndicatorEnabled,
	skipTaskCheckoutConfirmation: CONFIG_DEFAULTS.skipTaskCheckoutConfirmation,
	skipHomeCheckoutConfirmation: CONFIG_DEFAULTS.skipHomeCheckoutConfirmation,
	skipCherryPickConfirmation: CONFIG_DEFAULTS.skipCherryPickConfirmation,
	audibleNotificationsEnabled: CONFIG_DEFAULTS.audibleNotificationsEnabled,
	audibleNotificationVolume: CONFIG_DEFAULTS.audibleNotificationVolume,
	audibleNotificationEvents: { ...CONFIG_DEFAULTS.audibleNotificationEvents },
	audibleNotificationsOnlyWhenHidden: CONFIG_DEFAULTS.audibleNotificationsOnlyWhenHidden,
	audibleNotificationSuppressCurrentProject: { ...CONFIG_DEFAULTS.audibleNotificationSuppressCurrentProject },
	commitPromptTemplate: "",
	openPrPromptTemplate: "",
	worktreeSystemPromptTemplate: "",
	commitPromptTemplateDefault: "",
	openPrPromptTemplateDefault: "",
	worktreeSystemPromptTemplateDefault: "",
	promptShortcuts: [],
	hiddenDefaultPromptShortcuts: [],
	detectedCommands: ["claude"],
	agents: [createTestAgentDef("claude"), createTestAgentDef("codex")],
	shortcuts: [],
	pinnedBranches: [],
	showSummaryOnCards: CONFIG_DEFAULTS.showSummaryOnCards,
	autoGenerateSummary: CONFIG_DEFAULTS.autoGenerateSummary,
	summaryStaleAfterSeconds: CONFIG_DEFAULTS.summaryStaleAfterSeconds,
	focusedTaskPollMs: CONFIG_DEFAULTS.focusedTaskPollMs,
	backgroundTaskPollMs: CONFIG_DEFAULTS.backgroundTaskPollMs,
	homeRepoPollMs: CONFIG_DEFAULTS.homeRepoPollMs,
	statuslineEnabled: CONFIG_DEFAULTS.statuslineEnabled,
	terminalFontWeight: CONFIG_DEFAULTS.terminalFontWeight,
	worktreeAddParentGitDir: CONFIG_DEFAULTS.worktreeAddParentGitDir,
	worktreeAddQuarterdeckDir: CONFIG_DEFAULTS.worktreeAddQuarterdeckDir,
	logLevel: CONFIG_DEFAULTS.logLevel,
	defaultBaseRef: CONFIG_DEFAULTS.defaultBaseRef,
	backupIntervalMinutes: CONFIG_DEFAULTS.backupIntervalMinutes,
	agentTerminalRowMultiplier: CONFIG_DEFAULTS.agentTerminalRowMultiplier,
	llmConfigured: false,
};

function cloneAgentDefs(agents: RuntimeConfigResponse["agents"]): RuntimeConfigResponse["agents"] {
	return agents.map((agent) => ({
		...agent,
		defaultArgs: [...agent.defaultArgs],
	}));
}

function cloneProjectShortcuts(shortcuts: RuntimeConfigResponse["shortcuts"]): RuntimeConfigResponse["shortcuts"] {
	return shortcuts.map((shortcut) => ({ ...shortcut }));
}

function clonePromptShortcuts(
	promptShortcuts: RuntimeConfigResponse["promptShortcuts"],
): RuntimeConfigResponse["promptShortcuts"] {
	return promptShortcuts.map((shortcut) => ({ ...shortcut }));
}

export function createTestRuntimeConfigResponse(overrides: RuntimeConfigResponseOverrides = {}): RuntimeConfigResponse {
	const selectedAgentId = overrides.selectedAgentId ?? DEFAULT_RUNTIME_CONFIG_RESPONSE.selectedAgentId;

	return {
		...DEFAULT_RUNTIME_CONFIG_RESPONSE,
		...overrides,
		selectedAgentId,
		effectiveCommand: overrides.effectiveCommand ?? selectedAgentId,
		audibleNotificationEvents: {
			...DEFAULT_RUNTIME_CONFIG_RESPONSE.audibleNotificationEvents,
			...overrides.audibleNotificationEvents,
		},
		audibleNotificationSuppressCurrentProject: {
			...DEFAULT_RUNTIME_CONFIG_RESPONSE.audibleNotificationSuppressCurrentProject,
			...overrides.audibleNotificationSuppressCurrentProject,
		},
		detectedCommands: overrides.detectedCommands
			? [...overrides.detectedCommands]
			: [...DEFAULT_RUNTIME_CONFIG_RESPONSE.detectedCommands],
		agents: overrides.agents
			? cloneAgentDefs(overrides.agents)
			: cloneAgentDefs(DEFAULT_RUNTIME_CONFIG_RESPONSE.agents),
		shortcuts: overrides.shortcuts
			? cloneProjectShortcuts(overrides.shortcuts)
			: cloneProjectShortcuts(DEFAULT_RUNTIME_CONFIG_RESPONSE.shortcuts),
		pinnedBranches: overrides.pinnedBranches
			? [...overrides.pinnedBranches]
			: [...DEFAULT_RUNTIME_CONFIG_RESPONSE.pinnedBranches],
		promptShortcuts: overrides.promptShortcuts
			? clonePromptShortcuts(overrides.promptShortcuts)
			: clonePromptShortcuts(DEFAULT_RUNTIME_CONFIG_RESPONSE.promptShortcuts),
		hiddenDefaultPromptShortcuts: overrides.hiddenDefaultPromptShortcuts
			? [...overrides.hiddenDefaultPromptShortcuts]
			: [...DEFAULT_RUNTIME_CONFIG_RESPONSE.hiddenDefaultPromptShortcuts],
	};
}

export function createSelectedAgentRuntimeConfigResponse(
	selectedAgentId: RuntimeConfigResponse["selectedAgentId"],
	overrides: RuntimeConfigResponseOverrides = {},
): RuntimeConfigResponse {
	return createTestRuntimeConfigResponse({
		selectedAgentId,
		effectiveCommand: selectedAgentId,
		detectedCommands: [selectedAgentId],
		agents: [
			createTestAgentDef("claude", {
				status: selectedAgentId === "claude" ? "installed" : "missing",
				installed: selectedAgentId === "claude",
				configured: selectedAgentId === "claude",
			}),
			createTestAgentDef("codex", {
				status: selectedAgentId === "codex" ? "installed" : "missing",
				installed: selectedAgentId === "codex",
				configured: selectedAgentId === "codex",
			}),
		],
		...overrides,
	});
}

export function createTestAudibleNotificationConfig(
	overrides: TestAudibleNotificationConfigOverrides = {},
): TestAudibleNotificationConfig {
	const config = createTestRuntimeConfigResponse();
	return {
		audibleNotificationsEnabled: overrides.audibleNotificationsEnabled ?? config.audibleNotificationsEnabled,
		audibleNotificationVolume: overrides.audibleNotificationVolume ?? config.audibleNotificationVolume,
		audibleNotificationEvents: {
			...config.audibleNotificationEvents,
			...overrides.audibleNotificationEvents,
		},
		audibleNotificationsOnlyWhenHidden:
			overrides.audibleNotificationsOnlyWhenHidden ?? config.audibleNotificationsOnlyWhenHidden,
		audibleNotificationSuppressCurrentProject: {
			...config.audibleNotificationSuppressCurrentProject,
			...overrides.audibleNotificationSuppressCurrentProject,
		},
	};
}
