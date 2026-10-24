import type { RuntimeProjectTaskCounts } from "@/runtime/types";

export interface ProjectNavigationTaskCounts {
	inProgress: number;
	review: number;
	needsInput: number;
	error: number;
}

/**
 * Combines independent board-column and notification projections.
 *
 * Cards that need input or have errors remain physically in the Review board
 * column, but navigation attention categories are mutually exclusive. Both
 * override Review. The notification projection can lead the board snapshot,
 * so floor Review without hiding newer Needs Input or Error results behind
 * an older board-column total.
 */
export function resolveProjectNavigationTaskCounts(
	taskCounts: RuntimeProjectTaskCounts,
	requestedNeedsInputCount: number,
	requestedErrorCount = 0,
): ProjectNavigationTaskCounts {
	const needsInput = Math.max(0, requestedNeedsInputCount);
	const error = Math.max(0, requestedErrorCount);
	return {
		inProgress: taskCounts.in_progress,
		review: Math.max(0, taskCounts.review - needsInput - error),
		needsInput,
		error,
	};
}
