import pLimit from "p-limit";

import type { RuntimeBoardData, RuntimeProjectMetadata } from "../core";
import { createGitProcessEnv } from "../core";
import { resolveBaseRefForBranch, runGit } from "../workdir";
import {
	areProjectMetadataEqual,
	buildProjectMetadataSnapshot,
	type CachedTaskWorktreeMetadata,
	collectTrackedTasks,
	createEmptyProjectMetadata,
	createProjectEntry,
	loadHomeGitMetadata,
	loadTaskWorktreeMetadata,
	type ProjectMetadataEntry,
} from "./project-metadata-loaders";

export type { ProjectMetadataPollIntervals } from "./project-metadata-loaders";

const GIT_PROBE_CONCURRENCY_LIMIT = 3;

/**
 * Interval (ms) between automatic `git fetch --all --prune` runs that keep
 * remote tracking refs up-to-date. Without periodic fetch, the ahead/behind
 * counts reported by `git status` are stale because the local tracking ref
 * (e.g. `origin/main`) only reflects the last fetch/pull/push.
 */
const REMOTE_FETCH_INTERVAL_MS = 60_000;

export interface CreateProjectMetadataMonitorDependencies {
	onMetadataUpdated: (projectId: string, metadata: RuntimeProjectMetadata) => void;
	onTaskBaseRefChanged?: (projectId: string, taskId: string, newBaseRef: string) => void;
	getProjectDefaultBaseRef?: (projectId: string) => string;
}

export interface ProjectMetadataMonitor {
	connectProject: (input: {
		projectId: string;
		projectPath: string;
		board: RuntimeBoardData;
		pollIntervals: { focusedTaskPollMs: number; backgroundTaskPollMs: number; homeRepoPollMs: number };
	}) => Promise<RuntimeProjectMetadata>;
	updateProjectState: (input: {
		projectId: string;
		projectPath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeProjectMetadata>;
	setFocusedTask: (projectId: string, taskId: string | null) => void;
	requestTaskRefresh: (projectId: string, taskId: string) => void;
	requestHomeRefresh: (projectId: string) => void;
	setPollIntervals: (
		projectId: string,
		intervals: { focusedTaskPollMs: number; backgroundTaskPollMs: number; homeRepoPollMs: number },
	) => void;
	disconnectProject: (projectId: string) => void;
	disposeProject: (projectId: string) => void;
	close: () => void;
}

export function createProjectMetadataMonitor(deps: CreateProjectMetadataMonitorDependencies): ProjectMetadataMonitor {
	// TODO: In-flight guards are module-scoped, not per-project — a refresh in one project
	// blocks the same refresh type in another. Currently fine since the UI is single-tab, but:
	// 1. Add a user-facing limit to enforce single-tab (reject/redirect duplicate connections).
	// 2. Rename "project" to something clearer — it conflates the project directory, the
	//    runtime session, and the monitor entry, which makes multi-project reasoning confusing.
	const projects = new Map<string, ProjectMetadataEntry>();
	const taskProbeLimit = pLimit(GIT_PROBE_CONCURRENCY_LIMIT);
	let homeRefreshInFlight = false;
	let focusedRefreshInFlight = false;
	let backgroundRefreshInFlight = false;
	let remoteFetchInFlight = false;

	const stopAllTimers = (entry: ProjectMetadataEntry) => {
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
		projectId: string,
		entry: ProjectMetadataEntry,
		taskId: string,
		previous: CachedTaskWorktreeMetadata | null,
		next: CachedTaskWorktreeMetadata,
	): Promise<void> => {
		if (!deps.onTaskBaseRefChanged) return;
		const prevBranch = previous?.lastKnownBranch ?? null;
		const newBranch = next.lastKnownBranch;
		if (!newBranch || newBranch === prevBranch || !next.data.exists) return;
		// First refresh for this task — skip, just establishing baseline
		if (prevBranch === null) return;

		const task = entry.trackedTasks.find((t) => t.taskId === taskId);
		if (!task) return;

		const projectDefault = deps.getProjectDefaultBaseRef?.(projectId) ?? "";
		const resolved = await resolveBaseRefForBranch(next.data.path, newBranch, projectDefault);
		if (resolved && resolved !== task.baseRef) {
			deps.onTaskBaseRefChanged(projectId, taskId, resolved);
		}
	};

	/**
	 * Run `git fetch --all --prune` to update remote tracking refs so that
	 * the ahead/behind counts from `git status` are accurate. After a
	 * successful fetch, triggers a home metadata refresh to pick up changes.
	 */
	const performRemoteFetch = async (projectId: string) => {
		if (remoteFetchInFlight) return;
		const entry = projects.get(projectId);
		if (!entry) return;
		remoteFetchInFlight = true;
		try {
			const result = await runGit(entry.projectPath, ["fetch", "--all", "--prune"], {
				env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
			});
			if (result.ok) {
				// Invalidate the home stateToken so the next refreshHome picks up
				// the updated tracking refs instead of short-circuiting.
				entry.homeGit.stateToken = null;
				await refreshHome(projectId);
				// Also refresh the focused task so behind-base indicators pick up
				// the updated origin refs without waiting for the next poll cycle.
				void refreshFocusedTask(projectId);
			}
		} catch {
			// Network errors, auth failures — silently skip. Next cycle retries.
		} finally {
			remoteFetchInFlight = false;
		}
	};

	/** Notify subscribers if the snapshot changed after a partial or full refresh. */
	const broadcastIfChanged = (projectId: string, entry: ProjectMetadataEntry, previous: RuntimeProjectMetadata) => {
		const next = buildProjectMetadataSnapshot(entry);
		if (!areProjectMetadataEqual(previous, next)) {
			deps.onMetadataUpdated(projectId, next);
		}
	};

	/** Refresh only the home repo metadata. Skips if a previous home refresh is still in flight. */
	const refreshHome = async (projectId: string) => {
		if (homeRefreshInFlight) {
			return;
		}
		const entry = projects.get(projectId);
		if (!entry) {
			return;
		}
		homeRefreshInFlight = true;
		try {
			const previous = buildProjectMetadataSnapshot(entry);
			entry.homeGit = await loadHomeGitMetadata(entry);
			broadcastIfChanged(projectId, entry, previous);
		} finally {
			homeRefreshInFlight = false;
		}
	};

	/** Refresh the focused task. Has its own in-flight guard so it is never starved by background refreshes. */
	const refreshFocusedTask = async (projectId: string) => {
		if (focusedRefreshInFlight) return;
		const entry = projects.get(projectId);
		if (!entry?.focusedTaskId) return;
		const task = entry.trackedTasks.find((t) => t.taskId === entry.focusedTaskId);
		if (!task) return;
		focusedRefreshInFlight = true;
		try {
			const previous = buildProjectMetadataSnapshot(entry);
			const previousCached = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
			const next = await taskProbeLimit(async () => {
				return await loadTaskWorktreeMetadata(entry.projectPath, task, previousCached);
			});
			if (next) {
				entry.taskMetadataByTaskId.set(task.taskId, next);
				void checkForBranchChanges(projectId, entry, task.taskId, previousCached, next);
			}
			broadcastIfChanged(projectId, entry, previous);
		} finally {
			focusedRefreshInFlight = false;
		}
	};

	/** Refresh non-focused tasks. Skips if a previous background refresh is still in flight. */
	const refreshBackgroundTasks = async (projectId: string) => {
		if (backgroundRefreshInFlight) return;
		const entry = projects.get(projectId);
		if (!entry) return;
		const tasksToRefresh = entry.trackedTasks.filter((t) => t.taskId !== entry.focusedTaskId);
		if (tasksToRefresh.length === 0) return;
		backgroundRefreshInFlight = true;
		try {
			const previous = buildProjectMetadataSnapshot(entry);
			const results = await Promise.all(
				tasksToRefresh.map((task) =>
					taskProbeLimit(async () => {
						const previousCached = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
						const next = await loadTaskWorktreeMetadata(entry.projectPath, task, previousCached);
						return next ? ([task.taskId, next, previousCached] as const) : null;
					}),
				),
			);
			for (const result of results) {
				if (result) {
					void checkForBranchChanges(projectId, entry, result[0], result[2], result[1]);
					entry.taskMetadataByTaskId.set(result[0], result[1]);
				}
			}
			broadcastIfChanged(projectId, entry, previous);
		} finally {
			backgroundRefreshInFlight = false;
		}
	};

	/** Full refresh — home + all tasks. Used on initial connect and state updates. */
	const refreshProject = async (projectId: string): Promise<RuntimeProjectMetadata> => {
		const entry = projects.get(projectId);
		if (!entry) {
			return createEmptyProjectMetadata();
		}
		if (entry.refreshPromise) {
			return await entry.refreshPromise;
		}

		entry.refreshPromise = (async () => {
			const previousSnapshot = buildProjectMetadataSnapshot(entry);
			entry.homeGit = await loadHomeGitMetadata(entry);

			const nextTaskEntries = await Promise.all(
				entry.trackedTasks.map((task) =>
					taskProbeLimit(async () => {
						const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
						const next = await loadTaskWorktreeMetadata(entry.projectPath, task, current);
						return next ? [task.taskId, next] : null;
					}),
				),
			);

			entry.taskMetadataByTaskId = new Map(
				nextTaskEntries.filter(
					(candidate): candidate is [string, CachedTaskWorktreeMetadata] => candidate !== null,
				),
			);

			const nextSnapshot = buildProjectMetadataSnapshot(entry);
			if (!areProjectMetadataEqual(previousSnapshot, nextSnapshot)) {
				deps.onMetadataUpdated(projectId, nextSnapshot);
			}
			return nextSnapshot;
		})().finally(() => {
			const current = projects.get(projectId);
			if (current) {
				current.refreshPromise = null;
			}
		});

		return await entry.refreshPromise;
	};

	const updateProjectEntry = (input: {
		projectId: string;
		projectPath: string;
		board: RuntimeBoardData;
	}): ProjectMetadataEntry => {
		const existing = projects.get(input.projectId) ?? createProjectEntry(input.projectPath);
		existing.projectPath = input.projectPath;
		existing.trackedTasks = collectTrackedTasks(input.board);
		projects.set(input.projectId, existing);
		return existing;
	};

	const startTimers = (projectId: string, entry: ProjectMetadataEntry) => {
		stopAllTimers(entry);

		const homeTimer = setInterval(() => {
			void refreshHome(projectId);
		}, entry.pollIntervals.homeRepoPollMs);
		homeTimer.unref();
		entry.homeTimer = homeTimer;

		const focusedTimer = setInterval(() => {
			void refreshFocusedTask(projectId);
		}, entry.pollIntervals.focusedTaskPollMs);
		focusedTimer.unref();
		entry.focusedTaskTimer = focusedTimer;

		const backgroundTimer = setInterval(() => {
			void refreshBackgroundTasks(projectId);
		}, entry.pollIntervals.backgroundTaskPollMs);
		backgroundTimer.unref();
		entry.backgroundTaskTimer = backgroundTimer;

		const fetchTimer = setInterval(() => {
			void performRemoteFetch(projectId);
		}, REMOTE_FETCH_INTERVAL_MS);
		fetchTimer.unref();
		entry.remoteFetchTimer = fetchTimer;
	};

	return {
		connectProject: async ({ projectId, projectPath, board, pollIntervals }) => {
			const entry = updateProjectEntry({ projectId, projectPath, board });
			entry.subscriberCount += 1;
			entry.pollIntervals = pollIntervals;
			startTimers(projectId, entry);
			// Fire a background fetch so remote tracking refs are fresh from the start.
			// Don't await — the initial snapshot uses local state, fetch results arrive
			// on the next poll cycle (or sooner via the refreshHome inside performRemoteFetch).
			void performRemoteFetch(projectId);
			return await refreshProject(projectId);
		},
		updateProjectState: async ({ projectId, projectPath, board }) => {
			const entry = updateProjectEntry({ projectId, projectPath, board });
			if (entry.subscriberCount === 0) {
				return buildProjectMetadataSnapshot(entry);
			}
			return await refreshProject(projectId);
		},
		setFocusedTask: (projectId, taskId) => {
			const entry = projects.get(projectId);
			if (!entry) {
				return;
			}
			if (entry.focusedTaskId === taskId) {
				return;
			}
			entry.focusedTaskId = taskId;
			// Immediate probe so the UI shows fresh data when the user selects a task.
			if (taskId) {
				void refreshFocusedTask(projectId);
			}
		},
		requestTaskRefresh: (projectId, taskId) => {
			const entry = projects.get(projectId);
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
				void refreshFocusedTask(projectId);
			} else {
				void taskProbeLimit(async () => {
					const previous = buildProjectMetadataSnapshot(entry);
					const current = entry.taskMetadataByTaskId.get(taskId) ?? null;
					const next = await loadTaskWorktreeMetadata(entry.projectPath, task, current);
					if (next) {
						entry.taskMetadataByTaskId.set(taskId, next);
					}
					broadcastIfChanged(projectId, entry, previous);
				});
			}
		},
		requestHomeRefresh: (projectId) => {
			void refreshHome(projectId);
		},
		setPollIntervals: (projectId, intervals) => {
			const entry = projects.get(projectId);
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
				startTimers(projectId, entry);
			}
		},
		disconnectProject: (projectId) => {
			const entry = projects.get(projectId);
			if (!entry) {
				return;
			}
			entry.subscriberCount = Math.max(0, entry.subscriberCount - 1);
			if (entry.subscriberCount > 0) {
				return;
			}
			stopAllTimers(entry);
			projects.delete(projectId);
		},
		disposeProject: (projectId) => {
			const entry = projects.get(projectId);
			if (!entry) {
				return;
			}
			stopAllTimers(entry);
			projects.delete(projectId);
		},
		close: () => {
			for (const entry of projects.values()) {
				stopAllTimers(entry);
			}
			projects.clear();
		},
	};
}
