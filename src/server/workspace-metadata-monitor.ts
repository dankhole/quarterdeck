import pLimit from "p-limit";

import type { RuntimeBoardData, RuntimeWorkspaceMetadata } from "../core";
import { createGitProcessEnv } from "../core";
import { resolveBaseRefForBranch, runGit } from "../workspace";
import {
	areWorkspaceMetadataEqual,
	buildWorkspaceMetadataSnapshot,
	type CachedTaskWorkspaceMetadata,
	collectTrackedTasks,
	createEmptyWorkspaceMetadata,
	createWorkspaceEntry,
	loadHomeGitMetadata,
	loadTaskWorkspaceMetadata,
	type WorkspaceMetadataEntry,
} from "./workspace-metadata-loaders";

export type { WorkspaceMetadataPollIntervals } from "./workspace-metadata-loaders";

const GIT_PROBE_CONCURRENCY_LIMIT = 3;

/**
 * Interval (ms) between automatic `git fetch --all --prune` runs that keep
 * remote tracking refs up-to-date. Without periodic fetch, the ahead/behind
 * counts reported by `git status` are stale because the local tracking ref
 * (e.g. `origin/main`) only reflects the last fetch/pull/push.
 */
const REMOTE_FETCH_INTERVAL_MS = 60_000;

export interface CreateWorkspaceMetadataMonitorDependencies {
	onMetadataUpdated: (workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void;
	onTaskBaseRefChanged?: (workspaceId: string, taskId: string, newBaseRef: string) => void;
	getProjectDefaultBaseRef?: (workspaceId: string) => string;
}

export interface WorkspaceMetadataMonitor {
	connectWorkspace: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
		pollIntervals: { focusedTaskPollMs: number; backgroundTaskPollMs: number; homeRepoPollMs: number };
	}) => Promise<RuntimeWorkspaceMetadata>;
	updateWorkspaceState: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	setFocusedTask: (workspaceId: string, taskId: string | null) => void;
	requestTaskRefresh: (workspaceId: string, taskId: string) => void;
	requestHomeRefresh: (workspaceId: string) => void;
	setPollIntervals: (
		workspaceId: string,
		intervals: { focusedTaskPollMs: number; backgroundTaskPollMs: number; homeRepoPollMs: number },
	) => void;
	disconnectWorkspace: (workspaceId: string) => void;
	disposeWorkspace: (workspaceId: string) => void;
	close: () => void;
}

export function createWorkspaceMetadataMonitor(
	deps: CreateWorkspaceMetadataMonitorDependencies,
): WorkspaceMetadataMonitor {
	// TODO: In-flight guards are module-scoped, not per-workspace — a refresh in one workspace
	// blocks the same refresh type in another. Currently fine since the UI is single-tab, but:
	// 1. Add a user-facing limit to enforce single-tab (reject/redirect duplicate connections).
	// 2. Rename "workspace" to something clearer — it conflates the project directory, the
	//    runtime session, and the monitor entry, which makes multi-workspace reasoning confusing.
	const workspaces = new Map<string, WorkspaceMetadataEntry>();
	const taskProbeLimit = pLimit(GIT_PROBE_CONCURRENCY_LIMIT);
	let homeRefreshInFlight = false;
	let focusedRefreshInFlight = false;
	let backgroundRefreshInFlight = false;
	let remoteFetchInFlight = false;

	const stopAllTimers = (entry: WorkspaceMetadataEntry) => {
		if (entry.homeTimer) {
			clearInterval(entry.homeTimer);
			entry.homeTimer = null;
		}
		if (entry.focusedTaskTimer) {
			clearInterval(entry.focusedTaskTimer);
			entry.focusedTaskTimer = null;
		}
		if (entry.backgroundTaskTimer) {
			clearInterval(entry.backgroundTaskTimer);
			entry.backgroundTaskTimer = null;
		}
		if (entry.remoteFetchTimer) {
			clearInterval(entry.remoteFetchTimer);
			entry.remoteFetchTimer = null;
		}
	};

	const checkForBranchChanges = async (
		workspaceId: string,
		entry: WorkspaceMetadataEntry,
		taskId: string,
		previous: CachedTaskWorkspaceMetadata | null,
		next: CachedTaskWorkspaceMetadata,
	): Promise<void> => {
		if (!deps.onTaskBaseRefChanged) return;
		const prevBranch = previous?.lastKnownBranch ?? null;
		const newBranch = next.lastKnownBranch;
		if (!newBranch || newBranch === prevBranch || !next.data.exists) return;
		// First refresh for this task — skip, just establishing baseline
		if (prevBranch === null) return;

		const task = entry.trackedTasks.find((t) => t.taskId === taskId);
		if (!task) return;

		const projectDefault = deps.getProjectDefaultBaseRef?.(workspaceId) ?? "";
		const resolved = await resolveBaseRefForBranch(next.data.path, newBranch, projectDefault);
		if (resolved && resolved !== task.baseRef) {
			deps.onTaskBaseRefChanged(workspaceId, taskId, resolved);
		}
	};

	/**
	 * Run `git fetch --all --prune` to update remote tracking refs so that
	 * the ahead/behind counts from `git status` are accurate. After a
	 * successful fetch, triggers a home metadata refresh to pick up changes.
	 */
	const performRemoteFetch = async (workspaceId: string) => {
		if (remoteFetchInFlight) return;
		const entry = workspaces.get(workspaceId);
		if (!entry) return;
		remoteFetchInFlight = true;
		try {
			const result = await runGit(entry.workspacePath, ["fetch", "--all", "--prune"], {
				env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
			});
			if (result.ok) {
				// Invalidate the home stateToken so the next refreshHome picks up
				// the updated tracking refs instead of short-circuiting.
				entry.homeGit.stateToken = null;
				await refreshHome(workspaceId);
				// Also refresh the focused task so behind-base indicators pick up
				// the updated origin refs without waiting for the next poll cycle.
				void refreshFocusedTask(workspaceId);
			}
		} catch {
			// Network errors, auth failures — silently skip. Next cycle retries.
		} finally {
			remoteFetchInFlight = false;
		}
	};

	/** Notify subscribers if the snapshot changed after a partial or full refresh. */
	const broadcastIfChanged = (
		workspaceId: string,
		entry: WorkspaceMetadataEntry,
		previous: RuntimeWorkspaceMetadata,
	) => {
		const next = buildWorkspaceMetadataSnapshot(entry);
		if (!areWorkspaceMetadataEqual(previous, next)) {
			deps.onMetadataUpdated(workspaceId, next);
		}
	};

	/** Refresh only the home repo metadata. Skips if a previous home refresh is still in flight. */
	const refreshHome = async (workspaceId: string) => {
		if (homeRefreshInFlight) {
			return;
		}
		const entry = workspaces.get(workspaceId);
		if (!entry) {
			return;
		}
		homeRefreshInFlight = true;
		try {
			const previous = buildWorkspaceMetadataSnapshot(entry);
			entry.homeGit = await loadHomeGitMetadata(entry);
			broadcastIfChanged(workspaceId, entry, previous);
		} finally {
			homeRefreshInFlight = false;
		}
	};

	/** Refresh the focused task. Has its own in-flight guard so it is never starved by background refreshes. */
	const refreshFocusedTask = async (workspaceId: string) => {
		if (focusedRefreshInFlight) return;
		const entry = workspaces.get(workspaceId);
		if (!entry?.focusedTaskId) return;
		const task = entry.trackedTasks.find((t) => t.taskId === entry.focusedTaskId);
		if (!task) return;
		focusedRefreshInFlight = true;
		try {
			const previous = buildWorkspaceMetadataSnapshot(entry);
			const previousCached = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
			const next = await taskProbeLimit(async () => {
				return await loadTaskWorkspaceMetadata(entry.workspacePath, task, previousCached);
			});
			if (next) {
				entry.taskMetadataByTaskId.set(task.taskId, next);
				void checkForBranchChanges(workspaceId, entry, task.taskId, previousCached, next);
			}
			broadcastIfChanged(workspaceId, entry, previous);
		} finally {
			focusedRefreshInFlight = false;
		}
	};

	/** Refresh non-focused tasks. Skips if a previous background refresh is still in flight. */
	const refreshBackgroundTasks = async (workspaceId: string) => {
		if (backgroundRefreshInFlight) return;
		const entry = workspaces.get(workspaceId);
		if (!entry) return;
		const tasksToRefresh = entry.trackedTasks.filter((t) => t.taskId !== entry.focusedTaskId);
		if (tasksToRefresh.length === 0) return;
		backgroundRefreshInFlight = true;
		try {
			const previous = buildWorkspaceMetadataSnapshot(entry);
			const results = await Promise.all(
				tasksToRefresh.map((task) =>
					taskProbeLimit(async () => {
						const previousCached = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
						const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, previousCached);
						return next ? ([task.taskId, next, previousCached] as const) : null;
					}),
				),
			);
			for (const result of results) {
				if (result) {
					void checkForBranchChanges(workspaceId, entry, result[0], result[2], result[1]);
					entry.taskMetadataByTaskId.set(result[0], result[1]);
				}
			}
			broadcastIfChanged(workspaceId, entry, previous);
		} finally {
			backgroundRefreshInFlight = false;
		}
	};

	/** Full refresh — home + all tasks. Used on initial connect and state updates. */
	const refreshWorkspace = async (workspaceId: string): Promise<RuntimeWorkspaceMetadata> => {
		const entry = workspaces.get(workspaceId);
		if (!entry) {
			return createEmptyWorkspaceMetadata();
		}
		if (entry.refreshPromise) {
			return await entry.refreshPromise;
		}

		entry.refreshPromise = (async () => {
			const previousSnapshot = buildWorkspaceMetadataSnapshot(entry);
			entry.homeGit = await loadHomeGitMetadata(entry);

			const nextTaskEntries = await Promise.all(
				entry.trackedTasks.map((task) =>
					taskProbeLimit(async () => {
						const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
						const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current);
						return next ? [task.taskId, next] : null;
					}),
				),
			);

			entry.taskMetadataByTaskId = new Map(
				nextTaskEntries.filter(
					(candidate): candidate is [string, CachedTaskWorkspaceMetadata] => candidate !== null,
				),
			);

			const nextSnapshot = buildWorkspaceMetadataSnapshot(entry);
			if (!areWorkspaceMetadataEqual(previousSnapshot, nextSnapshot)) {
				deps.onMetadataUpdated(workspaceId, nextSnapshot);
			}
			return nextSnapshot;
		})().finally(() => {
			const current = workspaces.get(workspaceId);
			if (current) {
				current.refreshPromise = null;
			}
		});

		return await entry.refreshPromise;
	};

	const updateWorkspaceEntry = (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}): WorkspaceMetadataEntry => {
		const existing = workspaces.get(input.workspaceId) ?? createWorkspaceEntry(input.workspacePath);
		existing.workspacePath = input.workspacePath;
		existing.trackedTasks = collectTrackedTasks(input.board);
		workspaces.set(input.workspaceId, existing);
		return existing;
	};

	const startTimers = (workspaceId: string, entry: WorkspaceMetadataEntry) => {
		stopAllTimers(entry);

		const homeTimer = setInterval(() => {
			void refreshHome(workspaceId);
		}, entry.pollIntervals.homeRepoPollMs);
		homeTimer.unref();
		entry.homeTimer = homeTimer;

		const focusedTimer = setInterval(() => {
			void refreshFocusedTask(workspaceId);
		}, entry.pollIntervals.focusedTaskPollMs);
		focusedTimer.unref();
		entry.focusedTaskTimer = focusedTimer;

		const backgroundTimer = setInterval(() => {
			void refreshBackgroundTasks(workspaceId);
		}, entry.pollIntervals.backgroundTaskPollMs);
		backgroundTimer.unref();
		entry.backgroundTaskTimer = backgroundTimer;

		const fetchTimer = setInterval(() => {
			void performRemoteFetch(workspaceId);
		}, REMOTE_FETCH_INTERVAL_MS);
		fetchTimer.unref();
		entry.remoteFetchTimer = fetchTimer;
	};

	return {
		connectWorkspace: async ({ workspaceId, workspacePath, board, pollIntervals }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			entry.subscriberCount += 1;
			entry.pollIntervals = pollIntervals;
			startTimers(workspaceId, entry);
			// Fire a background fetch so remote tracking refs are fresh from the start.
			// Don't await — the initial snapshot uses local state, fetch results arrive
			// on the next poll cycle (or sooner via the refreshHome inside performRemoteFetch).
			void performRemoteFetch(workspaceId);
			return await refreshWorkspace(workspaceId);
		},
		updateWorkspaceState: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			if (entry.subscriberCount === 0) {
				return buildWorkspaceMetadataSnapshot(entry);
			}
			return await refreshWorkspace(workspaceId);
		},
		setFocusedTask: (workspaceId, taskId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			if (entry.focusedTaskId === taskId) {
				return;
			}
			entry.focusedTaskId = taskId;
			// Immediate probe so the UI shows fresh data when the user selects a task.
			if (taskId) {
				void refreshFocusedTask(workspaceId);
			}
		},
		requestTaskRefresh: (workspaceId, taskId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) return;
			const task = entry.trackedTasks.find((t) => t.taskId === taskId);
			if (!task) return;
			// Invalidate the cached stateToken so the refresh detects the change.
			// Note: if a focused refresh is already in flight, it may have already read the
			// old cached entry and will overwrite this null when it finishes — the invalidation
			// is effectively deferred to the next poll cycle. Acceptable for imperative refreshes
			// triggered by checkout/merge since the next focused poll is fast (seconds).
			const cached = entry.taskMetadataByTaskId.get(taskId);
			if (cached) {
				entry.taskMetadataByTaskId.set(taskId, { ...cached, stateToken: null });
			}
			if (taskId === entry.focusedTaskId) {
				void refreshFocusedTask(workspaceId);
			} else {
				void taskProbeLimit(async () => {
					const previous = buildWorkspaceMetadataSnapshot(entry);
					const current = entry.taskMetadataByTaskId.get(taskId) ?? null;
					const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current);
					if (next) {
						entry.taskMetadataByTaskId.set(taskId, next);
					}
					broadcastIfChanged(workspaceId, entry, previous);
				});
			}
		},
		requestHomeRefresh: (workspaceId) => {
			void refreshHome(workspaceId);
		},
		setPollIntervals: (workspaceId, intervals) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			const changed =
				entry.pollIntervals.focusedTaskPollMs !== intervals.focusedTaskPollMs ||
				entry.pollIntervals.backgroundTaskPollMs !== intervals.backgroundTaskPollMs ||
				entry.pollIntervals.homeRepoPollMs !== intervals.homeRepoPollMs;
			if (!changed) {
				return;
			}
			entry.pollIntervals = intervals;
			if (entry.subscriberCount > 0) {
				startTimers(workspaceId, entry);
			}
		},
		disconnectWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			entry.subscriberCount = Math.max(0, entry.subscriberCount - 1);
			if (entry.subscriberCount > 0) {
				return;
			}
			stopAllTimers(entry);
			workspaces.delete(workspaceId);
		},
		disposeWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			stopAllTimers(entry);
			workspaces.delete(workspaceId);
		},
		close: () => {
			for (const entry of workspaces.values()) {
				stopAllTimers(entry);
			}
			workspaces.clear();
		},
	};
}
