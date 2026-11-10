// Consolidated form-state management for the settings dialog.
//
// Adding a new config field that flows through the main Save button requires:
//   1. Add it to SettingsFormValues, FIELD_SCOPES, and resolveInitialValues
//      in settings-form.ts (type, persistence scope, and initial value).
//   2. Add the control to the appropriate settings category section.
//
// The dirty check, reset-on-open, and save payload are handled automatically.
// Domain logic (types, initial values, equality) lives in `./settings-form.ts`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeConfigResponse } from "@/runtime/types";
import {
	getChangedSettingsScopes,
	reconcileSettingsFormValues,
	resolveInitialValues,
	type SettingsFormValues,
	type SettingsSaveScope,
} from "./settings-form";

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
	/** Persistence destinations changed anywhere in the form, including hidden pages. */
	changedScopes: SettingsSaveScope[];
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

	const previousInitialValuesRef = useRef<SettingsFormValues | null>(null);

	useEffect(() => {
		if (!open) {
			previousInitialValuesRef.current = null;
			return;
		}
		const previous = previousInitialValuesRef.current;
		previousInitialValuesRef.current = initialValues;
		setFields((current) =>
			previous ? reconcileSettingsFormValues(current, previous, initialValues) : initialValues,
		);
	}, [open, initialValues]);

	const changedScopes = useMemo(
		() => (config ? getChangedSettingsScopes(fields, initialValues) : []),
		[config, fields, initialValues],
	);

	return { fields, setField, hasUnsavedChanges: changedScopes.length > 0, changedScopes };
}
