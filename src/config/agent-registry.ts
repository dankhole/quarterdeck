import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";

import { CODEX_HOOKS_FEATURE_NAME } from "../codex-hooks";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeCapabilities, RuntimeConfigResponse } from "../core";
import {
	createTaggedLogger,
	getRuntimeLaunchSupportedAgentCatalog,
	isBinaryAvailableOnPath,
	RUNTIME_AGENT_CATALOG,
	resolveWindowsCompatibleCommand,
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
	reason: AgentAvailabilityReason;
	transient: boolean;
	detectedVersion?: string | null;
	requiredVersion?: string | null;
}

export type AgentAvailabilityReason =
	| "installed"
	| "missing"
	| "unsupported_version"
	| "feature_missing"
	| "probe_timeout"
	| "probe_failed";

export type AgentAvailabilityProbeKind = "version" | "features";

export type AgentAvailabilityDiagnosticEvent =
	| {
			name: "agent.availability_probe_completed";
			payload: {
				agentId: RuntimeAgentId;
				probeKind: AgentAvailabilityProbeKind;
				durationMs: number;
				outcome: "succeeded" | "probe_timeout" | "probe_failed";
			};
			level: "info" | "warn";
	  }
	| {
			name: "agent.availability_resolved";
			payload: {
				agentId: RuntimeAgentId;
				reason: AgentAvailabilityReason;
				installed: boolean;
				transient: boolean;
				detectedVersion?: string | null;
				requiredVersion?: string | null;
			};
			level: "info" | "warn";
	  };

export type AgentAvailabilityDiagnosticSink = (event: AgentAvailabilityDiagnosticEvent) => void;

const MINIMUM_CODEX_VERSION = "0.147.0";
const MINIMUM_CLAUDE_VERSION = "2.1.198";
export const SUPPORTED_PI_VERSION = "0.84.3";
const PROBE_OUTPUT_SNIPPET_MAX_LENGTH = 500;
const CODEX_PROBE_TIMEOUT_MS = 3_000;
const log = createTaggedLogger("agent-registry");
let availabilityDiagnosticSink: AgentAvailabilityDiagnosticSink | null = null;

export function setAgentAvailabilityDiagnosticSink(sink: AgentAvailabilityDiagnosticSink | null): void {
	availabilityDiagnosticSink = sink;
}

function recordAvailabilityDiagnostic(event: AgentAvailabilityDiagnosticEvent): void {
	try {
		availabilityDiagnosticSink?.(event);
	} catch {
		// Diagnostics must never affect agent discovery or task launch.
	}
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
	durationMs: number;
}

type TransientProbeFailureReason = "probe_timeout" | "probe_failed";

class AgentProbeExecutionError extends Error {
	constructor(
		readonly reason: TransientProbeFailureReason,
		readonly durationMs: number,
	) {
		super(reason === "probe_timeout" ? "Agent availability probe timed out." : "Agent availability probe failed.");
		this.name = "AgentProbeExecutionError";
	}
}

function isProbeTimeout(error: ExecFileException): boolean {
	// Node's execFile timeout terminates the process and reports `killed: true`
	// (normally with SIGTERM). A process that exits from an unrelated signal is
	// an execution failure, not evidence that the timeout elapsed.
	return error.killed === true || error.code === "ETIMEDOUT";
}

function runProbeCommand(
	agentId: RuntimeAgentId,
	probeKind: AgentAvailabilityProbeKind,
	binary: string,
	args: string[],
): Promise<ProbeCommandResult> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const command = resolveWindowsCompatibleCommand(binary, args);
		execFile(
			command.binary,
			command.args,
			{
				encoding: "utf8",
				timeout: CODEX_PROBE_TIMEOUT_MS,
			},
			(error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
				const durationMs = Math.max(0, Date.now() - startedAt);
				if (error) {
					const reason = isProbeTimeout(error) ? "probe_timeout" : "probe_failed";
					recordAvailabilityDiagnostic({
						name: "agent.availability_probe_completed",
						payload: { agentId, probeKind, durationMs, outcome: reason },
						level: "warn",
					});
					reject(new AgentProbeExecutionError(reason, durationMs));
					return;
				}
				recordAvailabilityDiagnostic({
					name: "agent.availability_probe_completed",
					payload: { agentId, probeKind, durationMs, outcome: "succeeded" },
					level: "info",
				});
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					durationMs,
				});
			},
		);
	});
}

type VersionProbeResult =
	| { ok: true; version: string }
	| { ok: false; reason: TransientProbeFailureReason | "unsupported_version" };

async function detectAgentVersion(
	agentId: RuntimeAgentId,
	agentName: string,
	binary: string,
): Promise<VersionProbeResult> {
	try {
		const result = await runProbeCommand(agentId, "version", binary, ["--version"]);
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const version = extractVersion(output);
		log.debug(`${agentName} version probe completed`, {
			binary,
			version,
			durationMs: result.durationMs,
			stderrSnippet: summarizeProbeOutput(result.stderr),
		});
		return version ? { ok: true, version } : { ok: false, reason: "unsupported_version" };
	} catch (error) {
		log.debug(`${agentName} version probe failed`, {
			binary,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			ok: false,
			reason: error instanceof AgentProbeExecutionError ? error.reason : "probe_failed",
		};
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

type FeatureProbeResult = { ok: true; supported: boolean } | { ok: false; reason: TransientProbeFailureReason };

async function codexSupportsNativeHooks(binary: string): Promise<FeatureProbeResult> {
	try {
		const result = await runProbeCommand("codex", "features", binary, ["features", "list"]);
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const supported = parseCodexFeaturesListOutput(output);
		log.debug("Codex native hook feature probe completed", {
			binary,
			supported,
			durationMs: result.durationMs,
			stdoutSnippet: summarizeProbeOutput(result.stdout),
			stderrSnippet: summarizeProbeOutput(result.stderr),
		});
		return { ok: true, supported };
	} catch (error) {
		log.debug("Codex native hook feature probe failed", {
			binary,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			ok: false,
			reason: error instanceof AgentProbeExecutionError ? error.reason : "probe_failed",
		};
	}
}

async function resolveMinimumVersionAvailability(
	agentId: RuntimeAgentId,
	agentName: string,
	binary: string,
	minimumVersion: string,
): Promise<AgentAvailability> {
	const versionResult = await detectAgentVersion(agentId, agentName, binary);
	if (!versionResult.ok) {
		log.debug(`${agentName} availability rejected: version probe failed`, {
			binary,
			minimumVersion,
			reason: versionResult.reason,
		});
		if (versionResult.reason === "unsupported_version") {
			return {
				installed: false,
				status: "upgrade_required",
				statusMessage: `Detected on PATH, but Quarterdeck could not determine the ${agentName} version. Upgrade to ${minimumVersion} or newer.`,
				reason: "unsupported_version",
				transient: false,
			};
		}
		return {
			installed: false,
			status: "missing",
			statusMessage:
				versionResult.reason === "probe_timeout"
					? `${agentName} availability check timed out. Retry the task.`
					: `Quarterdeck could not run the ${agentName} version check. Retry the task or verify the CLI runs from this shell.`,
			reason: versionResult.reason,
			transient: true,
		};
	}
	const { version } = versionResult;
	if (compareSemver(version, minimumVersion) < 0) {
		log.debug(`${agentName} availability rejected: version below minimum`, {
			binary,
			version,
			minimumVersion,
		});
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage: `Detected ${agentName} ${version}, but Quarterdeck currently requires ${minimumVersion} or newer.`,
			reason: "unsupported_version",
			transient: false,
		};
	}
	log.debug(`${agentName} availability confirmed`, {
		binary,
		version,
		minimumVersion,
	});
	return {
		installed: true,
		status: "installed",
		statusMessage: null,
		reason: "installed",
		transient: false,
	};
}

async function resolveClaudeAvailability(binary: string): Promise<AgentAvailability> {
	return resolveMinimumVersionAvailability("claude", "Claude Code", binary, MINIMUM_CLAUDE_VERSION);
}

async function resolvePiAvailability(binary: string): Promise<AgentAvailability> {
	const versionResult = await detectAgentVersion("pi", "Pi", binary);
	if (!versionResult.ok) {
		if (versionResult.reason === "unsupported_version") {
			return {
				installed: false,
				status: "upgrade_required",
				statusMessage: `Detected Pi on PATH, but Quarterdeck could not determine its version. Install exactly ${SUPPORTED_PI_VERSION} with @earendil-works/pi-coding-agent.`,
				reason: "unsupported_version",
				transient: false,
				detectedVersion: null,
				requiredVersion: SUPPORTED_PI_VERSION,
			};
		}
		return {
			installed: false,
			status: "missing",
			statusMessage:
				versionResult.reason === "probe_timeout"
					? "Pi availability check timed out. Retry the task."
					: "Quarterdeck could not run the Pi version check. Retry the task or verify Pi runs from this shell.",
			reason: versionResult.reason,
			transient: true,
		};
	}
	if (versionResult.version !== SUPPORTED_PI_VERSION) {
		return {
			installed: false,
			status: "upgrade_required",
			statusMessage: `Detected Pi ${versionResult.version}, but Quarterdeck supports exactly ${SUPPORTED_PI_VERSION}. Install @earendil-works/pi-coding-agent@${SUPPORTED_PI_VERSION}.`,
			reason: "unsupported_version",
			transient: false,
			detectedVersion: versionResult.version,
			requiredVersion: SUPPORTED_PI_VERSION,
		};
	}
	return {
		installed: true,
		status: "installed",
		statusMessage: null,
		reason: "installed",
		transient: false,
		detectedVersion: versionResult.version,
		requiredVersion: SUPPORTED_PI_VERSION,
	};
}

const AGENT_AVAILABILITY_TTL_MS = 30_000;

interface AvailabilityCacheEntry {
	result: AgentAvailability;
	checkedAt: number;
}

interface ResolveAgentAvailabilityOptions {
	allowStale?: boolean;
	forceRefresh?: boolean;
	reuseCachedFailure?: boolean;
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
		const result: AgentAvailability = {
			installed: false,
			status: "missing",
			statusMessage: `${getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === agentId)?.label ?? agentId} was not found on Quarterdeck's PATH. Install the CLI or choose another agent.`,
			reason: "missing",
			transient: false,
		};
		recordAvailabilityDiagnostic({
			name: "agent.availability_resolved",
			payload: { agentId, reason: result.reason, installed: result.installed, transient: result.transient },
			level: "warn",
		});
		return result;
	}
	let result: AgentAvailability;
	if (agentId === "pi") {
		result = await resolvePiAvailability(binary);
	} else if (agentId === "claude") {
		result = await resolveClaudeAvailability(binary);
	} else if (agentId !== "codex") {
		result = {
			installed: true,
			status: "installed",
			statusMessage: null,
			reason: "installed",
			transient: false,
		};
	} else {
		result = await resolveMinimumVersionAvailability("codex", "Codex", binary, MINIMUM_CODEX_VERSION);
		if (result.installed) {
			const featureResult = await codexSupportsNativeHooks(binary);
			if (!featureResult.ok) {
				result = {
					installed: false,
					status: "missing",
					statusMessage:
						featureResult.reason === "probe_timeout"
							? "Codex native-hook availability check timed out. Retry the task."
							: "Quarterdeck could not run the Codex native-hook check. Retry the task or verify Codex runs from this shell.",
					reason: featureResult.reason,
					transient: true,
				};
			} else if (!featureResult.supported) {
				log.debug("Codex availability rejected: native hook feature unavailable", {
					binary,
					featureName: CODEX_HOOKS_FEATURE_NAME,
				});
				result = {
					installed: false,
					status: "upgrade_required",
					statusMessage:
						"Detected Codex, but native hook support is unavailable. Enable the hooks feature or upgrade Codex.",
					reason: "feature_missing",
					transient: false,
				};
			} else {
				log.debug("Codex availability confirmed", {
					binary,
					minimumVersion: MINIMUM_CODEX_VERSION,
					featureName: CODEX_HOOKS_FEATURE_NAME,
				});
				result = {
					installed: true,
					status: "installed",
					statusMessage: null,
					reason: "installed",
					transient: false,
				};
			}
		}
	}
	recordAvailabilityDiagnostic({
		name: "agent.availability_resolved",
		payload: {
			agentId,
			reason: result.reason,
			installed: result.installed,
			transient: result.transient,
			...(result.detectedVersion !== undefined ? { detectedVersion: result.detectedVersion } : {}),
			...(result.requiredVersion !== undefined ? { requiredVersion: result.requiredVersion } : {}),
		},
		level: result.installed ? "info" : "warn",
	});
	return result;
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
			// A timeout or launcher failure says nothing durable about whether the
			// agent is runnable. Keep an older display value if one exists, but never
			// let a transient negative become launch-authoritative cache state.
			if (generation === agentAvailabilityCacheGeneration && !result.transient) {
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
	if (
		!options.forceRefresh &&
		cached &&
		now - cached.checkedAt < AGENT_AVAILABILITY_TTL_MS &&
		(cached.result.installed || options.reuseCachedFailure !== false)
	) {
		return cached.result;
	}
	if (!options.forceRefresh && cached && options.allowStale !== false) {
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
			statusMessage: `Selected agent "${agentId}" is not supported by this Quarterdeck build.`,
			reason: "missing",
			transient: false,
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
				detectedVersion: availability.detectedVersion ?? null,
				requiredVersion: availability.requiredVersion ?? null,
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

export class AgentCommandUnavailableError extends Error {
	constructor(
		readonly agentId: RuntimeAgentId,
		readonly reason: AgentAvailabilityReason,
		readonly transient: boolean,
		message: string,
	) {
		super(message);
		this.name = "AgentCommandUnavailableError";
	}
}

export interface ResolveAgentCommandForLaunchOptions {
	/** Startup recovery gets one bounded retry for a timeout or launcher failure. */
	retryTransient?: boolean;
}

/**
 * Resolve an agent for a process launch. Unlike display reads, this path never
 * serves an expired cache entry. Successful fresh entries remain reusable, while
 * transient negatives are never cached and may be retried once by recovery.
 */
export async function resolveAgentCommandForLaunch(
	runtimeConfig: RuntimeConfigState,
	options: ResolveAgentCommandForLaunchOptions = {},
): Promise<ResolvedAgentCommand> {
	const selected = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === runtimeConfig.selectedAgentId);
	if (!selected) {
		throw new AgentCommandUnavailableError(
			runtimeConfig.selectedAgentId,
			"missing",
			false,
			`Selected agent "${runtimeConfig.selectedAgentId}" is not supported by this Quarterdeck build.`,
		);
	}

	let availability = await resolveAgentAvailability(selected.id, selected.binary, {
		allowStale: false,
		reuseCachedFailure: false,
	});
	if (!availability.installed && availability.transient && options.retryTransient) {
		availability = await resolveAgentAvailability(selected.id, selected.binary, {
			allowStale: false,
			forceRefresh: true,
		});
	}
	if (!availability.installed) {
		throw new AgentCommandUnavailableError(
			selected.id,
			availability.reason,
			availability.transient,
			availability.statusMessage ?? `${selected.label} is not runnable.`,
		);
	}

	const args = getDefaultArgs(selected.id);
	return {
		agentId: selected.id,
		label: selected.label,
		command: joinCommand(selected.binary, args),
		binary: selected.binary,
		args,
	};
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
export async function buildRuntimeConfigResponse(
	runtimeConfig: RuntimeConfigState,
	runtimeCapabilities: RuntimeCapabilities,
): Promise<RuntimeConfigResponse> {
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
		runtimeCapabilities,
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
