import { spawnSync } from "node:child_process";

import { CODEX_HOOKS_FEATURE_NAME } from "../codex-hooks";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeConfigResponse } from "../core";
import {
	createTaggedLogger,
	getRuntimeLaunchSupportedAgentCatalog,
	isBinaryAvailableOnPath,
	RUNTIME_AGENT_CATALOG,
} from "../core";
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

const MINIMUM_CODEX_VERSION = "0.124.0";
const PROBE_OUTPUT_SNIPPET_MAX_LENGTH = 500;
const log = createTaggedLogger("agent-registry");

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

function summarizeProbeOutput(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length <= PROBE_OUTPUT_SNIPPET_MAX_LENGTH) {
		return trimmed;
	}
	return `${trimmed.slice(0, PROBE_OUTPUT_SNIPPET_MAX_LENGTH)}...`;
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
		const version = extractVersion(output);
		log.debug("Codex version probe completed", {
			binary,
			version,
			exitStatus: result.status ?? null,
			signal: result.signal ?? null,
			stderrSnippet: summarizeProbeOutput(result.stderr),
		});
		return version;
	} catch (error) {
		log.debug("Codex version probe failed", {
			binary,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export function parseCodexFeaturesListOutput(output: string): boolean {
	const line = output
		.split(/\r?\n/)
		.map((candidate) => candidate.trim())
		.find((candidate) => {
			const first = candidate.split(/\s/, 1)[0];
			return first === CODEX_HOOKS_FEATURE_NAME;
		});
	if (!line) {
		return false;
	}
	const tokens = line.split(/\s+/).filter(Boolean);
	const enabledToken = tokens.at(-1)?.toLowerCase();
	const normalizedLine = line.toLowerCase();
	// Any "removed" token anywhere on the line disqualifies the feature, no matter
	// whether Codex's column layout ends up being tabs, single spaces, or aligned
	// runs of spaces. Also require the final enabled column to be true when Codex
	// reports it; older or disabled local feature entries are not enough.
	if (/\bremoved\b/.test(normalizedLine)) {
		return false;
	}
	return enabledToken !== "false";
}

function codexSupportsNativeHooks(binary: string): boolean {
	try {
		const result = spawnSync(binary, ["features", "list"], {
			encoding: "utf8",
			timeout: 3000,
		});
		if (typeof result.stdout !== "string" && typeof result.stderr !== "string") {
			return false;
		}
		const output = [result.stdout, result.stderr]
			.filter((chunk): chunk is string => typeof chunk === "string")
			.join("\n");
		const supported = parseCodexFeaturesListOutput(output);
		log.debug("Codex native hook feature probe completed", {
			binary,
			supported,
			exitStatus: result.status ?? null,
			signal: result.signal ?? null,
			stdoutSnippet: summarizeProbeOutput(result.stdout),
			stderrSnippet: summarizeProbeOutput(result.stderr),
		});
		return supported;
	} catch (error) {
		log.debug("Codex native hook feature probe failed", {
			binary,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

const AGENT_AVAILABILITY_TTL_MS = 30_000;

interface AvailabilityCacheEntry {
	result: AgentAvailability;
	checkedAt: number;
}

const agentAvailabilityCache = new Map<string, AvailabilityCacheEntry>();

/** Clear the agent-availability cache. Exported for tests; also useful if a future
 *  Settings re-check button needs to force a fresh probe. */
export function resetAgentAvailabilityCache(): void {
	agentAvailabilityCache.clear();
}

function computeAgentAvailability(agentId: RuntimeAgentId, binary: string): AgentAvailability {
	const detected = isBinaryAvailableOnPath(binary);
	if (!detected) {
		if (agentId === "codex") {
			log.debug("Codex availability rejected: binary not detected on PATH", { binary });
		}
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

	const version = detectCodexVersion(binary);
	if (!version) {
		log.debug("Codex availability rejected: version unknown", { binary, minimumVersion: MINIMUM_CODEX_VERSION });
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage: `Detected on PATH, but Quarterdeck could not determine the Codex version. Upgrade to ${MINIMUM_CODEX_VERSION} or newer.`,
		};
	}
	if (compareSemver(version, MINIMUM_CODEX_VERSION) < 0) {
		log.debug("Codex availability rejected: version below minimum", {
			binary,
			version,
			minimumVersion: MINIMUM_CODEX_VERSION,
		});
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage: `Detected Codex ${version}, but Quarterdeck currently requires ${MINIMUM_CODEX_VERSION} or newer.`,
		};
	}
	if (!codexSupportsNativeHooks(binary)) {
		log.debug("Codex availability rejected: native hook feature unavailable", {
			binary,
			version,
			featureName: CODEX_HOOKS_FEATURE_NAME,
		});
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage:
				"Detected Codex, but Quarterdeck could not confirm native hook support. Upgrade Codex to a build with the codex_hooks feature.",
		};
	}
	log.debug("Codex availability confirmed", {
		binary,
		version,
		minimumVersion: MINIMUM_CODEX_VERSION,
		featureName: CODEX_HOOKS_FEATURE_NAME,
	});
	return {
		installed: true,
		status: "installed",
		statusMessage: null,
	};
}

function resolveAgentAvailability(agentId: RuntimeAgentId, binary: string): AgentAvailability {
	const cacheKey = `${agentId}::${binary}`;
	const cached = agentAvailabilityCache.get(cacheKey);
	const now = Date.now();
	if (cached && now - cached.checkedAt < AGENT_AVAILABILITY_TTL_MS) {
		return cached.result;
	}
	const result = computeAgentAvailability(agentId, binary);
	agentAvailabilityCache.set(cacheKey, { result, checkedAt: now });
	return result;
}

export function getAgentAvailability(agentId: RuntimeAgentId): AgentAvailability {
	const entry = getRuntimeLaunchSupportedAgentCatalog().find((candidate) => candidate.id === agentId);
	if (!entry) {
		return {
			installed: false,
			status: "missing",
			statusMessage: null,
		};
	}
	return resolveAgentAvailability(entry.id, entry.binary);
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
