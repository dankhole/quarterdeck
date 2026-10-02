import {
	type ConversationProgressCursor,
	type ConversationSourceHint,
	type ConversationSourceHintReader,
	createConversationProgressCursor,
} from "../conversation";
import { deriveTaskIndicatorState, type RuntimeTaskSessionSummary } from "../core";
import type { SessionSummaryStore } from "../terminal";

export const PROGRESS_PREVIEW_INTERVAL_MS = 1_000;
const MAX_ACTIVE_PREVIEWS = 128;
const MAX_RETAINED_CURSORS = 1_024;

interface PreviewTarget {
	projectId: string;
	taskId: string;
	store: WeakRef<SessionSummaryStore>;
	identity: string;
	since: number;
	hintIdentity: string;
	cursor: ConversationProgressCursor;
}

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

/** Presentation delivery follows admitted native Running; transcript content never authors lifecycle. */
export function createTaskProgressPreview(deps: {
	hints: ConversationSourceHintReader;
	isCurrentStore: (projectId: string, store: SessionSummaryStore) => boolean;
	createCursor?: (input: { hint: ConversationSourceHint; since: number }) => ConversationProgressCursor;
	now?: () => number;
}) {
	const targets = new WeakMap<SessionSummaryStore, Map<string, PreviewTarget>>();
	const epochs = new WeakMap<SessionSummaryStore, Map<string, { identity: string; since: number }>>();
	const retained = new Set<PreviewTarget>();
	const active = new Set<PreviewTarget>();
	let pending: Promise<void> | null = null;
	let timer: NodeJS.Timeout | null = null;
	let refreshRequested = false;
	let closed = false;
	const now = deps.now ?? Date.now;

	function retire(target: PreviewTarget): void {
		active.delete(target);
		target.cursor.pause();
		target.identity = "";
	}

	function discardObsoleteStores(): void {
		for (const target of retained) {
			const store = target.store.deref();
			if (store && deps.isCurrentStore(target.projectId, store)) continue;
			retire(target);
			retained.delete(target);
			if (store) {
				targets.get(store)?.delete(target.taskId);
				epochs.get(store)?.delete(target.taskId);
			}
		}
	}

	function current(target: PreviewTarget): { store: SessionSummaryStore; summary: RuntimeTaskSessionSummary } | null {
		const store = target.store.deref();
		if (closed || !active.has(target) || !store || !deps.isCurrentStore(target.projectId, store)) return null;
		const summary = store.getSummary(target.taskId);
		if (!summary || runningIdentity(summary) !== target.identity || !summary.resumeSessionId) return null;
		const hint = deps.hints.getHint(target.projectId, target.taskId, summary.resumeSessionId);
		return hint && JSON.stringify(hint) === target.hintIdentity ? { store, summary } : null;
	}

	function schedule(delay: number): void {
		if (closed || timer || !active.size) return;
		timer = setTimeout(() => {
			timer = null;
			void refresh();
		}, delay);
		timer.unref();
	}

	function refresh(): Promise<void> {
		if (closed) return Promise.resolve();
		discardObsoleteStores();
		if (pending) {
			refreshRequested = true;
			return pending;
		}
		if (timer) clearTimeout(timer);
		timer = null;
		let hasMore = false;
		pending = (async () => {
			// One bounded chunk per target per pass keeps a noisy task from starving others.
			for (const target of [...active]) {
				const observed = current(target);
				if (!observed) {
					retire(target);
					continue;
				}
				const identity = target.identity;
				try {
					const result = await target.cursor.read();
					const latest = current(target);
					if (!latest || latest.store !== observed.store || target.identity !== identity) continue;
					hasMore ||= result.hasMore;
					const { summary } = latest;
					if ((summary.progressMessage ?? null) !== result.text) {
						observed.store.update(target.taskId, { progressMessage: result.text });
					}
				} catch {
					// Optional previews fail closed without content logging or lifecycle effects.
				}
			}
		})().finally(() => {
			pending = null;
			const immediate = hasMore || refreshRequested;
			refreshRequested = false;
			schedule(immediate ? 0 : PROGRESS_PREVIEW_INTERVAL_MS);
		});
		return pending;
	}

	function observe(input: {
		projectId: string;
		taskId: string;
		store: SessionSummaryStore;
		previous: RuntimeTaskSessionSummary;
	}): void {
		if (closed) return;
		discardObsoleteStores();
		const { projectId, taskId, store, previous } = input;
		const tasks = targets.get(store) ?? new Map<string, PreviewTarget>();
		targets.set(store, tasks);
		const summary = store.getSummary(taskId);
		const identity = summary && runningIdentity(summary);
		let target = tasks.get(taskId);
		const taskEpochs = epochs.get(store) ?? new Map<string, { identity: string; since: number }>();
		epochs.set(store, taskEpochs);
		if (!summary || !identity || !deps.isCurrentStore(projectId, store)) {
			if (target) retire(target);
			taskEpochs.delete(taskId);
			return;
		}
		let epoch = taskEpochs.get(taskId);
		if (!epoch || epoch.identity !== identity || runningIdentity(previous) !== identity) {
			epoch = { identity, since: now() };
			taskEpochs.set(taskId, epoch);
			if (target) retire(target);
			if (summary.progressMessage) store.update(taskId, { progressMessage: null });
		}
		while (taskEpochs.size > MAX_RETAINED_CURSORS) {
			const oldest = taskEpochs.keys().next().value;
			if (oldest) taskEpochs.delete(oldest);
		}
		if ((summary.agentId !== "codex" && summary.agentId !== "claude") || !summary.resumeSessionId) return;
		const hint = deps.hints.getHint(projectId, taskId, summary.resumeSessionId);
		if (!hint || hint.providerId !== summary.agentId) return;
		const hintIdentity = JSON.stringify(hint);
		if ((!target || !active.has(target)) && active.size >= MAX_ACTIVE_PREVIEWS) return;
		if (!target || target.hintIdentity !== hintIdentity) {
			if (target) {
				retire(target);
				retained.delete(target);
			}
			target = {
				projectId,
				taskId,
				store: new WeakRef(store),
				identity,
				since: epoch.since,
				hintIdentity,
				cursor: (deps.createCursor ?? createConversationProgressCursor)({ hint, since: epoch.since }),
			};
			tasks.set(taskId, target);
			retained.add(target);
		} else if (target.identity !== identity || target.since !== epoch.since) {
			target.cursor.beginEpoch(epoch.since);
			target.identity = identity;
			target.since = epoch.since;
		}
		active.add(target);
		while (retained.size > MAX_RETAINED_CURSORS) {
			const oldest = [...retained].find((candidate) => !active.has(candidate));
			if (!oldest) break;
			retained.delete(oldest);
			const store = oldest.store.deref();
			if (store) targets.get(store)?.delete(oldest.taskId);
		}
		void refresh();
	}

	return {
		observe,
		refresh,
		async close(): Promise<void> {
			closed = true;
			if (timer) clearTimeout(timer);
			timer = null;
			for (const target of active) target.cursor.pause();
			active.clear();
			retained.clear();
			await pending;
		},
	};
}
