import type { ProjectMetadataPollIntervals } from "./project-metadata-loaders";

export interface CreateProjectMetadataPollerDependencies {
	getPollIntervals: () => ProjectMetadataPollIntervals;
	refreshHome: () => Promise<void>;
	refreshFocusedTask: () => Promise<void>;
	refreshBackgroundTasks: () => Promise<void>;
}

export class ProjectMetadataPoller {
	private homeTimer: NodeJS.Timeout | null = null;
	private focusedTaskTimer: NodeJS.Timeout | null = null;
	private backgroundTaskTimer: NodeJS.Timeout | null = null;

	constructor(private readonly deps: CreateProjectMetadataPollerDependencies) {}

	start(): void {
		this.stop();

		const pollIntervals = this.deps.getPollIntervals();

		this.homeTimer = setInterval(() => {
			void this.deps.refreshHome();
		}, pollIntervals.homeRepoPollMs);
		this.homeTimer.unref();

		this.focusedTaskTimer = setInterval(() => {
			void this.deps.refreshFocusedTask();
		}, pollIntervals.focusedTaskPollMs);
		this.focusedTaskTimer.unref();

		this.backgroundTaskTimer = setInterval(() => {
			void this.deps.refreshBackgroundTasks();
		}, pollIntervals.backgroundTaskPollMs);
		this.backgroundTaskTimer.unref();
	}

	stop(): void {
		if (this.homeTimer) {
			clearInterval(this.homeTimer);
			this.homeTimer = null;
		}
		if (this.focusedTaskTimer) {
			clearInterval(this.focusedTaskTimer);
			this.focusedTaskTimer = null;
		}
		if (this.backgroundTaskTimer) {
			clearInterval(this.backgroundTaskTimer);
			this.backgroundTaskTimer = null;
		}
	}
}
