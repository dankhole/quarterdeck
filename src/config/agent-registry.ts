import { spawnSync } from "node:child_process";

import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeConfigResponse } from "../core";
import { getRuntimeLaunchSupportedAgentCatalog, isBinaryAvailableOnPath, RUNTIME_AGENT_CATALOG } from "../core";
import { isLlmConfigured } from "../title";
import { extractGlobalConfigFields } from "./global-config-fields";
import type { RuntimeConfigState } from "./runtime-config";

export interface ResolvedAgentCommand {
	agentId: RuntimeAgentId;
	label: string;
	command: string;
	binary: string;
	args: string[];
}

interface AgentAvailability {
	installed: boolean;
	status: RuntimeAgentDefinition["status"];
	statusMessage: string | null;
}

// TODO: Replace this coarse version floor with explicit feature probes once
// Quarterdeck's Codex integration moves to native hooks and session-targeted resume.
const MINIMUM_CODEX_VERSION = "0.30.0";

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

function extractVersion(text: string): string | null {
	const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
	return match?.[0] ?? null;
}

function compareSemver(left: string, right: string): number {
	const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
	const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < 3; index += 1) {
		const leftPart = leftParts[index] ?? 0;
		const rightPart = rightParts[index] ?? 0;
		if (leftPart !== rightPart) {
			return leftPart - rightPart;
		}
	}
	return 0;
}

function detectCodexVersion(binary: string): string | null {
	try {
		const result = spawnSync(binary, ["--version"], {
			encoding: "utf8",
			timeout: 3000,
		});
		if (typeof result.stdout !== "string" && typeof result.stderr !== "string") {
			return null;
		}
		const output = [result.stdout, result.stderr]
			.filter((chunk): chunk is string => typeof chunk === "string")
			.join("\n");
		return extractVersion(output);
	} catch {
		return null;
	}
}

function resolveAgentAvailability(agentId: RuntimeAgentId, binary: string): AgentAvailability {
	const detected = isBinaryAvailableOnPath(binary);
	if (!detected) {
		return {
			installed: false,
			status: "missing",
			statusMessage: null,
		};
	}
	if (agentId !== "codex") {
		return {
			installed: true,
			status: "installed",
			statusMessage: null,
		};
	}

	// TODO: This is intentionally minimal for now. We still rely on PATH for discovery,
	// then use a hardcoded minimum version to block obviously outdated Codex builds.
	const version = detectCodexVersion(binary);
	if (!version) {
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage: `Detected on PATH, but Quarterdeck could not determine the Codex version. Upgrade to ${MINIMUM_CODEX_VERSION} or newer.`,
		};
	}
	if (compareSemver(version, MINIMUM_CODEX_VERSION) < 0) {
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage: `Detected Codex ${version}, but Quarterdeck currently requires ${MINIMUM_CODEX_VERSION} or newer.`,
		};
	}
	return {
		installed: true,
		status: "installed",
		statusMessage: null,
	};
}

export function detectRunnableAgentIds(): RuntimeAgentId[] {
	return getRuntimeLaunchSupportedAgentCatalog()
		.filter((entry) => resolveAgentAvailability(entry.id, entry.binary).installed)
		.map((entry) => entry.id);
}

/** Build the full agent definition list for the frontend (install status, configured flag, display command). */
function getCuratedDefinitions(runtimeConfig: RuntimeConfigState): RuntimeAgentDefinition[] {
	return getRuntimeLaunchSupportedAgentCatalog().map((entry) => {
		const defaultArgs = getDefaultArgs(entry.id);
		const command = joinCommand(entry.binary, defaultArgs);
		const availability = resolveAgentAvailability(entry.id, entry.binary);
		return {
			id: entry.id,
			label: entry.label,
			binary: entry.binary,
			command,
			defaultArgs,
			status: availability.status,
			statusMessage: availability.statusMessage,
			installed: availability.installed,
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
	if (resolveAgentAvailability(selected.id, selected.binary).installed) {
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
	const agents = getCuratedDefinitions(runtimeConfig);
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
		defaultBaseRef: runtimeConfig.defaultBaseRef,
		promptShortcuts: runtimeConfig.promptShortcuts,
		hiddenDefaultPromptShortcuts: runtimeConfig.hiddenDefaultPromptShortcuts,
	};
}
