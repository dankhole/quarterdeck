/**
 * Pure domain logic for the settings form (type, initial values, equality).
 *
 * No React imports — types and functions here are plain TS. The companion
 * hook (`use-settings-form.ts`) handles React state and effects.
 */

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { areRuntimeProjectShortcutsEqual } from "@runtime-shortcuts";
import type { RuntimeConfigResponse, RuntimeConfigSaveRequest, RuntimeProjectShortcut } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Form values type — the set of fields managed by the save/dirty/reset cycle
// ---------------------------------------------------------------------------

export interface SettingsFormValues {
	shellAutoRestartEnabled: boolean;
	claudeLaunchPermissionMode: RuntimeConfigResponse["claudeLaunchPermissionMode"];
	codexApprovalsReviewer: RuntimeConfigResponse["codexApprovalsReviewer"];
	terminalFontWeight: number;
	fileEditorAutosaveMode: RuntimeConfigResponse["fileEditorAutosaveMode"];
	codeNavigationEnabled: boolean;
	showGeneratedWorktrees: boolean;
	groupBranchesByFolder: boolean;
	lspServers: RuntimeConfigResponse["lspServers"];
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: {
		permission: boolean;
		review: boolean;
		failure: boolean;
	};
	audibleNotificationsOnlyWhenHidden: boolean;
	audibleNotificationSuppressCurrentProject: {
		permission: boolean;
		review: boolean;
		failure: boolean;
	};
	worktreeSystemPromptTemplate: string;
	shortcuts: RuntimeProjectShortcut[];
	worktreeSetupScript: string;
	defaultUseWorktree: boolean;
}

export type SettingsSaveScope = "global" | "project";

/** Every main-form field declares its persistence scope, including future additions. */
const FIELD_SCOPES = {
	shellAutoRestartEnabled: "global",
	claudeLaunchPermissionMode: "global",
	codexApprovalsReviewer: "global",
	terminalFontWeight: "global",
	fileEditorAutosaveMode: "global",
	codeNavigationEnabled: "global",
	showGeneratedWorktrees: "global",
	groupBranchesByFolder: "global",
	lspServers: "global",
	audibleNotificationsEnabled: "global",
	audibleNotificationVolume: "global",
	audibleNotificationEvents: "global",
	audibleNotificationsOnlyWhenHidden: "global",
	audibleNotificationSuppressCurrentProject: "global",
	worktreeSystemPromptTemplate: "global",
	shortcuts: "project",
	worktreeSetupScript: "project",
	defaultUseWorktree: "project",
} as const satisfies Record<keyof SettingsFormValues, SettingsSaveScope>;

export function getChangedSettingsScopes(
	current: SettingsFormValues,
	initial: SettingsFormValues,
): SettingsSaveScope[] {
	const changed = new Set<SettingsSaveScope>();
	for (const key of Object.keys(FIELD_SCOPES) as Array<keyof SettingsFormValues>) {
		if (!areSettingsFieldValuesEqual(key, current, initial)) changed.add(FIELD_SCOPES[key]);
	}
	return (["global", "project"] as const).filter((scope) => changed.has(scope));
}

/** A global save must not carry project defaults without a project destination. */
export function buildSettingsSaveRequest(fields: SettingsFormValues, hasProject: boolean): RuntimeConfigSaveRequest {
	if (hasProject) return fields;
	const { shortcuts: _shortcuts, worktreeSetupScript: _setup, defaultUseWorktree: _workspace, ...global } = fields;
	return global;
}

// ---------------------------------------------------------------------------
// Initial values — the single place where config-to-form mapping lives
// ---------------------------------------------------------------------------

export function resolveInitialValues(config: RuntimeConfigResponse | null): SettingsFormValues {
	return {
		shellAutoRestartEnabled: config?.shellAutoRestartEnabled ?? CONFIG_DEFAULTS.shellAutoRestartEnabled,
		claudeLaunchPermissionMode: config?.claudeLaunchPermissionMode ?? CONFIG_DEFAULTS.claudeLaunchPermissionMode,
		codexApprovalsReviewer: config?.codexApprovalsReviewer ?? CONFIG_DEFAULTS.codexApprovalsReviewer,
		terminalFontWeight: config?.terminalFontWeight ?? CONFIG_DEFAULTS.terminalFontWeight,
		fileEditorAutosaveMode: config?.fileEditorAutosaveMode ?? CONFIG_DEFAULTS.fileEditorAutosaveMode,
		codeNavigationEnabled: config?.codeNavigationEnabled ?? CONFIG_DEFAULTS.codeNavigationEnabled,
		showGeneratedWorktrees: config?.showGeneratedWorktrees ?? CONFIG_DEFAULTS.showGeneratedWorktrees,
		groupBranchesByFolder: config?.groupBranchesByFolder ?? CONFIG_DEFAULTS.groupBranchesByFolder,
		lspServers: config?.lspServers ?? CONFIG_DEFAULTS.lspServers,
		audibleNotificationsEnabled: config?.audibleNotificationsEnabled ?? CONFIG_DEFAULTS.audibleNotificationsEnabled,
		audibleNotificationVolume: config?.audibleNotificationVolume ?? CONFIG_DEFAULTS.audibleNotificationVolume,
		audibleNotificationEvents: config?.audibleNotificationEvents ?? {
			...CONFIG_DEFAULTS.audibleNotificationEvents,
		},
		audibleNotificationsOnlyWhenHidden:
			config?.audibleNotificationsOnlyWhenHidden ?? CONFIG_DEFAULTS.audibleNotificationsOnlyWhenHidden,
		audibleNotificationSuppressCurrentProject: config?.audibleNotificationSuppressCurrentProject ?? {
			...CONFIG_DEFAULTS.audibleNotificationSuppressCurrentProject,
		},
		worktreeSystemPromptTemplate: config?.worktreeSystemPromptTemplate ?? "",
		shortcuts: config?.shortcuts ?? [],
		worktreeSetupScript: config?.worktreeSetupScript ?? CONFIG_DEFAULTS.worktreeSetupScript,
		defaultUseWorktree: config?.defaultUseWorktree ?? true,
	};
}

// ---------------------------------------------------------------------------
// Equality — shared by scope indicators, dirty checks, and server reconciliation
// ---------------------------------------------------------------------------

function areSettingsFieldValuesEqual(
	key: keyof SettingsFormValues,
	a: SettingsFormValues,
	b: SettingsFormValues,
): boolean {
	switch (key) {
		case "shortcuts":
			return areRuntimeProjectShortcutsEqual(a.shortcuts, b.shortcuts);
		case "lspServers":
			return JSON.stringify(a.lspServers) === JSON.stringify(b.lspServers);
		case "audibleNotificationEvents":
		case "audibleNotificationSuppressCurrentProject":
			return (
				a[key].permission === b[key].permission &&
				a[key].review === b[key].review &&
				a[key].failure === b[key].failure
			);
		default:
			return a[key] === b[key];
	}
}

/** Reconcile server changes while preserving fields edited in an open form. */
export function reconcileSettingsFormValues(
	current: SettingsFormValues,
	previous: SettingsFormValues,
	next: SettingsFormValues,
): SettingsFormValues {
	const result = { ...next };
	for (const key of Object.keys(current) as Array<keyof SettingsFormValues>) {
		if (!areSettingsFieldValuesEqual(key, current, previous)) {
			Object.assign(result, { [key]: current[key] });
		}
	}
	return result;
}
