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
import { detectInstalledCommands } from "../terminal/agent-registry";
import {
	DEFAULT_AGENT_ID,
	DEFAULT_AUDIBLE_NOTIFICATION_EVENTS,
	DEFAULT_COMMIT_PROMPT_TEMPLATE,
	DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	DEFAULT_PROMPT_SHORTCUTS,
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

// The on-disk JSON shape: all fields optional, registry fields plus special fields.
type RuntimeGlobalConfigFileShape = Partial<GlobalConfigFieldValues> & {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	promptShortcuts?: Array<{ label: string; prompt: string }>;
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
};

// The fully resolved config state: registry fields plus special fields plus metadata.
export interface RuntimeConfigState extends GlobalConfigFieldValues {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	audibleNotificationEvents: AudibleNotificationEvents;
	shortcuts: RuntimeProjectShortcut[];
	promptShortcuts: PromptShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
}

// Partial update input: registry fields plus special fields.
export interface RuntimeConfigUpdateInput extends Partial<GlobalConfigFieldValues> {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	shortcuts?: RuntimeProjectShortcut[];
	promptShortcuts?: PromptShortcut[];
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
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
	shortcuts: [],
	promptShortcuts: [],
	commitPromptTemplate: DEFAULT_COMMIT_PROMPT_TEMPLATE,
	openPrPromptTemplate: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
	openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
};

export { DEFAULT_PROMPT_SHORTCUTS } from "./config-defaults";

export function normalizePromptShortcuts(
	shortcuts: Array<{ label: string; prompt: string }> | null | undefined,
): PromptShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [...DEFAULT_PROMPT_SHORTCUTS];
	}
	const normalized: PromptShortcut[] = [];
	for (const shortcut of shortcuts) {
		if (!shortcut || typeof shortcut !== "object") {
			continue;
		}
		const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
		const prompt = typeof shortcut.prompt === "string" ? shortcut.prompt.trim() : "";
		if (label && prompt) {
			normalized.push({ label, prompt });
		}
	}
	return normalized.length > 0 ? normalized : [...DEFAULT_PROMPT_SHORTCUTS];
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
	if (
		(agentId === "claude" || agentId === "codex" || agentId === "gemini" || agentId === "opencode") &&
		isRuntimeAgentLaunchSupported(agentId)
	) {
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

function getRuntimeConfigLockRequests(cwd: string | null): LockRequest[] {
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
	return requests;
}

/** Build a RuntimeConfigState from raw global + project config JSON. */
function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}): RuntimeConfigState {
	const fields = normalizeGlobalConfigFields(globalConfig as Record<string, unknown> | null);
	return {
		...fields,
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		audibleNotificationEvents: normalizeAudibleNotificationEvents(globalConfig?.audibleNotificationEvents),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		promptShortcuts: normalizePromptShortcuts(globalConfig?.promptShortcuts),
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
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

/** Write global config to disk, using sparse payload to keep config.json minimal. */
async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: Partial<GlobalConfigFieldValues> & {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		promptShortcuts?: PromptShortcut[];
		audibleNotificationEvents?: AudibleNotificationEventsShape;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
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
	await lockedFileSystem.writeJsonFileAtomic(
		configPath,
		{
			shortcuts: normalizedShortcuts,
		} satisfies RuntimeProjectConfigFileShape,
		{
			lock: null,
		},
	);
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

async function loadRuntimeConfigLocked(cwd: string | null): Promise<RuntimeConfigState> {
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
	return toRuntimeConfigState(configFiles);
}

/** Build RuntimeConfigState from already-resolved values. Re-normalizes for safety. */
function createRuntimeConfigStateFromValues(
	input: GlobalConfigFieldValues & {
		globalConfigPath: string;
		projectConfigPath: string | null;
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		audibleNotificationEvents: AudibleNotificationEvents;
		shortcuts: RuntimeProjectShortcut[];
		promptShortcuts: PromptShortcut[];
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
		shortcuts: normalizeShortcuts(input.shortcuts),
		promptShortcuts: normalizePromptShortcuts(input.promptShortcuts),
		commitPromptTemplate: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplate: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
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
		shortcuts: [],
		promptShortcuts: current.promptShortcuts,
	});
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(cwd),
		async () => await loadRuntimeConfigLocked(cwd),
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
	config: GlobalConfigFieldValues & {
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		audibleNotificationEvents: AudibleNotificationEvents;
		shortcuts: RuntimeProjectShortcut[];
		promptShortcuts: PromptShortcut[];
	},
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		const { shortcuts, ...globalFields } = config;
		await writeRuntimeGlobalConfigFile(globalConfigPath, globalFields);
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts });
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
	current,
	updates,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
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
	const nextAudibleNotificationEvents = updates.audibleNotificationEvents
		? normalizeAudibleNotificationEvents({
				...current.audibleNotificationEvents,
				...updates.audibleNotificationEvents,
			})
		: current.audibleNotificationEvents;
	const nextShortcuts = projectConfigPath ? (updates.shortcuts ?? current.shortcuts) : current.shortcuts;
	const nextPromptShortcuts = updates.promptShortcuts ?? current.promptShortcuts;

	// Check for any changes
	const hasChanges =
		hasGlobalConfigFieldChanges(currentFields, mergedFields) ||
		nextSelectedAgentId !== current.selectedAgentId ||
		nextSelectedShortcutLabel !== current.selectedShortcutLabel ||
		nextCommitPromptTemplate !== current.commitPromptTemplate ||
		nextOpenPrPromptTemplate !== current.openPrPromptTemplate ||
		JSON.stringify(nextPromptShortcuts) !== JSON.stringify(current.promptShortcuts) ||
		nextAudibleNotificationEvents.permission !== current.audibleNotificationEvents.permission ||
		nextAudibleNotificationEvents.review !== current.audibleNotificationEvents.review ||
		nextAudibleNotificationEvents.failure !== current.audibleNotificationEvents.failure ||
		nextAudibleNotificationEvents.completion !== current.audibleNotificationEvents.completion ||
		(projectConfigPath !== null && !areRuntimeProjectShortcutsEqual(nextShortcuts, current.shortcuts));

	if (!hasChanges) {
		return current;
	}

	await writeRuntimeGlobalConfigFile(globalConfigPath, {
		...mergedFields,
		selectedAgentId: nextSelectedAgentId,
		selectedShortcutLabel: nextSelectedShortcutLabel,
		promptShortcuts: nextPromptShortcuts,
		commitPromptTemplate: nextCommitPromptTemplate,
		openPrPromptTemplate: nextOpenPrPromptTemplate,
		audibleNotificationEvents: nextAudibleNotificationEvents,
	});
	if (projectConfigPath !== null) {
		await writeRuntimeProjectConfigFile(projectConfigPath, {
			shortcuts: nextShortcuts,
		});
	}
	return createRuntimeConfigStateFromValues({
		...mergedFields,
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: nextSelectedAgentId,
		selectedShortcutLabel: nextSelectedShortcutLabel,
		audibleNotificationEvents: nextAudibleNotificationEvents,
		shortcuts: nextShortcuts,
		promptShortcuts: nextPromptShortcuts,
	});
}

export async function updateRuntimeConfig(cwd: string, updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		const current = await loadRuntimeConfigLocked(cwd);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return applyConfigUpdates({ globalConfigPath, projectConfigPath, current, updates });
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
			current,
			updates,
		});
		if (result === current) {
			return current;
		}
		return { ...result, projectConfigPath: current.projectConfigPath };
	});
}
