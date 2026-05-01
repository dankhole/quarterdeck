/**
 * Pure domain logic for the settings form (type, initial values, equality).
 *
 * No React imports — types and functions here are plain TS. The companion
 * hook (`use-settings-form.ts`) handles React state and effects.
 */

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { areRuntimeProjectShortcutsEqual } from "@runtime-shortcuts";
import type { RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Form values type — the set of fields managed by the save/dirty/reset cycle
// ---------------------------------------------------------------------------

export interface SettingsFormValues {
	showSummaryOnCards: boolean;
	llmSummaryPolishEnabled: boolean;
	shellAutoRestartEnabled: boolean;
	terminalFontWeight: number;
	fileEditorAutosaveMode: RuntimeConfigResponse["fileEditorAutosaveMode"];
	showTrashWorktreeNotice: boolean;
	uncommittedChangesOnCardsEnabled: boolean;
	unmergedChangesIndicatorEnabled: boolean;
	behindBaseIndicatorEnabled: boolean;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
	skipCherryPickConfirmation: boolean;
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
	agentTerminalRowMultiplier: number;
	shortcuts: RuntimeProjectShortcut[];
}

// ---------------------------------------------------------------------------
// Initial values — the single place where config-to-form mapping lives
// ---------------------------------------------------------------------------

export function resolveInitialValues(config: RuntimeConfigResponse | null): SettingsFormValues {
	return {
		showSummaryOnCards: config?.showSummaryOnCards ?? CONFIG_DEFAULTS.showSummaryOnCards,
		llmSummaryPolishEnabled: config?.llmSummaryPolishEnabled ?? CONFIG_DEFAULTS.llmSummaryPolishEnabled,
		shellAutoRestartEnabled: config?.shellAutoRestartEnabled ?? CONFIG_DEFAULTS.shellAutoRestartEnabled,
		terminalFontWeight: config?.terminalFontWeight ?? CONFIG_DEFAULTS.terminalFontWeight,
		fileEditorAutosaveMode: config?.fileEditorAutosaveMode ?? CONFIG_DEFAULTS.fileEditorAutosaveMode,
		showTrashWorktreeNotice: config?.showTrashWorktreeNotice ?? CONFIG_DEFAULTS.showTrashWorktreeNotice,
		uncommittedChangesOnCardsEnabled:
			config?.uncommittedChangesOnCardsEnabled ?? CONFIG_DEFAULTS.uncommittedChangesOnCardsEnabled,
		unmergedChangesIndicatorEnabled:
			config?.unmergedChangesIndicatorEnabled ?? CONFIG_DEFAULTS.unmergedChangesIndicatorEnabled,
		behindBaseIndicatorEnabled: config?.behindBaseIndicatorEnabled ?? CONFIG_DEFAULTS.behindBaseIndicatorEnabled,
		skipTaskCheckoutConfirmation:
			config?.skipTaskCheckoutConfirmation ?? CONFIG_DEFAULTS.skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation:
			config?.skipHomeCheckoutConfirmation ?? CONFIG_DEFAULTS.skipHomeCheckoutConfirmation,
		skipCherryPickConfirmation: config?.skipCherryPickConfirmation ?? CONFIG_DEFAULTS.skipCherryPickConfirmation,
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
		agentTerminalRowMultiplier: config?.agentTerminalRowMultiplier ?? CONFIG_DEFAULTS.agentTerminalRowMultiplier,
		shortcuts: config?.shortcuts ?? [],
	};
}

// ---------------------------------------------------------------------------
// Equality — matches the prior hand-written dirty check exactly
// ---------------------------------------------------------------------------

export function areFormValuesEqual(a: SettingsFormValues, b: SettingsFormValues): boolean {
	// Primitive fields — reference equality (object/array fields need a skip + custom check)
	const objectKeys = new Set<keyof SettingsFormValues>([
		"audibleNotificationEvents",
		"audibleNotificationSuppressCurrentProject",
		"shortcuts",
	]);
	for (const key of Object.keys(a) as Array<keyof SettingsFormValues>) {
		if (objectKeys.has(key)) continue;
		if (a[key] !== b[key]) return false;
	}
	// Notification events — field-by-field
	const ae = a.audibleNotificationEvents;
	const be = b.audibleNotificationEvents;
	if (ae.permission !== be.permission || ae.review !== be.review || ae.failure !== be.failure) {
		return false;
	}
	// Suppress current project — field-by-field
	const as = a.audibleNotificationSuppressCurrentProject;
	const bs = b.audibleNotificationSuppressCurrentProject;
	if (as.permission !== bs.permission || as.review !== bs.review || as.failure !== bs.failure) {
		return false;
	}
	// Shortcuts — custom structural equality
	return areRuntimeProjectShortcutsEqual(a.shortcuts, b.shortcuts);
}
