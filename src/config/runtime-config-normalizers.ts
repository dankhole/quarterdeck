// Pure normalization functions and state assembly for runtime config.
// No file I/O — all functions are deterministic and side-effect free.

import type { PromptShortcut, RuntimeAgentId, RuntimeProjectShortcut } from "../core";
import { isRuntimeAgentLaunchSupported } from "../core";
import type { AudibleNotificationEvents, AudibleNotificationSuppressCurrentProject } from "./config-defaults";
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
	extractGlobalConfigFields,
	type GlobalConfigFieldValues,
	normalizeGlobalConfigFields,
} from "./global-config-fields";

// --- On-disk JSON shapes ---

interface AudibleNotificationEventsShape {
	permission?: boolean;
	review?: boolean;
	failure?: boolean;
}

export interface RuntimeGlobalConfigFileShape extends Partial<GlobalConfigFieldValues> {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	promptShortcuts?: Array<{ label: string; prompt: string }>;
	hiddenDefaultPromptShortcuts?: string[];
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	audibleNotificationSuppressCurrentProject?: AudibleNotificationEventsShape;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
	worktreeSystemPromptTemplate?: string;
}

export interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

// --- Resolved config state ---

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

// --- Partial update input ---

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

// --- Constants ---

export const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex"];

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

// --- Normalizers ---

export function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	if ((agentId === "claude" || agentId === "codex") && isRuntimeAgentLaunchSupported(agentId)) {
		return agentId;
	}
	return DEFAULT_AGENT_ID;
}

export function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

export function normalizeShortcut(shortcut: RuntimeProjectShortcut): RuntimeProjectShortcut | null {
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

export function normalizeShortcuts(shortcuts: RuntimeProjectShortcut[] | null | undefined): RuntimeProjectShortcut[] {
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

export function normalizePinnedBranches(value: unknown): string[] {
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

export function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

export function normalizeAudibleNotificationEvents(
	value: AudibleNotificationEventsShape | null | undefined,
): AudibleNotificationEvents {
	return {
		permission:
			typeof value?.permission === "boolean" ? value.permission : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.permission,
		review: typeof value?.review === "boolean" ? value.review : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.review,
		failure: typeof value?.failure === "boolean" ? value.failure : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.failure,
	};
}

export function normalizeAudibleNotificationSuppressCurrentProject(
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
	};
}

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

export function normalizePromptShortcuts(
	shortcuts: Array<{ label: string; prompt: string }> | null | undefined,
	hiddenDefaults?: string[] | null,
): PromptShortcut[] {
	const hidden = new Set(hiddenDefaults?.map((h) => h.trim().toLowerCase()) ?? []);

	if (!Array.isArray(shortcuts)) {
		return DEFAULT_PROMPT_SHORTCUTS.filter((d) => !hidden.has(d.label.trim().toLowerCase())).map((d) => ({ ...d }));
	}

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

	const userLabelSet = new Set(userShortcuts.map((s) => s.label.trim().toLowerCase()));

	const missingDefaults = DEFAULT_PROMPT_SHORTCUTS.filter((d) => {
		const key = d.label.trim().toLowerCase();
		return !hidden.has(key) && !userLabelSet.has(key);
	});

	const merged = [...userShortcuts, ...missingDefaults.map((d) => ({ ...d }))];
	if (merged.length > 0) return merged;
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

// --- State assembly ---

export function toRuntimeConfigState({
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

export function createRuntimeConfigStateFromValues(
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
