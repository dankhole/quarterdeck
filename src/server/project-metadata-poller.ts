import type { ProjectMetadataPollIntervals } from "./project-metadata-loaders";

const HIDDEN_HOME_REPO_POLL_MS = 60_000;
const HIDDEN_BACKGROUND_TASK_POLL_MS = 60_000;

interface ProjectMetadataPollState {
	pollIntervals: ProjectMetadataPollIntervals;
	isDocumentVisible: boolean;
	hasFocusedTask: boolean;
}

export interface CreateProjectMetadataPollerDependencies {
	getPollState: () => ProjectMetadataPollState;
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

		const { pollIntervals, isDocumentVisible, hasFocusedTask } = this.deps.getPollState();
		const homePollMs = isDocumentVisible
			? pollIntervals.homeRepoPollMs
			: Math.max(pollIntervals.homeRepoPollMs, HIDDEN_HOME_REPO_POLL_MS);
		const backgroundPollMs = isDocumentVisible
			? pollIntervals.backgroundTaskPollMs
			: Math.max(pollIntervals.backgroundTaskPollMs, HIDDEN_BACKGROUND_TASK_POLL_MS);

		this.homeTimer = setInterval(() => {
			void this.deps.refreshHome();
		}, homePollMs);
		this.homeTimer.unref();

		if (isDocumentVisible && hasFocusedTask) {
			this.focusedTaskTimer = setInterval(() => {
				void this.deps.refreshFocusedTask();
			}, pollIntervals.focusedTaskPollMs);
			this.focusedTaskTimer.unref();
		}

		this.backgroundTaskTimer = setInterval(() => {
			void this.deps.refreshBackgroundTasks();
		}, backgroundPollMs);
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
