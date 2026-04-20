import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function selectNewestTaskSessionSummary(
	left: RuntimeTaskSessionSummary | null,
	right: RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	return left.updatedAt > right.updatedAt ? left : right;
}

export function mergeTaskSessionSummaryMap(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	incomingSessions: Iterable<RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	const nextSessions = { ...currentSessions };
	for (const summary of incomingSessions) {
		const newest = selectNewestTaskSessionSummary(nextSessions[summary.taskId] ?? null, summary);
		if (newest) {
			nextSessions[summary.taskId] = newest;
		}
	}
	return nextSessions;
}

export function reconcileAuthoritativeTaskSessionSummaryMap(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	incomingSessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	const nextSessions: Record<string, RuntimeTaskSessionSummary> = {};
	for (const [taskId, summary] of Object.entries(incomingSessions)) {
		const newest = selectNewestTaskSessionSummary(currentSessions[taskId] ?? null, summary);
		if (newest) {
			nextSessions[taskId] = newest;
		}
	}
	return nextSessions;
}
