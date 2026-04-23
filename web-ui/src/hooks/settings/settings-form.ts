/**
 * Pure domain logic for the settings form (type, initial values, equality).
 *
 * No React imports — types and functions here are plain TS. The companion
 * hook (`use-settings-form.ts`) handles React state and effects.
 */

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { areRuntimeProjectShortcutsEqual } from "@runtime-shortcuts";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Form values type — the set of fields managed by the save/dirty/reset cycle
// ---------------------------------------------------------------------------

export interface SettingsFormValues {
	selectedAgentId: RuntimeAgentId;
	showSummaryOnCards: boolean;
	autoGenerateSummary: boolean;
	summaryStaleAfterSeconds: number;
	shellAutoRestartEnabled: boolean;
	terminalFontWeight: number;
	showTrashWorktreeNotice: boolean;
	uncommittedChangesOnCardsEnabled: boolean;
	unmergedChangesIndicatorEnabled: boolean;
	behindBaseIndicatorEnabled: boolean;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
	skipCherryPickConfirmation: boolean;
	showRunningTaskEmergencyActions: boolean;
	eventLogEnabled: boolean;
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
	focusedTaskPollMs: number;
	backgroundTaskPollMs: number;
	homeRepoPollMs: number;
	worktreeAddParentGitDir: boolean;
	worktreeAddQuarterdeckDir: boolean;
	worktreeSystemPromptTemplate: string;
	agentTerminalRowMultiplier: number;
	shortcuts: RuntimeProjectShortcut[];
}

// ---------------------------------------------------------------------------
// Initial values — the single place where config-to-form mapping lives
// ---------------------------------------------------------------------------

export function resolveInitialValues(
	config: RuntimeConfigResponse | null,
	fallbackAgentId: RuntimeAgentId,
): SettingsFormValues {
	return {
		selectedAgentId: config?.selectedAgentId ?? fallbackAgentId,
		showSummaryOnCards: config?.showSummaryOnCards ?? CONFIG_DEFAULTS.showSummaryOnCards,
		autoGenerateSummary: config?.autoGenerateSummary ?? CONFIG_DEFAULTS.autoGenerateSummary,
		summaryStaleAfterSeconds: config?.summaryStaleAfterSeconds ?? CONFIG_DEFAULTS.summaryStaleAfterSeconds,
		shellAutoRestartEnabled: config?.shellAutoRestartEnabled ?? CONFIG_DEFAULTS.shellAutoRestartEnabled,
		terminalFontWeight: config?.terminalFontWeight ?? CONFIG_DEFAULTS.terminalFontWeight,
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
		showRunningTaskEmergencyActions:
			config?.showRunningTaskEmergencyActions ?? CONFIG_DEFAULTS.showRunningTaskEmergencyActions,
		eventLogEnabled: config?.eventLogEnabled ?? CONFIG_DEFAULTS.eventLogEnabled,
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
		focusedTaskPollMs: config?.focusedTaskPollMs ?? CONFIG_DEFAULTS.focusedTaskPollMs,
		backgroundTaskPollMs: config?.backgroundTaskPollMs ?? CONFIG_DEFAULTS.backgroundTaskPollMs,
		homeRepoPollMs: config?.homeRepoPollMs ?? CONFIG_DEFAULTS.homeRepoPollMs,
		worktreeAddParentGitDir: config?.worktreeAddParentGitDir ?? CONFIG_DEFAULTS.worktreeAddParentGitDir,
		worktreeAddQuarterdeckDir: config?.worktreeAddQuarterdeckDir ?? CONFIG_DEFAULTS.worktreeAddQuarterdeckDir,
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
