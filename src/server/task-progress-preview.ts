import type { ConversationReadService } from "../conversation";
import { deriveTaskIndicatorState, type RuntimeTaskSessionSummary } from "../core";
import type { SessionSummaryStore } from "../terminal";

export const PROGRESS_PREVIEW_INTERVAL_MS = 30_000;

type PreviewEpoch = { identity: string; since: number; nextReadAt: number };

function runningIdentity(summary: RuntimeTaskSessionSummary): string | null {
	if (deriveTaskIndicatorState(summary).publicStatus !== "running" || !summary.nativeWorkEvidence) return null;
	return JSON.stringify([
		summary.agentId,
		summary.sessionInstanceId,
		summary.resumeSessionId,
		summary.nativeWorkEvidence.turnId,
		summary.nativeWorkEvidence.promptId,
	]);
}

/** Optional presentation sampling. No timers, lifecycle mutations, retries, or queued reads. */
export function createTaskProgressPreview(deps: {
	reads: ConversationReadService;
	hasSource: (projectId: string, taskId: string, providerSessionId: string) => boolean;
	now?: () => number;
}) {
	const epochs = new WeakMap<SessionSummaryStore, Map<string, PreviewEpoch>>();
	let pending: Promise<void> | null = null;
	let closed = false;
	const now = deps.now ?? Date.now;

	function observe(input: {
		projectId: string;
		taskId: string;
		store: SessionSummaryStore;
		previous: RuntimeTaskSessionSummary;
	}): void {
		if (closed) return;
		const { projectId, taskId, store, previous } = input;
		const summary = store.getSummary(taskId);
		const identity = summary && runningIdentity(summary);
		const tasks = epochs.get(store) ?? new Map<string, PreviewEpoch>();
		epochs.set(store, tasks);
		if (!summary || !identity) {
			const previousEpoch = tasks.get(taskId);
			if (previousEpoch) tasks.set(taskId, { ...previousEpoch, identity: "" });
			return;
		}
		let epoch = tasks.get(taskId);
		if (!epoch || epoch.identity !== identity || runningIdentity(previous) !== identity) {
			epoch = { identity, since: now(), nextReadAt: epoch?.nextReadAt ?? 0 };
			tasks.set(taskId, epoch);
			const oldestTaskId = tasks.keys().next().value;
			if (tasks.size > 1024 && oldestTaskId) tasks.delete(oldestTaskId);
			if (summary.progressMessage) store.update(taskId, { progressMessage: null });
		}
		if (
			(summary.agentId !== "codex" && summary.agentId !== "claude") ||
			!summary.resumeSessionId ||
			!deps.hasSource(projectId, taskId, summary.resumeSessionId) ||
			now() < epoch.nextReadAt
		)
			return;
		// Busy tasks cannot create an unbounded queue or make other hooks wait.
		if (pending) return;
		epoch.nextReadAt = now() + PROGRESS_PREVIEW_INTERVAL_MS;
		const requestedEpoch = epoch;
		pending = (async () => {
			const result = await deps.reads.readRecent({ projectId, taskId, maxMessages: 1 });
			const current = store.getSummary(taskId);
			if (
				closed ||
				tasks.get(taskId) !== requestedEpoch ||
				!current ||
				runningIdentity(current) !== identity ||
				(result.status !== "available" && result.status !== "degraded")
			)
				return;
			const latest = result.entries.at(-1);
			if (
				latest?.type !== "message" ||
				latest.role !== "assistant" ||
				latest.recordedAt === undefined ||
				latest.recordedAt < requestedEpoch.since
			)
				return;
			const text = latest.text.trim().slice(0, 500);
			if (text && text !== current.progressMessage) store.update(taskId, { progressMessage: text });
		})()
			.catch(() => {
				// Unavailable previews keep the completed response; no retry or content logging.
			})
			.finally(() => {
				pending = null;
			});
	}

	return {
		observe,
		async close(): Promise<void> {
			closed = true;
			await pending;
		},
	};
}
