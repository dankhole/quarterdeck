// Public API for runtime config: load, save, update.
// Orchestrates normalizers (pure) and persistence (I/O).
import type { PromptShortcut, RuntimeAgentId, RuntimeProjectShortcut } from "../core";
import { lockedFileSystem } from "../fs";
import { detectRunnableAgentIds, getAgentAvailability } from "./agent-registry";
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
export {
	getLegacyProjectConfigPath,
	getRuntimeGlobalConfigPath,
	getRuntimeProjectConfigPath,
	migrateLegacyProjectConfig,
} from "./runtime-config-persistence";

// --- Internal helpers ---

function pickBestInstalledAgentId() {
	return pickBestInstalledAgentIdFromDetected(detectRunnableAgentIds());
}

function assertSelectedAgentRunnable(selectedAgentId: RuntimeAgentId): void {
	const availability = getAgentAvailability(selectedAgentId);
	if (!availability.installed) {
		throw new Error(availability.statusMessage ?? `Selected agent "${selectedAgentId}" is not runnable.`);
	}
}

async function loadRuntimeConfigLocked(projectId?: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(projectId ?? null);
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
	const pinnedBranches = projectId ? await readPinnedBranchesFile(projectId) : [];
	return toRuntimeConfigState({ ...configFiles, pinnedBranches });
}

async function applyConfigUpdates({
	globalConfigPath,
	projectConfigPath,
	projectId,
	current,
	updates,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	projectId: string | null;
	current: RuntimeConfigState;
	updates: RuntimeConfigUpdateInput;
}): Promise<RuntimeConfigState> {
	const currentFields = extractGlobalConfigFields(current);
	const mergedFields = mergeGlobalConfigFields(currentFields, updates);

	const nextSelectedAgentId = updates.selectedAgentId ?? current.selectedAgentId;
	if (updates.selectedAgentId !== undefined) {
		assertSelectedAgentRunnable(nextSelectedAgentId);
	}
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
	const nextPinnedBranches = projectId ? (updates.pinnedBranches ?? current.pinnedBranches) : current.pinnedBranches;
	const nextDefaultBaseRef = projectConfigPath
		? (updates.defaultBaseRef ?? current.defaultBaseRef)
		: current.defaultBaseRef;
	const nextPromptShortcuts = updates.promptShortcuts ?? current.promptShortcuts;
	const nextHiddenDefaults = updates.hiddenDefaultPromptShortcuts ?? current.hiddenDefaultPromptShortcuts;
	const pinnedBranchesChanged =
		projectId !== null && JSON.stringify(nextPinnedBranches) !== JSON.stringify(current.pinnedBranches);

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
		nextDefaultBaseRef !== current.defaultBaseRef ||
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
			defaultBaseRef: nextDefaultBaseRef,
		});
	}
	if (pinnedBranchesChanged && projectId !== null) {
		await writePinnedBranchesFile(projectId, nextPinnedBranches);
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
		defaultBaseRef: nextDefaultBaseRef,
		promptShortcuts: nextPromptShortcuts,
		hiddenDefaultPromptShortcuts: nextHiddenDefaults,
	});
}

// --- Public API ---

export async function loadRuntimeConfig(projectId?: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(projectId ?? null);
	if (configFiles.globalConfig !== null) {
		const pinnedBranches = projectId ? await readPinnedBranchesFile(projectId) : [];
		return toRuntimeConfigState({ ...configFiles, pinnedBranches });
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(projectId),
		async () => await loadRuntimeConfigLocked(projectId),
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
	projectId: string | null,
	config: GlobalConfigFieldValues & {
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		audibleNotificationEvents: AudibleNotificationEvents;
		audibleNotificationSuppressCurrentProject: AudibleNotificationSuppressCurrentProject;
		shortcuts: RuntimeProjectShortcut[];
		pinnedBranches: string[];
		defaultBaseRef: string;
		promptShortcuts: PromptShortcut[];
		hiddenDefaultPromptShortcuts: string[];
	},
): Promise<RuntimeConfigState> {
	// Runnability is guarded on the update path (`applyConfigUpdates`) and pre-checked
	// in the Settings dialog. `saveRuntimeConfig` is the low-level writer — do not
	// re-probe here: it would duplicate work and block persistence in edge cases
	// (e.g. shutdown writes, tests that seed configs directly) where the agent
	// availability state is intentionally stale.
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(projectId);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(projectId), async () => {
		const { shortcuts, pinnedBranches, defaultBaseRef, ...globalFields } = config;
		await writeRuntimeGlobalConfigFile(globalConfigPath, globalFields);
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts, defaultBaseRef });
		if (projectId) {
			await writePinnedBranchesFile(projectId, pinnedBranches);
		}
		return createRuntimeConfigStateFromValues({
			...config,
			globalConfigPath,
			projectConfigPath,
		});
	});
}

export async function updateRuntimeConfig(
	projectId: string | null,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(projectId);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(projectId), async () => {
		const current = await loadRuntimeConfigLocked(projectId);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return applyConfigUpdates({ globalConfigPath, projectConfigPath, projectId, current, updates });
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
			projectId: null,
			current,
			updates,
		});
		if (result === current) {
			return current;
		}
		return { ...result, projectConfigPath: current.projectConfigPath };
	});
}
