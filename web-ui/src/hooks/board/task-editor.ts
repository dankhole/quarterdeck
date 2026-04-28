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
