import pLimit from "p-limit";

import type {
	RuntimeBoardData,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo, pathExists } from "../workspace/task-worktree";

const GIT_PROBE_CONCURRENCY_LIMIT = 3;

export interface WorkspaceMetadataPollIntervals {
	focusedTaskPollMs: number;
	backgroundTaskPollMs: number;
	homeRepoPollMs: number;
}

interface TrackedTaskWorkspace {
	taskId: string;
	baseRef: string;
	workingDirectory: string | null;
}

interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	stateToken: string | null;
	stateVersion: number;
}

interface CachedTaskWorkspaceMetadata {
	data: RuntimeTaskWorkspaceMetadata;
	stateToken: string | null;
}

interface WorkspaceMetadataEntry {
	workspacePath: string;
	trackedTasks: TrackedTaskWorkspace[];
	subscriberCount: number;
	focusedTaskId: string | null;
	homeTimer: NodeJS.Timeout | null;
	focusedTaskTimer: NodeJS.Timeout | null;
	backgroundTaskTimer: NodeJS.Timeout | null;
	refreshPromise: Promise<RuntimeWorkspaceMetadata> | null;
	homeGit: CachedHomeGitMetadata;
	taskMetadataByTaskId: Map<string, CachedTaskWorkspaceMetadata>;
	pollIntervals: WorkspaceMetadataPollIntervals;
}

export interface CreateWorkspaceMetadataMonitorDependencies {
	onMetadataUpdated: (workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void;
}

export interface WorkspaceMetadataMonitor {
	connectWorkspace: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
		pollIntervals: WorkspaceMetadataPollIntervals;
	}) => Promise<RuntimeWorkspaceMetadata>;
	updateWorkspaceState: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	setFocusedTask: (workspaceId: string, taskId: string | null) => void;
	setPollIntervals: (workspaceId: string, intervals: WorkspaceMetadataPollIntervals) => void;
	disconnectWorkspace: (workspaceId: string) => void;
	disposeWorkspace: (workspaceId: string) => void;
	close: () => void;
}

function collectTrackedTasks(board: RuntimeBoardData): TrackedTaskWorkspace[] {
	const tracked: TrackedTaskWorkspace[] = [];
	for (const column of board.columns) {
		// Backlog and trash cards do not need git metadata polling. Tracking only
		// active columns avoids unnecessary work, and trash paths are reconstructed
		// from task id on the web-ui side.
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			tracked.push({
				taskId: card.id,
				baseRef: card.baseRef,
				workingDirectory: card.workingDirectory ?? null,
			});
		}
	}
	return tracked;
}

function areGitSummariesEqual(a: RuntimeGitSyncSummary | null, b: RuntimeGitSyncSummary | null): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.currentBranch === b.currentBranch &&
		a.upstreamBranch === b.upstreamBranch &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.aheadCount === b.aheadCount &&
		a.behindCount === b.behindCount
	);
}

function areTaskMetadataEqual(a: RuntimeTaskWorkspaceMetadata, b: RuntimeTaskWorkspaceMetadata): boolean {
	return (
		a.taskId === b.taskId &&
		a.path === b.path &&
		a.exists === b.exists &&
		a.baseRef === b.baseRef &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.hasUnmergedChanges === b.hasUnmergedChanges &&
		a.stateVersion === b.stateVersion
	);
}

function areWorkspaceMetadataEqual(a: RuntimeWorkspaceMetadata, b: RuntimeWorkspaceMetadata): boolean {
	if (!areGitSummariesEqual(a.homeGitSummary, b.homeGitSummary)) {
		return false;
	}
	if (a.homeGitStateVersion !== b.homeGitStateVersion) {
		return false;
	}
	if (a.taskWorkspaces.length !== b.taskWorkspaces.length) {
		return false;
	}
	for (let index = 0; index < a.taskWorkspaces.length; index += 1) {
		const left = a.taskWorkspaces[index];
		const right = b.taskWorkspaces[index];
		if (!left || !right || !areTaskMetadataEqual(left, right)) {
			return false;
		}
	}
	return true;
}

function createEmptyWorkspaceMetadata(): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		taskWorkspaces: [],
	};
}

function createWorkspaceEntry(workspacePath: string): WorkspaceMetadataEntry {
	return {
		workspacePath,
		trackedTasks: [],
		subscriberCount: 0,
		focusedTaskId: null,
		homeTimer: null,
		focusedTaskTimer: null,
		backgroundTaskTimer: null,
		refreshPromise: null,
		homeGit: {
			summary: null,
			stateToken: null,
			stateVersion: 0,
		},
		taskMetadataByTaskId: new Map<string, CachedTaskWorkspaceMetadata>(),
		pollIntervals: { focusedTaskPollMs: 2_000, backgroundTaskPollMs: 5_000, homeRepoPollMs: 10_000 },
	};
}

function buildWorkspaceMetadataSnapshot(entry: WorkspaceMetadataEntry): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: entry.homeGit.summary,
		homeGitStateVersion: entry.homeGit.stateVersion,
		taskWorkspaces: entry.trackedTasks
			.map((task) => entry.taskMetadataByTaskId.get(task.taskId)?.data ?? null)
			.filter((task): task is RuntimeTaskWorkspaceMetadata => task !== null),
	};
}

async function loadHomeGitMetadata(entry: WorkspaceMetadataEntry): Promise<CachedHomeGitMetadata> {
	try {
		const probe = await probeGitWorkspaceState(entry.workspacePath);
		if (entry.homeGit.stateToken === probe.stateToken) {
			return entry.homeGit;
		}
		const summary = await getGitSyncSummary(entry.workspacePath, { probe });
		return {
			summary,
			stateToken: probe.stateToken,
			stateVersion: Date.now(),
		};
	} catch {
		return entry.homeGit;
	}
}

async function resolveTaskPath(
	workspacePath: string,
	task: TrackedTaskWorkspace,
): Promise<{ path: string; exists: boolean; baseRef: string }> {
	// Use the card's workingDirectory if available (set at session start).
	if (task.workingDirectory) {
		const exists = await pathExists(task.workingDirectory);
		return { path: task.workingDirectory, exists, baseRef: task.baseRef };
	}
	// Fallback for tasks started before workingDirectory was persisted.
	return await getTaskWorkspacePathInfo({
		cwd: workspacePath,
		taskId: task.taskId,
		baseRef: task.baseRef,
	});
}

async function loadTaskWorkspaceMetadata(
	workspacePath: string,
	task: TrackedTaskWorkspace,
	current: CachedTaskWorkspaceMetadata | null,
): Promise<CachedTaskWorkspaceMetadata | null> {
	const pathInfo = await resolveTaskPath(workspacePath, task);

	if (!pathInfo.exists) {
		if (
			current &&
			current.data.exists === false &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: false,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				hasUnmergedChanges: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}

	try {
		const probe = await probeGitWorkspaceState(pathInfo.path);
		if (
			current &&
			current.stateToken === probe.stateToken &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		const [summary, unmergedResult] = await Promise.all([
			getGitSyncSummary(pathInfo.path, { probe }),
			runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", pathInfo.baseRef, "HEAD"]),
		]);
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: probe.currentBranch,
				isDetached: probe.headCommit !== null && probe.currentBranch === null,
				headCommit: probe.headCommit,
				changedFiles: summary.changedFiles,
				additions: summary.additions,
				deletions: summary.deletions,
				hasUnmergedChanges: unmergedResult.exitCode === 0 ? false : unmergedResult.exitCode === 1 ? true : null,
				stateVersion: Date.now(),
			},
			stateToken: probe.stateToken,
		};
	} catch {
		if (current) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				hasUnmergedChanges: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}
}

export function createWorkspaceMetadataMonitor(
	deps: CreateWorkspaceMetadataMonitorDependencies,
): WorkspaceMetadataMonitor {
	const workspaces = new Map<string, WorkspaceMetadataEntry>();
	const taskProbeLimit = pLimit(GIT_PROBE_CONCURRENCY_LIMIT);
	let homeRefreshInFlight = false;
	let taskRefreshInFlight = false;

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

	/** Refresh a specific set of tasks (by task ID). Skips if a previous task refresh is still in flight. */
	const refreshTasks = async (workspaceId: string, taskIds: Set<string>) => {
		if (taskRefreshInFlight) {
			return;
		}
		const entry = workspaces.get(workspaceId);
		if (!entry) {
			return;
		}
		const tasksToRefresh = entry.trackedTasks.filter((task) => taskIds.has(task.taskId));
		if (tasksToRefresh.length === 0) {
			return;
		}
		taskRefreshInFlight = true;
		try {
			const previous = buildWorkspaceMetadataSnapshot(entry);
			const results = await Promise.all(
				tasksToRefresh.map((task) =>
					taskProbeLimit(async () => {
						const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
						const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current);
						return next ? ([task.taskId, next] as const) : null;
					}),
				),
			);
			for (const result of results) {
				if (result) {
					entry.taskMetadataByTaskId.set(result[0], result[1]);
				}
			}
			broadcastIfChanged(workspaceId, entry, previous);
		} finally {
			taskRefreshInFlight = false;
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
			if (entry.focusedTaskId) {
				void refreshTasks(workspaceId, new Set([entry.focusedTaskId]));
			}
		}, entry.pollIntervals.focusedTaskPollMs);
		focusedTimer.unref();
		entry.focusedTaskTimer = focusedTimer;

		const backgroundTimer = setInterval(() => {
			const backgroundTaskIds = new Set(
				entry.trackedTasks.map((task) => task.taskId).filter((taskId) => taskId !== entry.focusedTaskId),
			);
			if (backgroundTaskIds.size > 0) {
				void refreshTasks(workspaceId, backgroundTaskIds);
			}
		}, entry.pollIntervals.backgroundTaskPollMs);
		backgroundTimer.unref();
		entry.backgroundTaskTimer = backgroundTimer;
	};

	return {
		connectWorkspace: async ({ workspaceId, workspacePath, board, pollIntervals }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			entry.subscriberCount += 1;
			entry.pollIntervals = pollIntervals;
			startTimers(workspaceId, entry);
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
				void refreshTasks(workspaceId, new Set([taskId]));
			}
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
