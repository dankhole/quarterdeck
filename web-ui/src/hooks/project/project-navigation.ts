/**
 * Pure domain logic for project navigation.
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-project-navigation.ts`) handles
 * React state, effects, and tRPC mutations.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REMOVED_PROJECT_ERROR_PREFIX = "Project no longer exists on disk and was removed:";

export const MANUAL_PROJECT_PATH_PROMPT_MESSAGE =
	"Quarterdeck could not open a directory picker on this runtime. Enter a project path to add:";

// ---------------------------------------------------------------------------
// Error parsing
// ---------------------------------------------------------------------------

/**
 * Extract the removed project path from a state-stream error message.
 * Returns `null` when the error is not a removed-project notification.
 */
export function parseRemovedProjectPathFromStreamError(streamError: string | null): string | null {
	if (!streamError?.startsWith(REMOVED_PROJECT_ERROR_PREFIX)) {
		return null;
	}
	return streamError.slice(REMOVED_PROJECT_ERROR_PREFIX.length).trim();
}

// ---------------------------------------------------------------------------
// Manual path prompt (browser-dependent utility)
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a manual project path via `window.prompt`.
 * Returns `null` when cancelled or empty.
 */
export function promptForManualProjectPath(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	const rawValue = window.prompt(MANUAL_PROJECT_PATH_PROMPT_MESSAGE);
	if (rawValue === null) {
		return null;
	}
	const normalized = rawValue.trim();
	return normalized || null;
}
