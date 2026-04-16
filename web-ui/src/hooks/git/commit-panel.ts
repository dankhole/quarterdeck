/**
 * Pure domain logic for the commit panel (file selection, validation).
 *
 * No React imports — functions here take explicit parameters and return
 * plain data. The companion hook (`use-commit-panel.ts`) handles React
 * state, effects, and tRPC mutations.
 */

import type { RuntimeWorkspaceFileChange } from "@/runtime/types";

// ---------------------------------------------------------------------------
// File selection sync
// ---------------------------------------------------------------------------

export interface SelectionSyncResult {
	/** Updated selection map after adding new files and removing departed ones. */
	selection: Map<string, boolean>;
	/** Whether the selection actually changed. */
	changed: boolean;
}

/**
 * Synchronize a selection map with the current file list. New files are
 * added as checked; departed files are removed. On first load (when
 * `prevPaths` is empty), all files are checked.
 */
export function computeSelectionSync(
	files: RuntimeWorkspaceFileChange[],
	prevPaths: Set<string>,
	currentSelection: Map<string, boolean>,
): SelectionSyncResult {
	const currentPaths = new Set(files.map((f) => f.path));

	const added = files.filter((f) => !prevPaths.has(f.path));
	const removed = [...prevPaths].filter((p) => !currentPaths.has(p));

	// First load — select all.
	if (prevPaths.size === 0 && files.length > 0) {
		return {
			selection: new Map(files.map((f) => [f.path, true])),
			changed: true,
		};
	}

	if (added.length === 0 && removed.length === 0) {
		return { selection: currentSelection, changed: false };
	}

	const next = new Map(currentSelection);
	for (const f of added) {
		next.set(f.path, true);
	}
	for (const p of removed) {
		next.delete(p);
	}
	return { selection: next, changed: true };
}

// ---------------------------------------------------------------------------
// Selected paths derivation
// ---------------------------------------------------------------------------

/**
 * Derive the list of selected file paths from the current files and
 * selection map.
 */
export function computeSelectedPaths(
	files: RuntimeWorkspaceFileChange[] | null,
	selection: Map<string, boolean>,
): string[] {
	if (!files) {
		return [];
	}
	return files.filter((f) => selection.get(f.path)).map((f) => f.path);
}

// ---------------------------------------------------------------------------
// Commit validation
// ---------------------------------------------------------------------------

/**
 * Check whether a commit can be performed (has selected files and a
 * non-empty message, and is not already committing).
 */
export function canPerformCommit(selectedPathCount: number, message: string, isCommitting: boolean): boolean {
	return selectedPathCount > 0 && message.trim().length > 0 && !isCommitting;
}

// ---------------------------------------------------------------------------
// Commit result formatting
// ---------------------------------------------------------------------------

/**
 * Build the success toast message for a commit result.
 */
export function formatCommitSuccessMessage(commitHash: string | null | undefined, pushed: boolean): string {
	const hashLabel = commitHash ? ` (${commitHash.slice(0, 7)})` : "";
	if (pushed) {
		return `Committed${hashLabel} and pushed`;
	}
	return `Committed${hashLabel}`;
}
