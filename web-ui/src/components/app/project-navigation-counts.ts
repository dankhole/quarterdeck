import type { RuntimeProjectTaskCounts } from "@/runtime/types";

export interface ProjectNavigationTaskCounts {
	backlog: number;
	inProgress: number;
	review: number;
	needsInput: number;
}

/**
 * Combines independent board-column and notification projections.
 *
 * Cards that need input remain physically in the Review board column, but the
 * navigation pills are mutually exclusive attention categories: Needs Input
 * overrides Review. The notification projection can lead the board snapshot,
 * so floor the derived Review count without hiding a newer Needs Input result
 * behind an older board-column total.
 */
export function resolveProjectNavigationTaskCounts(
	taskCounts: RuntimeProjectTaskCounts,
	requestedNeedsInputCount: number,
): ProjectNavigationTaskCounts {
	const needsInput = Math.max(0, requestedNeedsInputCount);
	return {
		backlog: taskCounts.backlog,
		inProgress: taskCounts.in_progress,
		review: Math.max(0, taskCounts.review - needsInput),
		needsInput,
	};
}
