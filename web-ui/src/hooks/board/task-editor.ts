import type { TaskAutoReviewMode } from "@/types";

/**
 * Plan mode is incompatible with auto-review "move_to_trash" because
 * plan mode keeps the agent in a read-only planning state, which would
 * immediately trigger a review → trash cycle.
 */
export function isPlanModeDisabledByAutoReview(
	autoReviewEnabled: boolean,
	autoReviewMode: TaskAutoReviewMode,
): boolean {
	return autoReviewEnabled && autoReviewMode === "move_to_trash";
}

/**
 * Resolve the effective default branch ref for a new task, considering
 * config overrides and last-used-branch memory.
 */
export function resolveDefaultBranchRef(
	defaultTaskBranchRef: string,
	configOverridesDefault: boolean,
	lastCreatedTaskBranch: string | null,
	availableBranches: Array<{ value: string }>,
): string {
	if (configOverridesDefault) {
		return defaultTaskBranchRef;
	}
	if (lastCreatedTaskBranch && availableBranches.some((option) => option.value === lastCreatedTaskBranch)) {
		return lastCreatedTaskBranch;
	}
	return defaultTaskBranchRef;
}

/**
 * Check whether a branch ref value is still valid against the current
 * set of available branch options.
 */
export function isBranchRefValid(branchRef: string, availableBranches: Array<{ value: string }>): boolean {
	return availableBranches.some((option) => option.value === branchRef);
}

/**
 * Validate that the minimum requirements for creating/saving a task are met.
 */
export function isTaskSaveValid(prompt: string, branchRef: string, fallbackBranchRef: string): boolean {
	return prompt.trim().length > 0 && !!(branchRef || fallbackBranchRef);
}

/**
 * Resolve the effective base ref for a task, preferring the explicit value
 * and falling back to the resolved default.
 */
export function resolveEffectiveBaseRef(branchRef: string, fallbackBranchRef: string): string {
	return branchRef || fallbackBranchRef;
}
