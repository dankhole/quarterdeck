// Public API for runtime config: load, save, update.
// Orchestrates normalizers (pure) and persistence (I/O).
import type { PromptShortcut, RuntimeAgentId, RuntimeProjectShortcut } from "../core";
import { lockedFileSystem } from "../fs";
import { detectInstalledCommands } from "./agent-registry";
import type { AudibleNotificationEvents, AudibleNotificationSuppressCurrentProject } from "./config-defaults";
import {
	extractGlobalConfigFields,
	type GlobalConfigFieldValues,
	hasGlobalConfigFieldChanges,
	mergeGlobalConfigFields,
} from "./global-config-fields";
import {
	createRuntimeConfigStateFromValues,
	normalizeAudibleNotificationEvents,
	normalizeAudibleNotificationSuppressCurrentProject,
	normalizeShortcuts,
	pickBestInstalledAgentIdFromDetected,
	type RuntimeConfigState,
	type RuntimeConfigUpdateInput,
	toRuntimeConfigState,
} from "./runtime-config-normalizers";
import {
	getRuntimeConfigLockRequests,
	getRuntimeGlobalConfigPath,
	readPinnedBranchesFile,
	readRuntimeConfigFiles,
	resolveRuntimeConfigPaths,
	writePinnedBranchesFile,
	writeRuntimeGlobalConfigFile,
	writeRuntimeProjectConfigFile,
} from "./runtime-config-persistence";
import { areRuntimeProjectShortcutsEqual } from "./shortcut-utils";

// --- Re-exports (preserves existing public API surface) ---

export type { AudibleNotificationEvents, AudibleNotificationSuppressCurrentProject } from "./config-defaults";
export { DEFAULT_PROMPT_SHORTCUTS } from "./config-defaults";
export type { RuntimeConfigState, RuntimeConfigUpdateInput } from "./runtime-config-normalizers";
export {
	DEFAULT_RUNTIME_CONFIG_STATE,
	normalizeHiddenDefaultPromptShortcuts,
	normalizePromptShortcuts,
	pickBestInstalledAgentIdFromDetected,
	toGlobalRuntimeConfigState,
} from "./runtime-config-normalizers";
export { getRuntimeGlobalConfigPath, getRuntimeProjectConfigPath } from "./runtime-config-persistence";

// --- Internal helpers ---

function pickBestInstalledAgentId() {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
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
	const currentFields = extractGlobalConfigFields(current);
	const mergedFields = mergeGlobalConfigFields(currentFields, updates);

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
		nextAudibleNotificationSuppressCurrentProject.permission !==
			current.audibleNotificationSuppressCurrentProject.permission ||
		nextAudibleNotificationSuppressCurrentProject.review !==
			current.audibleNotificationSuppressCurrentProject.review ||
		nextAudibleNotificationSuppressCurrentProject.failure !==
			current.audibleNotificationSuppressCurrentProject.failure ||
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

// --- Public API ---

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
