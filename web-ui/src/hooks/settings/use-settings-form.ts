// Consolidated form-state management for the settings dialog.
//
// Adding a new config field that flows through the main Save button requires:
//   1. Add it to SettingsFormValues (type) and resolveInitialValues (mapping)
//   2. Add the JSX control in runtime-settings-dialog.tsx
//
// The dirty check, reset-on-open, and save payload are handled automatically.
// Domain logic (types, initial values, equality) lives in `./settings-form.ts`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { areFormValuesEqual, resolveInitialValues, type SettingsFormValues } from "./settings-form";

export type { SettingsFormValues } from "./settings-form";
export { resolveInitialValues } from "./settings-form";

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

export function useSettingsForm(config: RuntimeConfigResponse | null, open: boolean): UseSettingsFormResult {
	const [fields, setFields] = useState<SettingsFormValues>(() => resolveInitialValues(null));

	const setField = useCallback(<K extends keyof SettingsFormValues>(key: K, value: SettingsFormValues[K]) => {
		setFields((prev) => ({ ...prev, [key]: value }));
	}, []);

	// Compute initial values from loaded server config.
	// Recomputes when config identity changes (every poll), but the fingerprint
	// check below prevents unnecessary form resets.
	const initialValues = useMemo(() => resolveInitialValues(config), [config]);

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
