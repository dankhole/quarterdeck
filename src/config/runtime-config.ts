// Persists Quarterdeck-owned runtime preferences on disk.
// This module should store Quarterdeck settings such as selected agents,
// shortcuts, and prompt templates.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type { PromptShortcut, RuntimeAgentId, RuntimeProjectShortcut } from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { getWorkspacePinnedBranchesPath } from "../state/workspace-state-utils";
import { detectInstalledCommands } from "./agent-registry";
import {
	DEFAULT_AGENT_ID,
	DEFAULT_AUDIBLE_NOTIFICATION_EVENTS,
	DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT,
	DEFAULT_COMMIT_PROMPT_TEMPLATE,
	DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	DEFAULT_PROMPT_SHORTCUTS,
	DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
} from "./config-defaults";
import {
	buildSparseGlobalConfigPayload,
	extractGlobalConfigFields,
	type GlobalConfigFieldValues,
	hasGlobalConfigFieldChanges,
	mergeGlobalConfigFields,
	normalizeGlobalConfigFields,
} from "./global-config-fields";
import { areRuntimeProjectShortcutsEqual } from "./shortcut-utils";

// --- Special-case normalization (fields NOT in the generic registry) ---

interface AudibleNotificationEventsShape {
	permission?: boolean;
	review?: boolean;
	failure?: boolean;
	completion?: boolean;
}

interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

export interface AudibleNotificationEvents {
	permission: boolean;
	review: boolean;
	failure: boolean;
	completion: boolean;
}

export interface AudibleNotificationSuppressCurrentProject {
	permission: boolean;
	review: boolean;
	failure: boolean;
	completion: boolean;
}

// The on-disk JSON shape: all fields optional, registry fields plus special fields.
type RuntimeGlobalConfigFileShape = Partial<GlobalConfigFieldValues> & {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	promptShortcuts?: Array<{ label: string; prompt: string }>;
	hiddenDefaultPromptShortcuts?: string[];
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	audibleNotificationSuppressCurrentProject?: AudibleNotificationEventsShape;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
	worktreeSystemPromptTemplate?: string;
};

// The fully resolved config state: registry fields plus special fields plus metadata.
export interface RuntimeConfigState extends GlobalConfigFieldValues {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	audibleNotificationEvents: AudibleNotificationEvents;
	audibleNotificationSuppressCurrentProject: AudibleNotificationSuppressCurrentProject;
	shortcuts: RuntimeProjectShortcut[];
	pinnedBranches: string[];
	promptShortcuts: PromptShortcut[];
	hiddenDefaultPromptShortcuts: string[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	worktreeSystemPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
	worktreeSystemPromptTemplateDefault: string;
}

// Partial update input: registry fields plus special fields.
export interface RuntimeConfigUpdateInput extends Partial<GlobalConfigFieldValues> {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	audibleNotificationSuppressCurrentProject?: AudibleNotificationEventsShape;
	shortcuts?: RuntimeProjectShortcut[];
	pinnedBranches?: string[];
	promptShortcuts?: PromptShortcut[];
	hiddenDefaultPromptShortcuts?: string[];
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
	worktreeSystemPromptTemplate?: string;
}

const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_DIR = ".quarterdeck";
const PROJECT_CONFIG_FILENAME = "config.json";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex"];

/** Assembled defaults for test fixtures — not used in production paths. */
export const DEFAULT_RUNTIME_CONFIG_STATE: RuntimeConfigState = {
	globalConfigPath: "",
	projectConfigPath: null,
	...extractGlobalConfigFields(normalizeGlobalConfigFields(null)),
	selectedAgentId: DEFAULT_AGENT_ID,
	selectedShortcutLabel: null,
	audibleNotificationEvents: { ...DEFAULT_AUDIBLE_NOTIFICATION_EVENTS },
	audibleNotificationSuppressCurrentProject: { ...DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT },
	shortcuts: [],
	pinnedBranches: [],
	promptShortcuts: [],
	hiddenDefaultPromptShortcuts: [],
	commitPromptTemplate: DEFAULT_COMMIT_PROMPT_TEMPLATE,
	openPrPromptTemplate: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	worktreeSystemPromptTemplate: DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
	commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
	openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	worktreeSystemPromptTemplateDefault: DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
};

export { DEFAULT_PROMPT_SHORTCUTS } from "./config-defaults";

/**
 * Normalize a raw string array into a set of hidden-default labels (trimmed, lowercased).
 */
export function normalizeHiddenDefaultPromptShortcuts(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const result: string[] = [];
	for (const item of raw) {
		if (typeof item === "string") {
			const trimmed = item.trim().toLowerCase();
			if (trimmed) {
				result.push(trimmed);
			}
		}
	}
	return result;
}

/**
 * Merge default prompt shortcuts with user-configured shortcuts.
 *
 * - Defaults whose label appears in `hiddenDefaults` (case-insensitive) are excluded.
 * - If the user has a shortcut whose label matches a default (case-insensitive, trimmed),
 *   the user's version wins and stays in the user's position.
 * - Defaults the user hasn't overridden or hidden are appended at the end.
 * - If the user has no saved shortcuts and no hidden defaults, returns a copy of the defaults.
 */
export function normalizePromptShortcuts(
	shortcuts: Array<{ label: string; prompt: string }> | null | undefined,
	hiddenDefaults?: string[] | null,
): PromptShortcut[] {
	const hidden = new Set(hiddenDefaults?.map((h) => h.trim().toLowerCase()) ?? []);

	// No saved shortcuts at all → return all non-hidden defaults.
	if (!Array.isArray(shortcuts)) {
		return DEFAULT_PROMPT_SHORTCUTS.filter((d) => !hidden.has(d.label.trim().toLowerCase())).map((d) => ({ ...d }));
	}

	// Parse user shortcuts.
	const userShortcuts: PromptShortcut[] = [];
	for (const shortcut of shortcuts) {
		if (!shortcut || typeof shortcut !== "object") {
			continue;
		}
		const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
		const prompt = typeof shortcut.prompt === "string" ? shortcut.prompt.trim() : "";
		if (label && prompt) {
			userShortcuts.push({ label, prompt });
		}
	}

	// Track which defaults the user already has (by label match).
	const userLabelSet = new Set(userShortcuts.map((s) => s.label.trim().toLowerCase()));

	// Defaults that are neither hidden nor already present in the user's list.
	const missingDefaults = DEFAULT_PROMPT_SHORTCUTS.filter((d) => {
		const key = d.label.trim().toLowerCase();
		return !hidden.has(key) && !userLabelSet.has(key);
	});

	// User shortcuts first (preserving order), then new defaults appended.
	const merged = [...userShortcuts, ...missingDefaults.map((d) => ({ ...d }))];
	if (merged.length > 0) return merged;
	// Only fall back to all defaults when nothing was explicitly hidden —
	// otherwise the user hid everything and we should respect that.
	return hidden.size > 0 ? [] : [...DEFAULT_PROMPT_SHORTCUTS];
}

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		if (detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	if ((agentId === "claude" || agentId === "codex") && isRuntimeAgentLaunchSupported(agentId)) {
		return agentId;
	}
	return DEFAULT_AGENT_ID;
}

function pickBestInstalledAgentId(): RuntimeAgentId | null {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
}

function normalizeShortcut(shortcut: RuntimeProjectShortcut): RuntimeProjectShortcut | null {
	if (!shortcut || typeof shortcut !== "object") {
		return null;
	}

	const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
	const command = typeof shortcut.command === "string" ? shortcut.command.trim() : "";
	const icon = typeof shortcut.icon === "string" ? shortcut.icon.trim() : "";

	if (!label || !command) {
		return null;
	}

	return {
		label,
		command,
		icon: icon || undefined,
	};
}

function normalizeShortcuts(shortcuts: RuntimeProjectShortcut[] | null | undefined): RuntimeProjectShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [];
	}
	const normalized: RuntimeProjectShortcut[] = [];
	for (const shortcut of shortcuts) {
		const parsed = normalizeShortcut(shortcut);
		if (parsed) {
			normalized.push(parsed);
		}
	}
	return normalized;
}

function normalizePinnedBranches(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			const trimmed = item.trim();
			if (trimmed) {
				result.push(trimmed);
			}
		}
	}
	return [...new Set(result)];
}

function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

function normalizeAudibleNotificationEvents(
	value: AudibleNotificationEventsShape | null | undefined,
): AudibleNotificationEvents {
	return {
		permission:
			typeof value?.permission === "boolean" ? value.permission : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.permission,
		review: typeof value?.review === "boolean" ? value.review : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.review,
		failure: typeof value?.failure === "boolean" ? value.failure : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.failure,
		completion:
			typeof value?.completion === "boolean" ? value.completion : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.completion,
	};
}

function normalizeAudibleNotificationSuppressCurrentProject(
	value: AudibleNotificationEventsShape | null | undefined,
): AudibleNotificationSuppressCurrentProject {
	return {
		permission:
			typeof value?.permission === "boolean"
				? value.permission
				: DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.permission,
		review:
			typeof value?.review === "boolean"
				? value.review
				: DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.review,
		failure:
			typeof value?.failure === "boolean"
				? value.failure
				: DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.failure,
		completion:
			typeof value?.completion === "boolean"
				? value.completion
				: DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.completion,
	};
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
}

interface RuntimeConfigPaths {
	globalConfigPath: string;
	projectConfigPath: string | null;
}

function normalizePathForComparison(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRuntimeConfigPaths(cwd: string | null): RuntimeConfigPaths {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	if (cwd === null) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	const normalizedCwd = normalizePathForComparison(cwd);
	const normalizedHome = normalizePathForComparison(homedir());
	if (normalizedCwd === normalizedHome) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	return {
		globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(cwd),
	};
}

function getRuntimeConfigLockRequests(cwd: string | null, workspaceId?: string | null): LockRequest[] {
	const paths = resolveRuntimeConfigPaths(cwd);
	const requests: LockRequest[] = [
		{
			path: paths.globalConfigPath,
			type: "file",
		},
	];
	if (paths.projectConfigPath) {
		requests.push({
			path: paths.projectConfigPath,
			type: "file",
		});
	}
	if (workspaceId) {
		requests.push({
			path: getWorkspacePinnedBranchesPath(workspaceId),
			type: "file",
		});
	}
	return requests;
}

/** Build a RuntimeConfigState from raw global + project config JSON. */
function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
	pinnedBranches,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
	pinnedBranches?: string[];
}): RuntimeConfigState {
	const fields = normalizeGlobalConfigFields(globalConfig as Record<string, unknown> | null);
	return {
		...fields,
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		audibleNotificationEvents: normalizeAudibleNotificationEvents(globalConfig?.audibleNotificationEvents),
		audibleNotificationSuppressCurrentProject: normalizeAudibleNotificationSuppressCurrentProject(
			globalConfig?.audibleNotificationSuppressCurrentProject,
		),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		pinnedBranches: normalizePinnedBranches(pinnedBranches),
		hiddenDefaultPromptShortcuts: normalizeHiddenDefaultPromptShortcuts(globalConfig?.hiddenDefaultPromptShortcuts),
		promptShortcuts: normalizePromptShortcuts(
			globalConfig?.promptShortcuts,
			globalConfig?.hiddenDefaultPromptShortcuts,
		),
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		worktreeSystemPromptTemplate: normalizePromptTemplate(
			globalConfig?.worktreeSystemPromptTemplate,
			DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		worktreeSystemPromptTemplateDefault: DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
	};
}

async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function readPinnedBranchesFile(workspaceId: string): Promise<string[]> {
	try {
		const filePath = getWorkspacePinnedBranchesPath(workspaceId);
		const raw = await readFile(filePath, "utf8");
		return normalizePinnedBranches(JSON.parse(raw));
	} catch {
		return [];
	}
}

async function writePinnedBranchesFile(workspaceId: string, pinnedBranches: string[]): Promise<void> {
	const normalized = normalizePinnedBranches(pinnedBranches);
	const filePath = getWorkspacePinnedBranchesPath(workspaceId);
	if (normalized.length === 0) {
		await rm(filePath, { force: true });
		return;
	}
	await lockedFileSystem.writeJsonFileAtomic(filePath, normalized, { lock: null });
}

/** Write global config to disk, using sparse payload to keep config.json minimal. */
async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: Partial<GlobalConfigFieldValues> & {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		promptShortcuts?: PromptShortcut[];
		hiddenDefaultPromptShortcuts?: string[];
		audibleNotificationEvents?: AudibleNotificationEventsShape;
		audibleNotificationSuppressCurrentProject?: AudibleNotificationEventsShape;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
		worktreeSystemPromptTemplate?: string;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<Record<string, unknown>>(configPath);

	// --- Registry fields: generic normalize + sparse payload ---
	const registryResolved = normalizeGlobalConfigFields(config as Record<string, unknown>);
	const payload: Record<string, unknown> = {
		...buildSparseGlobalConfigPayload(registryResolved, existing),
	};

	// --- Special fields: explicit handling ---

	// selectedAgentId
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing as RuntimeGlobalConfigFileShape | null, "selectedAgentId")
		? normalizeAgentId((existing as RuntimeGlobalConfigFileShape | null)?.selectedAgentId)
		: undefined;
	if (selectedAgentId !== undefined) {
		if ((existing !== null && Object.hasOwn(existing, "selectedAgentId")) || selectedAgentId !== DEFAULT_AGENT_ID) {
			payload.selectedAgentId = selectedAgentId;
		}
	} else if (existingSelectedAgentId !== undefined) {
		payload.selectedAgentId = existingSelectedAgentId;
	}

	// selectedShortcutLabel
	const selectedShortcutLabel =
		config.selectedShortcutLabel === undefined ? undefined : normalizeShortcutLabel(config.selectedShortcutLabel);
	const existingSelectedShortcutLabel = hasOwnKey(
		existing as RuntimeGlobalConfigFileShape | null,
		"selectedShortcutLabel",
	)
		? normalizeShortcutLabel((existing as RuntimeGlobalConfigFileShape | null)?.selectedShortcutLabel)
		: undefined;
	if (selectedShortcutLabel !== undefined) {
		if (selectedShortcutLabel) {
			payload.selectedShortcutLabel = selectedShortcutLabel;
		}
	} else if (existingSelectedShortcutLabel) {
		payload.selectedShortcutLabel = existingSelectedShortcutLabel;
	}

	// promptShortcuts
	if (config.promptShortcuts !== undefined) {
		payload.promptShortcuts = config.promptShortcuts;
	} else if (existing !== null && Object.hasOwn(existing, "promptShortcuts")) {
		payload.promptShortcuts = (existing as RuntimeGlobalConfigFileShape).promptShortcuts;
	}

	// hiddenDefaultPromptShortcuts — only persisted when non-empty or already on disk.
	const hiddenDefaults = config.hiddenDefaultPromptShortcuts ?? null;
	if (hiddenDefaults !== null && hiddenDefaults.length > 0) {
		payload.hiddenDefaultPromptShortcuts = hiddenDefaults;
	} else if (hiddenDefaults !== null && hiddenDefaults.length === 0) {
		// Explicitly empty → remove from disk (don't persist an empty array).
	} else if (existing !== null && Object.hasOwn(existing, "hiddenDefaultPromptShortcuts")) {
		payload.hiddenDefaultPromptShortcuts = (existing as RuntimeGlobalConfigFileShape).hiddenDefaultPromptShortcuts;
	}

	// commitPromptTemplate
	const commitPromptTemplate =
		config.commitPromptTemplate === undefined
			? DEFAULT_COMMIT_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
	if (
		(existing !== null && Object.hasOwn(existing, "commitPromptTemplate")) ||
		commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE
	) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}

	// openPrPromptTemplate
	const openPrPromptTemplate =
		config.openPrPromptTemplate === undefined
			? DEFAULT_OPEN_PR_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE);
	if (
		(existing !== null && Object.hasOwn(existing, "openPrPromptTemplate")) ||
		openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE
	) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}

	// worktreeSystemPromptTemplate
	const worktreeSystemPromptTemplate =
		config.worktreeSystemPromptTemplate === undefined
			? DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.worktreeSystemPromptTemplate, DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE);
	if (
		(existing !== null && Object.hasOwn(existing, "worktreeSystemPromptTemplate")) ||
		worktreeSystemPromptTemplate !== DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE
	) {
		payload.worktreeSystemPromptTemplate = worktreeSystemPromptTemplate;
	}

	// audibleNotificationEvents
	const audibleNotificationEvents = normalizeAudibleNotificationEvents(
		config.audibleNotificationEvents ?? (existing as RuntimeGlobalConfigFileShape | null)?.audibleNotificationEvents,
	);
	if (
		(existing !== null && Object.hasOwn(existing, "audibleNotificationEvents")) ||
		audibleNotificationEvents.permission !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.permission ||
		audibleNotificationEvents.review !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.review ||
		audibleNotificationEvents.failure !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.failure ||
		audibleNotificationEvents.completion !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.completion
	) {
		payload.audibleNotificationEvents = audibleNotificationEvents;
	}

	// audibleNotificationSuppressCurrentProject
	const audibleNotificationSuppressCurrentProject = normalizeAudibleNotificationSuppressCurrentProject(
		config.audibleNotificationSuppressCurrentProject ??
			(existing as RuntimeGlobalConfigFileShape | null)?.audibleNotificationSuppressCurrentProject,
	);
	if (
		(existing !== null && Object.hasOwn(existing, "audibleNotificationSuppressCurrentProject")) ||
		audibleNotificationSuppressCurrentProject.permission !==
			DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.permission ||
		audibleNotificationSuppressCurrentProject.review !==
			DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.review ||
		audibleNotificationSuppressCurrentProject.failure !==
			DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.failure ||
		audibleNotificationSuppressCurrentProject.completion !==
			DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.completion
	) {
		payload.audibleNotificationSuppressCurrentProject = audibleNotificationSuppressCurrentProject;
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

async function writeRuntimeProjectConfigFile(
	configPath: string | null,
	config: { shortcuts: RuntimeProjectShortcut[] },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	if (!configPath) {
		if (normalizedShortcuts.length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return;
	}
	if (normalizedShortcuts.length === 0) {
		await rm(configPath, { force: true });
		try {
			await rm(dirname(configPath));
		} catch {
			// Ignore missing or non-empty project config directories.
		}
		return;
	}
	const payload: RuntimeProjectConfigFileShape = { shortcuts: normalizedShortcuts };
	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

interface RuntimeConfigFiles {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}

async function readRuntimeConfigFiles(cwd: string | null): Promise<RuntimeConfigFiles> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return {
		globalConfigPath,
		projectConfigPath,
		globalConfig: await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath),
		projectConfig: projectConfigPath
			? await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath)
			: null,
	};
}

async function loadRuntimeConfigLocked(cwd: string | null, workspaceId?: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(configFiles.globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			configFiles.globalConfig = {
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	const pinnedBranches = workspaceId ? await readPinnedBranchesFile(workspaceId) : [];
	return toRuntimeConfigState({ ...configFiles, pinnedBranches });
}

/** Build RuntimeConfigState from already-resolved values. Re-normalizes for safety. */
function createRuntimeConfigStateFromValues(
	input: GlobalConfigFieldValues & {
		globalConfigPath: string;
		projectConfigPath: string | null;
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		audibleNotificationEvents: AudibleNotificationEvents;
		audibleNotificationSuppressCurrentProject: AudibleNotificationSuppressCurrentProject;
		shortcuts: RuntimeProjectShortcut[];
		pinnedBranches: string[];
		promptShortcuts: PromptShortcut[];
		hiddenDefaultPromptShortcuts: string[];
	},
): RuntimeConfigState {
	const fields = normalizeGlobalConfigFields(input as Record<string, unknown>);
	return {
		...fields,
		globalConfigPath: input.globalConfigPath,
		projectConfigPath: input.projectConfigPath,
		selectedAgentId: normalizeAgentId(input.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(input.selectedShortcutLabel),
		audibleNotificationEvents: normalizeAudibleNotificationEvents(input.audibleNotificationEvents),
		audibleNotificationSuppressCurrentProject: normalizeAudibleNotificationSuppressCurrentProject(
			input.audibleNotificationSuppressCurrentProject,
		),
		shortcuts: normalizeShortcuts(input.shortcuts),
		pinnedBranches: normalizePinnedBranches(input.pinnedBranches),
		hiddenDefaultPromptShortcuts: normalizeHiddenDefaultPromptShortcuts(input.hiddenDefaultPromptShortcuts),
		promptShortcuts: normalizePromptShortcuts(input.promptShortcuts, input.hiddenDefaultPromptShortcuts),
		commitPromptTemplate: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplate: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		worktreeSystemPromptTemplate: DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		worktreeSystemPromptTemplateDefault: DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
	};
}

export function toGlobalRuntimeConfigState(current: RuntimeConfigState): RuntimeConfigState {
	return createRuntimeConfigStateFromValues({
		...extractGlobalConfigFields(current),
		globalConfigPath: current.globalConfigPath,
		projectConfigPath: null,
		selectedAgentId: current.selectedAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		audibleNotificationEvents: current.audibleNotificationEvents,
		audibleNotificationSuppressCurrentProject: current.audibleNotificationSuppressCurrentProject,
		shortcuts: [],
		pinnedBranches: [],
		promptShortcuts: current.promptShortcuts,
		hiddenDefaultPromptShortcuts: current.hiddenDefaultPromptShortcuts,
	});
}

export async function loadRuntimeConfig(cwd: string, workspaceId?: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig !== null) {
		const pinnedBranches = workspaceId ? await readPinnedBranchesFile(workspaceId) : [];
		return toRuntimeConfigState({ ...configFiles, pinnedBranches });
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(cwd, workspaceId),
		async () => await loadRuntimeConfigLocked(cwd, workspaceId),
	);
}

export async function loadGlobalRuntimeConfig(): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(null);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(null),
		async () => await loadRuntimeConfigLocked(null),
	);
}

export async function saveRuntimeConfig(
	cwd: string,
	workspaceId: string | null,
	config: GlobalConfigFieldValues & {
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		audibleNotificationEvents: AudibleNotificationEvents;
		audibleNotificationSuppressCurrentProject: AudibleNotificationSuppressCurrentProject;
		shortcuts: RuntimeProjectShortcut[];
		pinnedBranches: string[];
		promptShortcuts: PromptShortcut[];
		hiddenDefaultPromptShortcuts: string[];
	},
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd, workspaceId), async () => {
		const { shortcuts, pinnedBranches, ...globalFields } = config;
		await writeRuntimeGlobalConfigFile(globalConfigPath, globalFields);
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts });
		if (workspaceId) {
			await writePinnedBranchesFile(workspaceId, pinnedBranches);
		}
		return createRuntimeConfigStateFromValues({
			...config,
			globalConfigPath,
			projectConfigPath,
		});
	});
}

async function applyConfigUpdates({
	globalConfigPath,
	projectConfigPath,
	workspaceId,
	current,
	updates,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	workspaceId: string | null;
	current: RuntimeConfigState;
	updates: RuntimeConfigUpdateInput;
}): Promise<RuntimeConfigState> {
	// Merge registry fields generically
	const currentFields = extractGlobalConfigFields(current);
	const mergedFields = mergeGlobalConfigFields(currentFields, updates);

	// Merge special fields explicitly
	const nextSelectedAgentId = updates.selectedAgentId ?? current.selectedAgentId;
	const nextSelectedShortcutLabel =
		updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel;
	const nextCommitPromptTemplate = updates.commitPromptTemplate ?? current.commitPromptTemplate;
	const nextOpenPrPromptTemplate = updates.openPrPromptTemplate ?? current.openPrPromptTemplate;
	const nextWorktreeSystemPromptTemplate =
		updates.worktreeSystemPromptTemplate ?? current.worktreeSystemPromptTemplate;
	const nextAudibleNotificationEvents = updates.audibleNotificationEvents
		? normalizeAudibleNotificationEvents({
				...current.audibleNotificationEvents,
				...updates.audibleNotificationEvents,
			})
		: current.audibleNotificationEvents;
	const nextAudibleNotificationSuppressCurrentProject = updates.audibleNotificationSuppressCurrentProject
		? normalizeAudibleNotificationSuppressCurrentProject({
				...current.audibleNotificationSuppressCurrentProject,
				...updates.audibleNotificationSuppressCurrentProject,
			})
		: current.audibleNotificationSuppressCurrentProject;
	const nextShortcuts = projectConfigPath ? (updates.shortcuts ?? current.shortcuts) : current.shortcuts;
	const nextPinnedBranches = workspaceId ? (updates.pinnedBranches ?? current.pinnedBranches) : current.pinnedBranches;
	const nextPromptShortcuts = updates.promptShortcuts ?? current.promptShortcuts;
	const nextHiddenDefaults = updates.hiddenDefaultPromptShortcuts ?? current.hiddenDefaultPromptShortcuts;
	const pinnedBranchesChanged =
		workspaceId !== null && JSON.stringify(nextPinnedBranches) !== JSON.stringify(current.pinnedBranches);

	// Check for any changes
	const hasChanges =
		hasGlobalConfigFieldChanges(currentFields, mergedFields) ||
		nextSelectedAgentId !== current.selectedAgentId ||
		nextSelectedShortcutLabel !== current.selectedShortcutLabel ||
		nextCommitPromptTemplate !== current.commitPromptTemplate ||
		nextOpenPrPromptTemplate !== current.openPrPromptTemplate ||
		nextWorktreeSystemPromptTemplate !== current.worktreeSystemPromptTemplate ||
		JSON.stringify(nextPromptShortcuts) !== JSON.stringify(current.promptShortcuts) ||
		JSON.stringify(nextHiddenDefaults) !== JSON.stringify(current.hiddenDefaultPromptShortcuts) ||
		nextAudibleNotificationEvents.permission !== current.audibleNotificationEvents.permission ||
		nextAudibleNotificationEvents.review !== current.audibleNotificationEvents.review ||
		nextAudibleNotificationEvents.failure !== current.audibleNotificationEvents.failure ||
		nextAudibleNotificationEvents.completion !== current.audibleNotificationEvents.completion ||
		nextAudibleNotificationSuppressCurrentProject.permission !==
			current.audibleNotificationSuppressCurrentProject.permission ||
		nextAudibleNotificationSuppressCurrentProject.review !==
			current.audibleNotificationSuppressCurrentProject.review ||
		nextAudibleNotificationSuppressCurrentProject.failure !==
			current.audibleNotificationSuppressCurrentProject.failure ||
		nextAudibleNotificationSuppressCurrentProject.completion !==
			current.audibleNotificationSuppressCurrentProject.completion ||
		(projectConfigPath !== null && !areRuntimeProjectShortcutsEqual(nextShortcuts, current.shortcuts)) ||
		pinnedBranchesChanged;

	if (!hasChanges) {
		return current;
	}

	await writeRuntimeGlobalConfigFile(globalConfigPath, {
		...mergedFields,
		selectedAgentId: nextSelectedAgentId,
		selectedShortcutLabel: nextSelectedShortcutLabel,
		promptShortcuts: nextPromptShortcuts,
		hiddenDefaultPromptShortcuts: nextHiddenDefaults,
		commitPromptTemplate: nextCommitPromptTemplate,
		openPrPromptTemplate: nextOpenPrPromptTemplate,
		worktreeSystemPromptTemplate: nextWorktreeSystemPromptTemplate,
		audibleNotificationEvents: nextAudibleNotificationEvents,
		audibleNotificationSuppressCurrentProject: nextAudibleNotificationSuppressCurrentProject,
	});
	if (projectConfigPath !== null) {
		await writeRuntimeProjectConfigFile(projectConfigPath, {
			shortcuts: nextShortcuts,
		});
	}
	if (pinnedBranchesChanged && workspaceId !== null) {
		await writePinnedBranchesFile(workspaceId, nextPinnedBranches);
	}
	return createRuntimeConfigStateFromValues({
		...mergedFields,
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: nextSelectedAgentId,
		selectedShortcutLabel: nextSelectedShortcutLabel,
		audibleNotificationEvents: nextAudibleNotificationEvents,
		audibleNotificationSuppressCurrentProject: nextAudibleNotificationSuppressCurrentProject,
		shortcuts: nextShortcuts,
		pinnedBranches: nextPinnedBranches,
		promptShortcuts: nextPromptShortcuts,
		hiddenDefaultPromptShortcuts: nextHiddenDefaults,
	});
}

export async function updateRuntimeConfig(
	cwd: string,
	workspaceId: string | null,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd, workspaceId), async () => {
		const current = await loadRuntimeConfigLocked(cwd, workspaceId);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return applyConfigUpdates({ globalConfigPath, projectConfigPath, workspaceId, current, updates });
	});
}

export async function updateGlobalRuntimeConfig(
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks([{ path: globalConfigPath, type: "file" }], async () => {
		const result = await applyConfigUpdates({
			globalConfigPath,
			projectConfigPath: null,
			workspaceId: null,
			current,
			updates,
		});
		if (result === current) {
			return current;
		}
		return { ...result, projectConfigPath: current.projectConfigPath };
	});
}
