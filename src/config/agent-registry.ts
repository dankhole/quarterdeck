import { getRuntimeLaunchSupportedAgentCatalog, RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeConfigResponse } from "../core/api-contract";
import { isBinaryAvailableOnPath } from "../core/command-discovery";
import { isLlmConfigured } from "../title/llm-client";
import { extractGlobalConfigFields } from "./global-config-fields";
import type { RuntimeConfigState } from "./runtime-config";

export interface ResolvedAgentCommand {
	agentId: RuntimeAgentId;
	label: string;
	command: string;
	binary: string;
	args: string[];
}

/** Return the catalog-defined `baseArgs` that Quarterdeck always passes when launching an agent. */
function getDefaultArgs(agentId: RuntimeAgentId): string[] {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		return [];
	}
	return [...entry.baseArgs];
}

/**
 * Shell-quote a command arg for display in the Settings UI. Args containing only
 * safe characters (alphanumeric, dots, slashes, etc.) are left bare; everything
 * else is JSON-quoted. Not used for actual shell execution.
 */
function quoteForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

/**
 * Join a binary name and its args into a human-readable command string
 * (e.g. `claude --flag "value with spaces"`). Used for the effective command
 * display in Settings, not for spawning processes.
 */
function joinCommand(binary: string, args: string[]): string {
	if (args.length === 0) {
		return binary;
	}
	return [binary, ...args.map(quoteForDisplay)].join(" ");
}

/** Parse a truthy env var string ("1", "true", "yes", "on") into a boolean. */
function parseBooleanEnvValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Check QUARTERDECK_DEBUG_MODE / DEBUG_MODE env vars. */
function isRuntimeDebugModeEnabled(): boolean {
	const debugModeValue = process.env.QUARTERDECK_DEBUG_MODE ?? process.env.DEBUG_MODE ?? process.env.debug_mode;
	return parseBooleanEnvValue(debugModeValue);
}

/** Check PATH for each known agent binary (plus npx) and return which are available. */
export function detectInstalledCommands(): string[] {
	const candidates = [...RUNTIME_AGENT_CATALOG.map((entry) => entry.binary), "npx"];
	const detected: string[] = [];

	for (const candidate of candidates) {
		if (isBinaryAvailableOnPath(candidate)) {
			detected.push(candidate);
		}
	}

	return detected;
}

/** Build the full agent definition list for the frontend (install status, configured flag, display command). */
function getCuratedDefinitions(runtimeConfig: RuntimeConfigState, detected: string[]): RuntimeAgentDefinition[] {
	const detectedSet = new Set(detected);
	return getRuntimeLaunchSupportedAgentCatalog().map((entry) => {
		const defaultArgs = getDefaultArgs(entry.id);
		const command = joinCommand(entry.binary, defaultArgs);
		const isInstalled = detectedSet.has(entry.binary);
		return {
			id: entry.id,
			label: entry.label,
			binary: entry.binary,
			command,
			defaultArgs,
			installed: isInstalled,
			configured: runtimeConfig.selectedAgentId === entry.id,
		};
	});
}

/** Resolve the user's selected agent into a launchable binary + args. Returns null if not installed. */
export function resolveAgentCommand(runtimeConfig: RuntimeConfigState): ResolvedAgentCommand | null {
	const selected = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === runtimeConfig.selectedAgentId);
	if (!selected) {
		return null;
	}
	const defaultArgs = getDefaultArgs(selected.id);
	const command = joinCommand(selected.binary, defaultArgs);
	if (isBinaryAvailableOnPath(selected.binary)) {
		return {
			agentId: selected.id,
			label: selected.label,
			command,
			binary: selected.binary,
			args: defaultArgs,
		};
	}
	return null;
}

/** Assemble the complete RuntimeConfigResponse sent to the frontend. */
export function buildRuntimeConfigResponse(runtimeConfig: RuntimeConfigState): RuntimeConfigResponse {
	const detectedCommands = detectInstalledCommands();
	const agents = getCuratedDefinitions(runtimeConfig, detectedCommands);
	const resolved = resolveAgentCommand(runtimeConfig);
	const effectiveCommand = resolved ? joinCommand(resolved.binary, resolved.args) : null;

	return {
		// Registry fields (booleans, numbers) via generic spread
		...extractGlobalConfigFields(runtimeConfig),
		// Special fields
		selectedAgentId: runtimeConfig.selectedAgentId,
		selectedShortcutLabel: runtimeConfig.selectedShortcutLabel,
		debugModeEnabled: isRuntimeDebugModeEnabled(),
		effectiveCommand,
		globalConfigPath: runtimeConfig.globalConfigPath,
		projectConfigPath: runtimeConfig.projectConfigPath,
		llmConfigured: isLlmConfigured(),
		audibleNotificationEvents: runtimeConfig.audibleNotificationEvents,
		audibleNotificationSuppressCurrentProject: runtimeConfig.audibleNotificationSuppressCurrentProject,
		commitPromptTemplate: runtimeConfig.commitPromptTemplate,
		openPrPromptTemplate: runtimeConfig.openPrPromptTemplate,
		worktreeSystemPromptTemplate: runtimeConfig.worktreeSystemPromptTemplate,
		commitPromptTemplateDefault: runtimeConfig.commitPromptTemplateDefault,
		openPrPromptTemplateDefault: runtimeConfig.openPrPromptTemplateDefault,
		worktreeSystemPromptTemplateDefault: runtimeConfig.worktreeSystemPromptTemplateDefault,
		detectedCommands,
		agents,
		shortcuts: runtimeConfig.shortcuts,
		pinnedBranches: runtimeConfig.pinnedBranches,
		promptShortcuts: runtimeConfig.promptShortcuts,
		hiddenDefaultPromptShortcuts: runtimeConfig.hiddenDefaultPromptShortcuts,
	};
}
