/**
 * Pure domain logic for project navigation and error parsing.
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-project-navigation.ts`) handles
 * React state, effects, and tRPC mutations.
 */

import type { RuntimeProjectDirectoryPickerResponse } from "@runtime-contract";

const REMOVED_PROJECT_ERROR_PREFIX = "Project no longer exists on disk and was removed:";

export type ProjectDirectoryPickerDecision =
	| { kind: "selected"; path: string }
	| { kind: "cancelled" }
	| { kind: "manual_path" }
	| { kind: "failed"; message: string };

export function resolveProjectDirectoryPickerDecision(
	response: RuntimeProjectDirectoryPickerResponse,
): ProjectDirectoryPickerDecision {
	if (response.ok) {
		return { kind: "selected", path: response.path };
	}
	if (response.reason === "cancelled") {
		return { kind: "cancelled" };
	}
	if (response.reason === "native_ui_unavailable" || response.reason === "launcher_unavailable") {
		return { kind: "manual_path" };
	}
	return { kind: "failed", message: response.error };
}

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
