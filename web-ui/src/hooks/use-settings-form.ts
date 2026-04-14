// Consolidated form-state management for the settings dialog.
//
// Adding a new config field that flows through the main Save button requires:
//   1. Add it to SettingsFormValues (type) and resolveInitialValues (mapping)
//   2. Add the JSX control in runtime-settings-dialog.tsx
//
// The dirty check, reset-on-open, and save payload are handled automatically.

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { areRuntimeProjectShortcutsEqual } from "@runtime-shortcuts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Form values type — the set of fields managed by the save/dirty/reset cycle
// ---------------------------------------------------------------------------

export interface SettingsFormValues {
	selectedAgentId: RuntimeAgentId;
	agentAutonomousModeEnabled: boolean;
	showSummaryOnCards: boolean;
	autoGenerateSummary: boolean;
	summaryStaleAfterSeconds: number;
	shellAutoRestartEnabled: boolean;
	terminalFontWeight: number;
	terminalWebGLRenderer: boolean;
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
		completion: boolean;
	};
	audibleNotificationsOnlyWhenHidden: boolean;
	audibleNotificationSuppressCurrentProject: {
		permission: boolean;
		review: boolean;
		failure: boolean;
		completion: boolean;
	};
	focusedTaskPollMs: number;
	backgroundTaskPollMs: number;
	homeRepoPollMs: number;
	worktreeAddParentGitDir: boolean;
	worktreeAddQuarterdeckDir: boolean;
	worktreeSystemPromptTemplate: string;
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
		agentAutonomousModeEnabled: config?.agentAutonomousModeEnabled ?? CONFIG_DEFAULTS.agentAutonomousModeEnabled,
		showSummaryOnCards: config?.showSummaryOnCards ?? CONFIG_DEFAULTS.showSummaryOnCards,
		autoGenerateSummary: config?.autoGenerateSummary ?? CONFIG_DEFAULTS.autoGenerateSummary,
		summaryStaleAfterSeconds: config?.summaryStaleAfterSeconds ?? CONFIG_DEFAULTS.summaryStaleAfterSeconds,
		shellAutoRestartEnabled: config?.shellAutoRestartEnabled ?? CONFIG_DEFAULTS.shellAutoRestartEnabled,
		terminalFontWeight: config?.terminalFontWeight ?? CONFIG_DEFAULTS.terminalFontWeight,
		terminalWebGLRenderer: config?.terminalWebGLRenderer ?? CONFIG_DEFAULTS.terminalWebGLRenderer,
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
		shortcuts: config?.shortcuts ?? [],
	};
}

// ---------------------------------------------------------------------------
// Equality — matches the prior hand-written dirty check exactly
// ---------------------------------------------------------------------------

function areFormValuesEqual(a: SettingsFormValues, b: SettingsFormValues): boolean {
	// Primitive fields — reference equality (object/array fields need a skip + custom check above)
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
	if (
		ae.permission !== be.permission ||
		ae.review !== be.review ||
		ae.failure !== be.failure ||
		ae.completion !== be.completion
	) {
		return false;
	}
	// Suppress current project — field-by-field
	const as = a.audibleNotificationSuppressCurrentProject;
	const bs = b.audibleNotificationSuppressCurrentProject;
	if (
		as.permission !== bs.permission ||
		as.review !== bs.review ||
		as.failure !== bs.failure ||
		as.completion !== bs.completion
	) {
		return false;
	}
	// Shortcuts — custom structural equality
	return areRuntimeProjectShortcutsEqual(a.shortcuts, b.shortcuts);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSettingsFormResult {
	/** Current form field values. */
	fields: SettingsFormValues;
	/** Type-safe setter for individual fields. */
	setField: <K extends keyof SettingsFormValues>(key: K, value: SettingsFormValues[K]) => void;
	/** Whether any field has been changed from its initial (server) value. */
	hasUnsavedChanges: boolean;
}

export function useSettingsForm(
	config: RuntimeConfigResponse | null,
	open: boolean,
	fallbackAgentId: RuntimeAgentId,
): UseSettingsFormResult {
	const [fields, setFields] = useState<SettingsFormValues>(() =>
		resolveInitialValues(null, CONFIG_DEFAULTS.selectedAgentId as RuntimeAgentId),
	);

	const setField = useCallback(<K extends keyof SettingsFormValues>(key: K, value: SettingsFormValues[K]) => {
		setFields((prev) => ({ ...prev, [key]: value }));
	}, []);

	// Compute initial values from loaded server config.
	// Recomputes when config identity changes (every poll), but the fingerprint
	// check below prevents unnecessary form resets.
	const initialValues = useMemo(() => resolveInitialValues(config, fallbackAgentId), [config, fallbackAgentId]);

	// Track what we last reset to, so we only reset when server values actually
	// change — not on every config identity change from polling.
	const lastResetFingerprintRef = useRef("");

	useEffect(() => {
		if (!open) {
			lastResetFingerprintRef.current = "";
			return;
		}
		const fingerprint = JSON.stringify(initialValues);
		if (fingerprint === lastResetFingerprintRef.current) return;
		lastResetFingerprintRef.current = fingerprint;
		setFields(initialValues);
	}, [open, initialValues]);

	const hasUnsavedChanges = useMemo(() => {
		if (!config) return false;
		return !areFormValuesEqual(fields, initialValues);
	}, [config, fields, initialValues]);

	return { fields, setField, hasUnsavedChanges };
}
