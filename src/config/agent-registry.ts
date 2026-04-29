import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";

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
const MINIMUM_PI_VERSION = "0.70.2";
const PROBE_OUTPUT_SNIPPET_MAX_LENGTH = 500;
const CODEX_PROBE_TIMEOUT_MS = 3_000;
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
	const detected: string[] = [];

	for (const entry of RUNTIME_AGENT_CATALOG) {
		if (isBinaryAvailableOnPath(entry.binary)) {
			detected.push(entry.binary);
		}
	}
	if (isBinaryAvailableOnPath("npx")) {
		detected.push("npx");
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

interface ProbeCommandResult {
	stdout: string;
	stderr: string;
	exitStatus: number | null;
	signal: NodeJS.Signals | null;
}

function runProbeCommand(binary: string, args: string[]): Promise<ProbeCommandResult> {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			args,
			{
				encoding: "utf8",
				timeout: CODEX_PROBE_TIMEOUT_MS,
			},
			(error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
				const exitStatus = error ? (typeof error.code === "number" ? error.code : null) : 0;
				const signal = error?.signal ?? null;
				if (error && typeof error.code === "string") {
					reject(error);
					return;
				}
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					exitStatus,
					signal,
				});
			},
		);
	});
}

async function detectAgentVersion(agentName: string, binary: string): Promise<string | null> {
	try {
		const result = await runProbeCommand(binary, ["--version"]);
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const version = extractVersion(output);
		log.debug(`${agentName} version probe completed`, {
			binary,
			version,
			exitStatus: result.exitStatus,
			signal: result.signal,
			stderrSnippet: summarizeProbeOutput(result.stderr),
		});
		return version;
	} catch (error) {
		log.debug(`${agentName} version probe failed`, {
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

async function codexSupportsNativeHooks(binary: string): Promise<boolean> {
	try {
		const result = await runProbeCommand(binary, ["features", "list"]);
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const supported = parseCodexFeaturesListOutput(output);
		log.debug("Codex native hook feature probe completed", {
			binary,
			supported,
			exitStatus: result.exitStatus,
			signal: result.signal,
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

async function resolvePiAvailability(binary: string): Promise<AgentAvailability> {
	const version = await detectAgentVersion("Pi", binary);
	if (!version) {
		log.debug("Pi availability rejected: version unknown", { binary, minimumVersion: MINIMUM_PI_VERSION });
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage: `Detected on PATH, but Quarterdeck could not determine the Pi version. Upgrade to ${MINIMUM_PI_VERSION} or newer.`,
		};
	}
	if (compareSemver(version, MINIMUM_PI_VERSION) < 0) {
		log.debug("Pi availability rejected: version below minimum", {
			binary,
			version,
			minimumVersion: MINIMUM_PI_VERSION,
		});
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage: `Detected Pi ${version}, but Quarterdeck currently requires ${MINIMUM_PI_VERSION} or newer.`,
		};
	}
	log.debug("Pi availability confirmed", {
		binary,
		version,
		minimumVersion: MINIMUM_PI_VERSION,
	});
	return {
		installed: true,
		status: "installed",
		statusMessage: null,
	};
}

const AGENT_AVAILABILITY_TTL_MS = 30_000;

interface AvailabilityCacheEntry {
	result: AgentAvailability;
	checkedAt: number;
}

interface ResolveAgentAvailabilityOptions {
	allowStale?: boolean;
}

const agentAvailabilityCache = new Map<string, AvailabilityCacheEntry>();
const inFlightAgentAvailabilityProbes = new Map<string, Promise<AvailabilityCacheEntry>>();
let agentAvailabilityCacheGeneration = 0;

/** Clear the agent-availability cache. Exported for tests; also useful if a future
 *  Settings re-check button needs to force a fresh probe. */
export function resetAgentAvailabilityCache(): void {
	agentAvailabilityCacheGeneration += 1;
	agentAvailabilityCache.clear();
	inFlightAgentAvailabilityProbes.clear();
}

async function computeAgentAvailability(agentId: RuntimeAgentId, binary: string): Promise<AgentAvailability> {
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
	if (agentId === "pi") {
		return resolvePiAvailability(binary);
	}
	if (agentId !== "codex") {
		return {
			installed: true,
			status: "installed",
			statusMessage: null,
		};
	}

	const version = await detectAgentVersion("Codex", binary);
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
	if (!(await codexSupportsNativeHooks(binary))) {
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

function startAvailabilityProbe(
	cacheKey: string,
	agentId: RuntimeAgentId,
	binary: string,
): Promise<AvailabilityCacheEntry> {
	const existing = inFlightAgentAvailabilityProbes.get(cacheKey);
	if (existing) {
		return existing;
	}
	const generation = agentAvailabilityCacheGeneration;
	const probe = computeAgentAvailability(agentId, binary)
		.then((result) => {
			const entry = { result, checkedAt: Date.now() };
			if (generation === agentAvailabilityCacheGeneration) {
				agentAvailabilityCache.set(cacheKey, entry);
			}
			return entry;
		})
		.finally(() => {
			if (generation === agentAvailabilityCacheGeneration) {
				inFlightAgentAvailabilityProbes.delete(cacheKey);
			}
		});
	inFlightAgentAvailabilityProbes.set(cacheKey, probe);
	return probe;
}

async function resolveAgentAvailability(
	agentId: RuntimeAgentId,
	binary: string,
	options: ResolveAgentAvailabilityOptions = {},
): Promise<AgentAvailability> {
	const cacheKey = `${agentId}::${binary}`;
	const cached = agentAvailabilityCache.get(cacheKey);
	const now = Date.now();
	if (cached && now - cached.checkedAt < AGENT_AVAILABILITY_TTL_MS) {
		return cached.result;
	}
	if (cached && options.allowStale !== false) {
		void startAvailabilityProbe(cacheKey, agentId, binary).catch((error) => {
			log.debug("Agent availability stale refresh failed", {
				agentId,
				binary,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return cached.result;
	}
	const entry = await startAvailabilityProbe(cacheKey, agentId, binary);
	return entry.result;
}

export async function getAgentAvailability(
	agentId: RuntimeAgentId,
	options: ResolveAgentAvailabilityOptions = {},
): Promise<AgentAvailability> {
	const entry = getRuntimeLaunchSupportedAgentCatalog().find((candidate) => candidate.id === agentId);
	if (!entry) {
		return {
			installed: false,
			status: "missing",
			statusMessage: null,
		};
	}
	return resolveAgentAvailability(entry.id, entry.binary, options);
}

export async function detectRunnableAgentIds(): Promise<RuntimeAgentId[]> {
	const entries = await Promise.all(
		getRuntimeLaunchSupportedAgentCatalog().map(async (entry) => ({
			entry,
			availability: await resolveAgentAvailability(entry.id, entry.binary),
		})),
	);
	return entries.filter(({ availability }) => availability.installed).map(({ entry }) => entry.id);
}

/** Build the full agent definition list for the frontend (install status, configured flag, display command). */
async function getCuratedDefinitions(runtimeConfig: RuntimeConfigState): Promise<RuntimeAgentDefinition[]> {
	return await Promise.all(
		getRuntimeLaunchSupportedAgentCatalog().map(async (entry) => {
			const defaultArgs = getDefaultArgs(entry.id);
			const command = joinCommand(entry.binary, defaultArgs);
			const availability = await resolveAgentAvailability(entry.id, entry.binary);
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
		}),
	);
}

/** Resolve the user's selected agent into a launchable binary + args. Returns null if not installed. */
export async function resolveAgentCommand(runtimeConfig: RuntimeConfigState): Promise<ResolvedAgentCommand | null> {
	const selected = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === runtimeConfig.selectedAgentId);
	if (!selected) {
		return null;
	}
	const defaultArgs = getDefaultArgs(selected.id);
	const binary = selected.binary;
	const command = joinCommand(binary, defaultArgs);
	if ((await resolveAgentAvailability(selected.id, selected.binary)).installed) {
		return {
			agentId: selected.id,
			label: selected.label,
			command,
			binary,
			args: defaultArgs,
		};
	}
	return null;
}

function resolveRuntimeOpenTargetPlatform(platform: NodeJS.Platform): RuntimeConfigResponse["runtimePlatform"] {
	if (platform === "darwin") {
		return "mac";
	}
	if (platform === "win32") {
		return "windows";
	}
	if (platform === "linux") {
		return "linux";
	}
	return "other";
}

/** Assemble the complete RuntimeConfigResponse sent to the frontend. */
export async function buildRuntimeConfigResponse(runtimeConfig: RuntimeConfigState): Promise<RuntimeConfigResponse> {
	const detectedCommands = detectInstalledCommands();
	const [agents, resolved] = await Promise.all([
		getCuratedDefinitions(runtimeConfig),
		resolveAgentCommand(runtimeConfig),
	]);
	const effectiveCommand = resolved ? joinCommand(resolved.binary, resolved.args) : null;

	return {
		// Registry fields (booleans, numbers) via generic spread
		...extractGlobalConfigFields(runtimeConfig),
		// Special fields
		selectedAgentId: runtimeConfig.selectedAgentId,
		runtimePlatform: resolveRuntimeOpenTargetPlatform(process.platform),
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
