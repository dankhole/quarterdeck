import type { RuntimeBoardData, RuntimeProjectMetadata } from "../core";
import {
	buildProjectMetadataSnapshot,
	type CachedTaskWorktreeMetadata,
	collectTrackedTasks,
	createProjectEntry,
	type ProjectMetadataEntry,
	type ProjectMetadataPollIntervals,
	type TrackedTaskWorktree,
} from "./project-metadata-loaders";
import { ProjectMetadataPoller } from "./project-metadata-poller";
import { ProjectMetadataRefresher } from "./project-metadata-refresher";
import { ProjectMetadataRemoteFetchPolicy } from "./project-metadata-remote-fetch";

export interface CreateProjectMetadataControllerDependencies {
	projectId: string;
	projectPath: string;
	limitTaskProbe: <T>(probe: () => Promise<T>) => Promise<T>;
	onMetadataUpdated: (projectId: string, metadata: RuntimeProjectMetadata) => void;
	onTaskBaseRefChanged?: (projectId: string, taskId: string, newBaseRef: string) => void;
	getProjectDefaultBaseRef?: (projectId: string) => string;
}

export class ProjectMetadataController {
	private readonly entry: ProjectMetadataEntry;
	private readonly taskMetadataFreshness = new Map<string, number>();
	private nextTaskMetadataFreshness = 1;
	private readonly refresher: ProjectMetadataRefresher;
	private readonly poller: ProjectMetadataPoller;
	private readonly remoteFetchPolicy: ProjectMetadataRemoteFetchPolicy;

	constructor(deps: CreateProjectMetadataControllerDependencies) {
		this.entry = createProjectEntry(deps.projectPath);
		this.refresher = new ProjectMetadataRefresher({
			projectId: deps.projectId,
			limitTaskProbe: deps.limitTaskProbe,
			onMetadataUpdated: deps.onMetadataUpdated,
			onTaskBaseRefChanged: deps.onTaskBaseRefChanged,
			getProjectDefaultBaseRef: deps.getProjectDefaultBaseRef,
			getSnapshot: () => buildProjectMetadataSnapshot(this.entry),
			getProjectPath: () => this.entry.projectPath,
			getTrackedTasks: () => [...this.entry.trackedTasks],
			getTrackedTask: (taskId) => this.getTrackedTask(taskId),
			getFocusedTaskId: () => this.entry.focusedTaskId,
			getHomeGit: () => this.entry.homeGit,
			getTaskMetadata: (taskId) => this.entry.taskMetadataByTaskId.get(taskId) ?? null,
			getTaskFreshness: (taskId) => this.taskMetadataFreshness.get(taskId) ?? 0,
			commitHomeGit: (next) => {
				this.entry.homeGit = next;
			},
			commitTaskMetadata: (taskId, next, options) => this.commitTaskMetadata(taskId, next, options),
		});
		this.poller = new ProjectMetadataPoller({
			getPollIntervals: () => this.entry.pollIntervals,
			refreshHome: () => this.refresher.refreshHome(),
			refreshFocusedTask: () => this.refresher.refreshFocusedTask(),
			refreshBackgroundTasks: () => this.refresher.refreshBackgroundTasks(),
		});
		this.remoteFetchPolicy = new ProjectMetadataRemoteFetchPolicy({
			getProjectPath: () => this.entry.projectPath,
			onFetchSucceeded: async () => {
				await this.refresher.refreshHome({ invalidate: true });
				void this.refresher.refreshFocusedTask();
			},
		});
	}

	async connect(input: {
		projectPath: string;
		board: RuntimeBoardData;
		pollIntervals: ProjectMetadataPollIntervals;
	}): Promise<RuntimeProjectMetadata> {
		this.updateTrackedState(input.projectPath, input.board);
		this.entry.subscriberCount += 1;
		this.entry.pollIntervals = input.pollIntervals;
		this.poller.start();
		this.remoteFetchPolicy.start();
		this.remoteFetchPolicy.requestFetch();
		return await this.refresher.refreshProject();
	}

	async updateProjectState(input: { projectPath: string; board: RuntimeBoardData }): Promise<RuntimeProjectMetadata> {
		this.updateTrackedState(input.projectPath, input.board);
		if (this.entry.subscriberCount === 0) {
			return buildProjectMetadataSnapshot(this.entry);
		}
		return await this.refresher.refreshProject();
	}

	setFocusedTask(taskId: string | null): void {
		const nextFocusedTaskId =
			taskId && this.entry.trackedTasks.some((task) => task.taskId === taskId) ? taskId : null;
		if (this.entry.focusedTaskId === nextFocusedTaskId) {
			return;
		}
		this.entry.focusedTaskId = nextFocusedTaskId;
		if (nextFocusedTaskId) {
			void this.refresher.refreshFocusedTask();
		}
	}

	requestTaskRefresh(taskId: string): void {
		void this.refresher.refreshTask(taskId, { invalidate: true });
	}

	requestHomeRefresh(): void {
		void this.refresher.refreshHome();
	}

	setPollIntervals(intervals: ProjectMetadataPollIntervals): void {
		const changed =
			this.entry.pollIntervals.focusedTaskPollMs !== intervals.focusedTaskPollMs ||
			this.entry.pollIntervals.backgroundTaskPollMs !== intervals.backgroundTaskPollMs ||
			this.entry.pollIntervals.homeRepoPollMs !== intervals.homeRepoPollMs;
		if (!changed) {
			return;
		}
		this.entry.pollIntervals = intervals;
		if (this.entry.subscriberCount > 0) {
			this.poller.start();
			this.remoteFetchPolicy.stop();
			this.remoteFetchPolicy.start();
		}
	}

	disconnect(): boolean {
		this.entry.subscriberCount = Math.max(0, this.entry.subscriberCount - 1);
		if (this.entry.subscriberCount > 0) {
			return false;
		}
		this.stopPolicies();
		return true;
	}

	dispose(): void {
		this.stopPolicies();
	}

	private stopPolicies(): void {
		this.poller.stop();
		this.remoteFetchPolicy.stop();
	}

	private getTrackedTask(taskId: string): TrackedTaskWorktree | null {
		return this.entry.trackedTasks.find((task) => task.taskId === taskId) ?? null;
	}

	private commitTaskMetadata(
		taskId: string,
		next: CachedTaskWorktreeMetadata,
		options: { expectedVersion: number; bumpVersion: boolean },
	): { applied: boolean; previous: CachedTaskWorktreeMetadata | null } {
		const task = this.getTrackedTask(taskId);
		const previous = this.entry.taskMetadataByTaskId.get(taskId) ?? null;
		if (!task) {
			return { applied: false, previous };
		}
		const currentFreshness = this.taskMetadataFreshness.get(taskId) ?? 0;
		if (currentFreshness !== options.expectedVersion) {
			return { applied: false, previous };
		}
		this.entry.taskMetadataByTaskId.set(taskId, next);
		if (options.bumpVersion) {
			this.taskMetadataFreshness.set(taskId, this.nextTaskMetadataFreshness++);
		}
		return { applied: true, previous };
	}

	private bumpTaskMetadataFreshness(taskId: string): void {
		this.taskMetadataFreshness.set(taskId, this.nextTaskMetadataFreshness++);
	}

	private updateTrackedState(projectPath: string, board: RuntimeBoardData): void {
		const previousTrackedTasks = new Map(this.entry.trackedTasks.map((task) => [task.taskId, task] as const));
		this.entry.projectPath = projectPath;
		this.entry.trackedTasks = collectTrackedTasks(board);

		const trackedTaskIds = new Set(this.entry.trackedTasks.map((task) => task.taskId));
		this.entry.taskMetadataByTaskId = new Map(
			Array.from(this.entry.taskMetadataByTaskId.entries()).filter(([taskId]) => trackedTaskIds.has(taskId)),
		);
		for (const taskId of Array.from(this.taskMetadataFreshness.keys())) {
			if (!trackedTaskIds.has(taskId)) {
				this.taskMetadataFreshness.delete(taskId);
			}
		}
		for (const task of this.entry.trackedTasks) {
			const previous = previousTrackedTasks.get(task.taskId);
			if (!previous) {
				continue;
			}
			if (previous.baseRef !== task.baseRef || previous.workingDirectory !== task.workingDirectory) {
				this.bumpTaskMetadataFreshness(task.taskId);
			}
		}
		if (this.entry.focusedTaskId && !trackedTaskIds.has(this.entry.focusedTaskId)) {
			this.entry.focusedTaskId = null;
		}
	}
}
