// Single source of truth for global config field definitions.
// Adding a new simple field here automatically propagates through
// normalization, serialization, merge, and dirty-check logic.
//
// To add a new boolean setting:
//   1. Add it to GLOBAL_CONFIG_FIELDS below (1 line)
//   2. Add z.boolean() to runtimeConfigResponseSchema in api-contract.ts
//   3. Add z.boolean().optional() to runtimeConfigSaveRequestSchema in api-contract.ts
//   4. Add to SettingsFormValues type and resolveInitialValues() in
//      web-ui/src/hooks/use-settings-form.ts (the single mapping point)
//   5. Add the JSX control in runtime-settings-dialog.tsx
//   6. Consume in App.tsx or wherever needed
//   7. Add to test fixtures (runtime-config.test.ts, runtime-config-factory.ts)
//
// Steps 1-3 are mechanical. Steps 4-7 are presentation/business logic.
// The web-ui save types (runtime-config-query.ts, use-runtime-config.ts)
// import RuntimeConfigSaveRequest from the Zod schema — no manual sync needed.
// The dirty check, reset, and save payload are handled by useSettingsForm.

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// --- Normalize helpers (also used by special-case fields in runtime-config.ts) ---

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

export function normalizeNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	return fallback;
}

export function normalizeString(value: unknown, fallback: string): string {
	if (typeof value === "string") {
		return value.trim();
	}
	return fallback;
}

export function normalizeVolume(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.min(1, value));
	}
	return fallback;
}

// --- Field definition ---

interface ConfigField<T> {
	readonly defaultValue: T;
	readonly normalize: (value: unknown, fallback: T) => T;
}

function boolField(defaultValue: boolean): ConfigField<boolean> {
	return { defaultValue, normalize: normalizeBoolean };
}

function numField(defaultValue: number): ConfigField<number> {
	return { defaultValue, normalize: normalizeNumber };
}

function volumeField(defaultValue: number): ConfigField<number> {
	return { defaultValue, normalize: normalizeVolume };
}

function enumField<T extends string>(defaultValue: T, allowed: readonly T[]): ConfigField<T> {
	return {
		defaultValue,
		normalize: (value: unknown, fallback: T): T => {
			if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
				return value as T;
			}
			return fallback;
		},
	};
}

// --- Field registry ---
// Every field here gets automatic normalize/merge/serialize/dirty-check support.
// Fields NOT in this registry (selectedAgentId, selectedShortcutLabel,
// audibleNotificationEvents, promptShortcuts, commitPromptTemplate,
// openPrPromptTemplate) have custom logic and are handled explicitly
// in runtime-config.ts.

export const GLOBAL_CONFIG_FIELDS = {
	readyForReviewNotificationsEnabled: boolField(true),
	shellAutoRestartEnabled: boolField(true),
	showSummaryOnCards: boolField(false),
	autoGenerateSummary: boolField(false),
	summaryStaleAfterSeconds: numField(300),
	showTrashWorktreeNotice: boolField(true),
	uncommittedChangesOnCardsEnabled: boolField(true),
	unmergedChangesIndicatorEnabled: boolField(false),
	behindBaseIndicatorEnabled: boolField(true),
	skipTaskCheckoutConfirmation: boolField(false),
	skipHomeCheckoutConfirmation: boolField(false),
	skipCherryPickConfirmation: boolField(false),
	audibleNotificationsEnabled: boolField(true),
	audibleNotificationVolume: volumeField(0.7),
	audibleNotificationsOnlyWhenHidden: boolField(true),
	statuslineEnabled: boolField(true),
	terminalFontWeight: numField(325),
	worktreeAddParentGitDir: boolField(false),
	worktreeAddQuarterdeckDir: boolField(false),
	logLevel: enumField<LogLevel>("warn", LOG_LEVELS),
	backupIntervalMinutes: numField(30),
	agentTerminalRowMultiplier: numField(5),
} as const;

// --- Derived types ---

type ExtractFieldType<F> = F extends ConfigField<infer T> ? T : never;

export type GlobalConfigFieldKey = keyof typeof GLOBAL_CONFIG_FIELDS;

/** Resolved values for all registry-managed fields. */
export type GlobalConfigFieldValues = {
	[K in GlobalConfigFieldKey]: ExtractFieldType<(typeof GLOBAL_CONFIG_FIELDS)[K]>;
};

// --- Generic helpers ---

const FIELD_ENTRIES = Object.entries(GLOBAL_CONFIG_FIELDS) as Array<[GlobalConfigFieldKey, ConfigField<unknown>]>;
const FIELD_KEYS = Object.keys(GLOBAL_CONFIG_FIELDS) as GlobalConfigFieldKey[];

/** Default values for all registry fields. */
export function getGlobalConfigDefaults(): GlobalConfigFieldValues {
	const defaults = {} as Record<string, unknown>;
	for (const [key, def] of FIELD_ENTRIES) {
		defaults[key] = def.defaultValue;
	}
	return defaults as GlobalConfigFieldValues;
}

/** Normalize all registry fields from a raw object. Missing/invalid → default. */
export function normalizeGlobalConfigFields(raw: Record<string, unknown> | null | undefined): GlobalConfigFieldValues {
	const result = {} as Record<string, unknown>;
	for (const [key, def] of FIELD_ENTRIES) {
		const value = raw?.[key];
		result[key] = value === undefined ? def.defaultValue : def.normalize(value, def.defaultValue);
	}
	return result as GlobalConfigFieldValues;
}

/** Merge updates into current (nullish coalescing for registry fields). */
export function mergeGlobalConfigFields(
	current: GlobalConfigFieldValues,
	updates: Partial<GlobalConfigFieldValues>,
): GlobalConfigFieldValues {
	const result = { ...current };
	for (const key of FIELD_KEYS) {
		if (updates[key] !== undefined) {
			(result as Record<string, unknown>)[key] = updates[key];
		}
	}
	return result;
}

/** Check if any registry field differs between two configs. */
export function hasGlobalConfigFieldChanges(a: GlobalConfigFieldValues, b: GlobalConfigFieldValues): boolean {
	for (const key of FIELD_KEYS) {
		if (a[key] !== b[key]) {
			return true;
		}
	}
	return false;
}

/**
 * Build sparse payload for writing to config.json.
 * Only includes fields that differ from defaults or were already in the existing file.
 * This keeps config.json minimal — fields at their default aren't persisted unless
 * the user previously set them (preserving explicit intent).
 */
export function buildSparseGlobalConfigPayload(
	resolved: GlobalConfigFieldValues,
	existing: Record<string, unknown> | null,
): Partial<GlobalConfigFieldValues> {
	const payload = {} as Record<string, unknown>;
	for (const [key, def] of FIELD_ENTRIES) {
		const resolvedValue = (resolved as Record<string, unknown>)[key];
		if ((existing !== null && Object.hasOwn(existing, key)) || resolvedValue !== def.defaultValue) {
			payload[key] = resolvedValue;
		}
	}
	return payload as Partial<GlobalConfigFieldValues>;
}

/** Pick only registry field values from a larger object. */
export function extractGlobalConfigFields(source: GlobalConfigFieldValues): GlobalConfigFieldValues {
	const result = {} as Record<string, unknown>;
	for (const key of FIELD_KEYS) {
		result[key] = (source as Record<string, unknown>)[key];
	}
	return result as GlobalConfigFieldValues;
}
