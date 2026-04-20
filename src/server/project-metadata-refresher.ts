import type { RuntimeProjectMetadata } from "../core";
import { resolveBaseRefForBranch } from "../workdir";
import {
	areProjectMetadataEqual,
	type CachedHomeGitMetadata,
	type CachedTaskWorktreeMetadata,
	loadHomeGitMetadata,
	loadTaskWorktreeMetadata,
	type TrackedTaskWorktree,
} from "./project-metadata-loaders";

interface QueuedRefreshState {
	promise: Promise<void> | null;
	rerun: boolean;
	invalidate: boolean;
}

interface QueuedFullRefreshState {
	promise: Promise<RuntimeProjectMetadata> | null;
	rerun: boolean;
}

export interface CreateProjectMetadataRefresherDependencies {
	projectId: string;
	limitTaskProbe: <T>(probe: () => Promise<T>) => Promise<T>;
	onMetadataUpdated: (projectId: string, metadata: RuntimeProjectMetadata) => void;
	onTaskBaseRefChanged?: (projectId: string, taskId: string, newBaseRef: string) => void;
	getProjectDefaultBaseRef?: (projectId: string) => string;
	getSnapshot: () => RuntimeProjectMetadata;
	getProjectPath: () => string;
	getTrackedTasks: () => TrackedTaskWorktree[];
	getTrackedTask: (taskId: string) => TrackedTaskWorktree | null;
	getFocusedTaskId: () => string | null;
	getHomeGit: () => CachedHomeGitMetadata;
	getTaskMetadata: (taskId: string) => CachedTaskWorktreeMetadata | null;
	getTaskFreshness: (taskId: string) => number;
	commitHomeGit: (next: CachedHomeGitMetadata) => void;
	commitTaskMetadata: (
		taskId: string,
		next: CachedTaskWorktreeMetadata,
		options: { expectedVersion: number; bumpVersion: boolean },
	) => { applied: boolean; previous: CachedTaskWorktreeMetadata | null };
}

export class ProjectMetadataRefresher {
	private readonly fullRefreshState: QueuedFullRefreshState = {
		promise: null,
		rerun: false,
	};
	private backgroundRefreshPromise: Promise<void> | null = null;
	private readonly homeRefreshState: QueuedRefreshState = {
		promise: null,
		rerun: false,
		invalidate: false,
	};
	private readonly taskRefreshStates = new Map<string, QueuedRefreshState>();

	constructor(private readonly deps: CreateProjectMetadataRefresherDependencies) {}

	get snapshot(): RuntimeProjectMetadata {
		return this.deps.getSnapshot();
	}

	async refreshProject(): Promise<RuntimeProjectMetadata> {
		if (this.fullRefreshState.promise) {
			this.fullRefreshState.rerun = true;
			return await this.fullRefreshState.promise;
		}

		this.fullRefreshState.promise = (async () => {
			let latestSnapshot = this.snapshot;
			do {
				this.fullRefreshState.rerun = false;
				latestSnapshot = await this.performFullRefresh();
			} while (this.fullRefreshState.rerun);
			return latestSnapshot;
		})().finally(() => {
			this.fullRefreshState.promise = null;
		});

		return await this.fullRefreshState.promise;
	}

	async refreshHome(options?: { invalidate?: boolean }): Promise<void> {
		await this.runQueuedRefresh(
			this.homeRefreshState,
			async (invalidate) => {
				const previousSnapshot = this.snapshot;
				const currentHomeGit = this.deps.getHomeGit();
				const nextHomeGit = await loadHomeGitMetadata(
					this.deps.getProjectPath(),
					invalidate ? { ...currentHomeGit, stateToken: null } : currentHomeGit,
				);
				this.deps.commitHomeGit(nextHomeGit);
				this.broadcastIfChanged(previousSnapshot);
			},
			options?.invalidate ?? false,
		);
	}

	async refreshFocusedTask(options?: { invalidate?: boolean }): Promise<void> {
		const focusedTaskId = this.deps.getFocusedTaskId();
		if (!focusedTaskId) {
			return;
		}
		await this.refreshTask(focusedTaskId, options);
	}

	async refreshBackgroundTasks(): Promise<void> {
		if (this.backgroundRefreshPromise) {
			return await this.backgroundRefreshPromise;
		}
		const focusedTaskId = this.deps.getFocusedTaskId();
		const taskIds = this.deps
			.getTrackedTasks()
			.filter((task) => task.taskId !== focusedTaskId)
			.map((task) => task.taskId);
		if (taskIds.length === 0) {
			return;
		}

		this.backgroundRefreshPromise = Promise.all(taskIds.map((taskId) => this.refreshTask(taskId)))
			.then(() => {})
			.finally(() => {
				this.backgroundRefreshPromise = null;
			});
		await this.backgroundRefreshPromise;
	}

	async refreshTask(taskId: string, options?: { invalidate?: boolean }): Promise<void> {
		if (!this.deps.getTrackedTask(taskId)) {
			return;
		}
		const refreshState = this.getTaskRefreshState(taskId);
		await this.runQueuedRefresh(
			refreshState,
			async (invalidate) => {
				await this.performTaskRefresh(taskId, invalidate);
			},
			options?.invalidate ?? false,
		);
	}

	private async performTaskRefresh(taskId: string, invalidate: boolean): Promise<void> {
		const task = this.deps.getTrackedTask(taskId);
		if (!task) {
			return;
		}

		const previousSnapshot = this.snapshot;
		const previousCached = this.deps.getTaskMetadata(taskId);
		const refreshInput = invalidate && previousCached ? { ...previousCached, stateToken: null } : previousCached;
		const expectedVersion = this.deps.getTaskFreshness(taskId);

		const next = await this.deps.limitTaskProbe(async () => {
			return await loadTaskWorktreeMetadata(this.deps.getProjectPath(), task, refreshInput);
		});
		if (!next) {
			return;
		}

		const commit = this.deps.commitTaskMetadata(taskId, next, {
			expectedVersion,
			bumpVersion: true,
		});
		if (!commit.applied) {
			return;
		}
		await this.checkForBranchChanges(taskId, commit.previous, next);
		this.broadcastIfChanged(previousSnapshot);
	}

	private async performFullRefresh(): Promise<RuntimeProjectMetadata> {
		const previousSnapshot = this.snapshot;
		const trackedTasks = this.deps.getTrackedTasks();
		const projectPath = this.deps.getProjectPath();
		const previousTaskMetadata = new Map(
			trackedTasks.map((task) => [task.taskId, this.deps.getTaskMetadata(task.taskId)] as const),
		);
		const taskFreshnessByTaskId = new Map(
			trackedTasks.map((task) => [task.taskId, this.deps.getTaskFreshness(task.taskId)] as const),
		);
		const nextHomeGit = await loadHomeGitMetadata(projectPath, this.deps.getHomeGit());
		// Home git intentionally stays last-writer-wins: it is one project-wide value,
		// so the targeted-vs-full stale-overwrite problem we guard for tasks does not
		// apply in the same per-entity way here.
		this.deps.commitHomeGit(nextHomeGit);

		const nextTaskEntries = await Promise.all(
			trackedTasks.map((task) =>
				this.deps.limitTaskProbe(async () => {
					const previousCached = previousTaskMetadata.get(task.taskId) ?? null;
					// This cache input is captured once per refresh pass. A targeted refresh may
					// commit newer metadata while this load is in flight, which can cost us a
					// cache-hit and extra git work. We accept that probe-efficiency tradeoff so
					// the controller freshness gate can stay the single source of commit truth.
					const next = await loadTaskWorktreeMetadata(projectPath, task, previousCached);
					return next ? ([task.taskId, next] as const) : null;
				}),
			),
		);

		for (const result of nextTaskEntries) {
			if (!result) {
				continue;
			}
			const [taskId, next] = result;
			const commit = this.deps.commitTaskMetadata(taskId, next, {
				expectedVersion: taskFreshnessByTaskId.get(taskId) ?? 0,
				bumpVersion: false,
			});
			if (commit.applied) {
				void this.checkForBranchChanges(taskId, commit.previous, next);
			}
		}

		const nextSnapshot = this.snapshot;
		if (!areProjectMetadataEqual(previousSnapshot, nextSnapshot)) {
			this.deps.onMetadataUpdated(this.deps.projectId, nextSnapshot);
		}
		return nextSnapshot;
	}

	private async checkForBranchChanges(
		taskId: string,
		previous: CachedTaskWorktreeMetadata | null,
		next: CachedTaskWorktreeMetadata,
	): Promise<void> {
		if (!this.deps.onTaskBaseRefChanged) {
			return;
		}
		const previousBranch = previous?.lastKnownBranch ?? null;
		const newBranch = next.lastKnownBranch;
		if (!newBranch || newBranch === previousBranch || !next.data.exists) {
			return;
		}
		if (previousBranch === null) {
			return;
		}

		const task = this.deps.getTrackedTask(taskId);
		if (!task) {
			return;
		}

		const projectDefault = this.deps.getProjectDefaultBaseRef?.(this.deps.projectId) ?? "";
		const resolved = await resolveBaseRefForBranch(next.data.path, newBranch, projectDefault);
		if (resolved && resolved !== task.baseRef) {
			this.deps.onTaskBaseRefChanged(this.deps.projectId, taskId, resolved);
		}
	}

	private broadcastIfChanged(previousSnapshot: RuntimeProjectMetadata): void {
		const nextSnapshot = this.snapshot;
		if (!areProjectMetadataEqual(previousSnapshot, nextSnapshot)) {
			this.deps.onMetadataUpdated(this.deps.projectId, nextSnapshot);
		}
	}

	private getTaskRefreshState(taskId: string): QueuedRefreshState {
		const current = this.taskRefreshStates.get(taskId);
		if (current) {
			return current;
		}
		const next: QueuedRefreshState = {
			promise: null,
			rerun: false,
			invalidate: false,
		};
		this.taskRefreshStates.set(taskId, next);
		return next;
	}

	private async runQueuedRefresh(
		state: QueuedRefreshState,
		refresh: (invalidate: boolean) => Promise<void>,
		invalidate: boolean,
	): Promise<void> {
		if (state.promise) {
			state.rerun = true;
			state.invalidate = state.invalidate || invalidate;
			await state.promise;
			return;
		}

		state.invalidate = state.invalidate || invalidate;
		state.promise = (async () => {
			do {
				const shouldInvalidate = state.invalidate;
				state.invalidate = false;
				state.rerun = false;
				await refresh(shouldInvalidate);
			} while (state.rerun);
		})().finally(() => {
			state.promise = null;
		});

		await state.promise;
	}
}
