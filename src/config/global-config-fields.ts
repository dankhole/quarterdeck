// Single source of truth for global config field definitions.
// Adding a new simple field here automatically propagates through
// normalization, serialization, merge, and dirty-check logic.
//
// To add a new boolean setting:
//   1. Add it to GLOBAL_CONFIG_FIELDS below (1 line)
//   2. Add z.boolean() to runtimeConfigResponseSchema in api-contract.ts
//   3. Add z.boolean().optional() to runtimeConfigSaveRequestSchema in api-contract.ts
//   4. Add the UI toggle in runtime-settings-dialog.tsx
//   5. Consume in App.tsx or wherever needed
//
// Steps 1-3 are mechanical. Steps 4-5 are presentation/business logic.

const MIN_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 60_000;

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

export function normalizeVolume(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.min(1, value));
	}
	return fallback;
}

export function normalizePollInterval(value: unknown, fallback: number): number {
	const normalized = normalizeNumber(value, fallback);
	return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, Math.round(normalized)));
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

function pollField(defaultValue: number): ConfigField<number> {
	return { defaultValue, normalize: normalizePollInterval };
}

// --- Field registry ---
// Every field here gets automatic normalize/merge/serialize/dirty-check support.
// Fields NOT in this registry (selectedAgentId, selectedShortcutLabel,
// audibleNotificationEvents, promptShortcuts, commitPromptTemplate,
// openPrPromptTemplate) have custom logic and are handled explicitly
// in runtime-config.ts.

export const GLOBAL_CONFIG_FIELDS = {
	agentAutonomousModeEnabled: boolField(false),
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
	audibleNotificationsEnabled: boolField(true),
	audibleNotificationVolume: volumeField(0.7),
	audibleNotificationsOnlyWhenHidden: boolField(true),
	focusedTaskPollMs: pollField(2_000),
	backgroundTaskPollMs: pollField(5_000),
	homeRepoPollMs: pollField(10_000),
	statuslineEnabled: boolField(true),
	terminalFontWeight: numField(325),
	terminalWebGLRenderer: boolField(true),
	terminalChatViewEnabled: boolField(false),
	worktreeAddParentRepoDir: boolField(true),
	worktreeAddQuarterdeckDir: boolField(false),
	showRunningTaskEmergencyActions: boolField(false),
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
