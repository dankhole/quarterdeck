import type { RuntimeProjectMetadata } from "../core";
import { resolveBaseRefForBranch } from "../workdir";
import {
	areProjectMetadataEqual,
	buildProjectMetadataSnapshot,
	type CachedTaskWorktreeMetadata,
	loadHomeGitMetadata,
	loadTaskWorktreeMetadata,
	type ProjectMetadataEntry,
	type TrackedTaskWorktree,
} from "./project-metadata-loaders";

interface QueuedRefreshState {
	promise: Promise<void> | null;
	rerun: boolean;
	invalidate: boolean;
}

export interface CreateProjectMetadataRefresherDependencies {
	projectId: string;
	entry: ProjectMetadataEntry;
	limitTaskProbe: <T>(probe: () => Promise<T>) => Promise<T>;
	onMetadataUpdated: (projectId: string, metadata: RuntimeProjectMetadata) => void;
	onTaskBaseRefChanged?: (projectId: string, taskId: string, newBaseRef: string) => void;
	getProjectDefaultBaseRef?: (projectId: string) => string;
}

export class ProjectMetadataRefresher {
	private fullRefreshPromise: Promise<RuntimeProjectMetadata> | null = null;
	private backgroundRefreshPromise: Promise<void> | null = null;
	private readonly homeRefreshState: QueuedRefreshState = {
		promise: null,
		rerun: false,
		invalidate: false,
	};
	private readonly taskRefreshStates = new Map<string, QueuedRefreshState>();

	constructor(private readonly deps: CreateProjectMetadataRefresherDependencies) {}

	get snapshot(): RuntimeProjectMetadata {
		return buildProjectMetadataSnapshot(this.deps.entry);
	}

	invalidateHome(): void {
		this.deps.entry.homeGit.stateToken = null;
	}

	async refreshProject(): Promise<RuntimeProjectMetadata> {
		if (this.fullRefreshPromise) {
			return await this.fullRefreshPromise;
		}

		this.fullRefreshPromise = (async () => {
			const previousSnapshot = this.snapshot;
			const previousTaskMetadata = new Map(this.deps.entry.taskMetadataByTaskId);
			this.deps.entry.homeGit = await loadHomeGitMetadata(this.deps.entry);

			const nextTaskEntries = await Promise.all(
				this.deps.entry.trackedTasks.map((task) =>
					this.deps.limitTaskProbe(async () => {
						const previousCached = previousTaskMetadata.get(task.taskId) ?? null;
						const next = await loadTaskWorktreeMetadata(this.deps.entry.projectPath, task, previousCached);
						return next ? ([task.taskId, next, previousCached] as const) : null;
					}),
				),
			);

			const nextTaskMetadata = new Map<string, CachedTaskWorktreeMetadata>();
			for (const result of nextTaskEntries) {
				if (!result) {
					continue;
				}
				const [taskId, next, previousCached] = result;
				nextTaskMetadata.set(taskId, next);
				void this.checkForBranchChanges(taskId, previousCached, next);
			}
			this.deps.entry.taskMetadataByTaskId = nextTaskMetadata;

			const nextSnapshot = this.snapshot;
			if (!areProjectMetadataEqual(previousSnapshot, nextSnapshot)) {
				this.deps.onMetadataUpdated(this.deps.projectId, nextSnapshot);
			}
			return nextSnapshot;
		})().finally(() => {
			this.fullRefreshPromise = null;
		});

		return await this.fullRefreshPromise;
	}

	async refreshHome(options?: { invalidate?: boolean }): Promise<void> {
		await this.runQueuedRefresh(
			this.homeRefreshState,
			async (invalidate) => {
				if (invalidate) {
					this.invalidateHome();
				}
				const previousSnapshot = this.snapshot;
				this.deps.entry.homeGit = await loadHomeGitMetadata(this.deps.entry);
				this.broadcastIfChanged(previousSnapshot);
			},
			options?.invalidate ?? false,
		);
	}

	async refreshFocusedTask(options?: { invalidate?: boolean }): Promise<void> {
		const focusedTaskId = this.deps.entry.focusedTaskId;
		if (!focusedTaskId) {
			return;
		}
		await this.refreshTask(focusedTaskId, options);
	}

	async refreshBackgroundTasks(): Promise<void> {
		if (this.backgroundRefreshPromise) {
			return await this.backgroundRefreshPromise;
		}
		const taskIds = this.deps.entry.trackedTasks
			.filter((task) => task.taskId !== this.deps.entry.focusedTaskId)
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
		if (!this.findTrackedTask(taskId)) {
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
		const task = this.findTrackedTask(taskId);
		if (!task) {
			return;
		}

		const previousSnapshot = this.snapshot;
		let previousCached = this.deps.entry.taskMetadataByTaskId.get(taskId) ?? null;
		if (invalidate && previousCached) {
			previousCached = { ...previousCached, stateToken: null };
			this.deps.entry.taskMetadataByTaskId.set(taskId, previousCached);
		}

		const next = await this.deps.limitTaskProbe(async () => {
			return await loadTaskWorktreeMetadata(this.deps.entry.projectPath, task, previousCached);
		});
		if (!next) {
			return;
		}

		this.deps.entry.taskMetadataByTaskId.set(taskId, next);
		await this.checkForBranchChanges(taskId, previousCached, next);
		this.broadcastIfChanged(previousSnapshot);
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

		const task = this.findTrackedTask(taskId);
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

	private findTrackedTask(taskId: string): TrackedTaskWorktree | null {
		return this.deps.entry.trackedTasks.find((task) => task.taskId === taskId) ?? null;
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
