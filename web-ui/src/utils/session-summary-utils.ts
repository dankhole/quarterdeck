import type { RuntimeTaskSessionSummary } from "@/runtime/types";

/**
 * Structural equality for two task session summaries that tie on `updatedAt`.
 * Summaries always cross a JSON serialization boundary (tRPC/WebSocket), so
 * two logically-unchanged entries are never reference-equal; comparing their
 * serialized shape is the cheapest reliable way to detect a true no-op and
 * keep the existing object identity stable for memoized card consumers.
 */
function areTiedTaskSessionSummariesEqual(left: RuntimeTaskSessionSummary, right: RuntimeTaskSessionSummary): boolean {
	if (left === right) {
		return true;
	}
	return JSON.stringify(left) === JSON.stringify(right);
}

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
	if (left.updatedAt > right.updatedAt) {
		return left;
	}
	if (left.updatedAt < right.updatedAt) {
		return right;
	}
	// Same updatedAt: prefer the incoming summary (it may carry a correction),
	// unless it is a content-identical duplicate — then keep the existing
	// reference so unrelated callers (e.g. memoized board cards keyed off this
	// entry) don't see a spurious identity change on a no-op delta.
	return areTiedTaskSessionSummariesEqual(left, right) ? left : right;
}

export function mergeTaskSessionSummaryMap(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	incomingSessions: Iterable<RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	let nextSessions: Record<string, RuntimeTaskSessionSummary> | null = null;
	for (const summary of incomingSessions) {
		const current = (nextSessions ?? currentSessions)[summary.taskId] ?? null;
		const newest = selectNewestTaskSessionSummary(current, summary);
		if (newest && newest !== current) {
			if (!nextSessions) {
				nextSessions = { ...currentSessions };
			}
			nextSessions[summary.taskId] = newest;
		}
	}
	// No entry actually changed — keep the existing map identity so
	// consumers that gate re-renders on this reference (e.g. BoardContext)
	// don't treat a no-op delta as a change.
	return nextSessions ?? currentSessions;
}

export function reconcileAuthoritativeTaskSessionSummaryMap(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	incomingSessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	const nextSessions: Record<string, RuntimeTaskSessionSummary> = {};
	let changed = Object.keys(incomingSessions).length !== Object.keys(currentSessions).length;
	for (const [taskId, summary] of Object.entries(incomingSessions)) {
		const current = currentSessions[taskId] ?? null;
		const newest = selectNewestTaskSessionSummary(current, summary);
		if (newest) {
			nextSessions[taskId] = newest;
		}
		if (newest !== current) {
			changed = true;
		}
	}
	// Keep the existing map identity when the authoritative set reconfirms
	// exactly what's already displayed, so an authoritative re-sync of
	// unchanged tasks doesn't cascade into every board card re-rendering.
	return changed ? nextSessions : currentSessions;
}
