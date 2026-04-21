// File I/O, path resolution, and locking for runtime config.
// Depends on normalizers for pure transformations.
import { readFile, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PromptShortcut, RuntimeAgentId, RuntimeProjectShortcut } from "../core";
import { type LockRequest, lockedFileSystem } from "../fs";
import { getProjectDirectoryPath, getProjectPinnedBranchesPath, getRuntimeHomePath } from "../state";
import type { AudibleNotificationEvents, AudibleNotificationSuppressCurrentProject } from "./config-defaults";
import {
	DEFAULT_AUDIBLE_NOTIFICATION_EVENTS,
	DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT,
	DEFAULT_COMMIT_PROMPT_TEMPLATE,
	DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE,
} from "./config-defaults";
import {
	buildSparseGlobalConfigPayload,
	type GlobalConfigFieldValues,
	normalizeGlobalConfigFields,
} from "./global-config-fields";
import {
	normalizeAgentId,
	normalizeAudibleNotificationEvents,
	normalizeAudibleNotificationSuppressCurrentProject,
	normalizePinnedBranches,
	normalizePromptTemplate,
	normalizeShortcutLabel,
	normalizeShortcuts,
	type RuntimeGlobalConfigFileShape,
	type RuntimeProjectConfigFileShape,
} from "./runtime-config-normalizers";

// --- Constants ---

const CONFIG_FILENAME = "config.json";

// --- Path resolution ---

interface RuntimeConfigPaths {
	globalConfigPath: string;
	projectConfigPath: string | null;
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), CONFIG_FILENAME);
}

/**
 * Legacy project config path inside the target repo. Used only for one-time
 * migration from the old `{repo}/.quarterdeck/config.json` location to the
 * state-home path.
 */
export function getLegacyProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), ".quarterdeck", CONFIG_FILENAME);
}

export function resolveRuntimeConfigPaths(projectId: string | null): RuntimeConfigPaths {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	if (projectId === null) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	return {
		globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(projectId),
	};
}

export function getRuntimeConfigLockRequests(projectId?: string | null): LockRequest[] {
	const paths = resolveRuntimeConfigPaths(projectId ?? null);
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
	if (projectId) {
		requests.push({
			path: getProjectPinnedBranchesPath(projectId),
			type: "file",
		});
	}
	return requests;
}

// --- File read/write ---

export async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export async function readPinnedBranchesFile(projectId: string): Promise<string[]> {
	try {
		const filePath = getProjectPinnedBranchesPath(projectId);
		const raw = await readFile(filePath, "utf8");
		return normalizePinnedBranches(JSON.parse(raw));
	} catch {
		return [];
	}
}

export async function writePinnedBranchesFile(projectId: string, pinnedBranches: string[]): Promise<void> {
	const normalized = normalizePinnedBranches(pinnedBranches);
	const filePath = getProjectPinnedBranchesPath(projectId);
	if (normalized.length === 0) {
		await rm(filePath, { force: true });
		return;
	}
	await lockedFileSystem.writeJsonFileAtomic(filePath, normalized, { lock: null });
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: Partial<GlobalConfigFieldValues> & {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		promptShortcuts?: PromptShortcut[];
		hiddenDefaultPromptShortcuts?: string[];
		audibleNotificationEvents?: Partial<AudibleNotificationEvents>;
		audibleNotificationSuppressCurrentProject?: Partial<AudibleNotificationSuppressCurrentProject>;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
		worktreeSystemPromptTemplate?: string;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<Record<string, unknown>>(configPath);

	const registryResolved = normalizeGlobalConfigFields(config as Record<string, unknown>);
	const payload: Record<string, unknown> = {
		...buildSparseGlobalConfigPayload(registryResolved, existing),
	};

	// selectedAgentId
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing as RuntimeGlobalConfigFileShape | null, "selectedAgentId")
		? normalizeAgentId((existing as RuntimeGlobalConfigFileShape | null)?.selectedAgentId)
		: undefined;
	if (selectedAgentId !== undefined) {
		if ((existing !== null && Object.hasOwn(existing, "selectedAgentId")) || selectedAgentId !== "claude") {
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

	// hiddenDefaultPromptShortcuts
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
		audibleNotificationEvents.failure !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.failure
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
			DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT.failure
	) {
		payload.audibleNotificationSuppressCurrentProject = audibleNotificationSuppressCurrentProject;
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

export async function writeRuntimeProjectConfigFile(
	configPath: string | null,
	config: { shortcuts: RuntimeProjectShortcut[]; defaultBaseRef?: string },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	const normalizedBaseRef = typeof config.defaultBaseRef === "string" ? config.defaultBaseRef.trim() : "";
	if (!configPath) {
		if (normalizedShortcuts.length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return;
	}
	if (normalizedShortcuts.length === 0 && !normalizedBaseRef) {
		await rm(configPath, { force: true });
		return;
	}
	const payload: RuntimeProjectConfigFileShape = {};
	if (normalizedShortcuts.length > 0) {
		payload.shortcuts = normalizedShortcuts;
	}
	if (normalizedBaseRef) {
		payload.defaultBaseRef = normalizedBaseRef;
	}
	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

// --- Legacy migration ---

/**
 * Migrate project config from the old `{repo}/.quarterdeck/config.json`
 * location to the state-home path (`~/.quarterdeck/projects/{id}/config.json`).
 * Runs once per project at startup. Cleans up the old file and directory after
 * a successful migration.
 */
export async function migrateLegacyProjectConfig(
	entries: Array<{ projectId: string; repoPath: string }>,
): Promise<number> {
	let migrated = 0;
	for (const { projectId, repoPath } of entries) {
		try {
			const newPath = getRuntimeProjectConfigPath(projectId);
			const existing = await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(newPath);
			if (existing !== null) {
				continue;
			}
			const legacyPath = getLegacyProjectConfigPath(repoPath);
			const legacy = await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(legacyPath);
			if (legacy === null) {
				continue;
			}
			await lockedFileSystem.writeJsonFileAtomic(newPath, legacy, { lock: null });
			await rm(legacyPath, { force: true });
			try {
				await rmdir(resolve(repoPath, ".quarterdeck"));
			} catch {
				// Directory not empty or already gone — fine.
			}
			migrated++;
		} catch {
			// Best-effort migration — skip failures.
		}
	}
	return migrated;
}

// --- Composite read helpers ---

export interface RuntimeConfigFiles {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}

export async function readRuntimeConfigFiles(projectId: string | null): Promise<RuntimeConfigFiles> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(projectId);
	return {
		globalConfigPath,
		projectConfigPath,
		globalConfig: await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath),
		projectConfig: projectConfigPath
			? await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath)
			: null,
	};
}
