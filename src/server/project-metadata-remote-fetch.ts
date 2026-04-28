import { createGitProcessEnv } from "../core";
import { runGit } from "../workdir";

/**
 * Interval (ms) between automatic `git fetch --all --prune` runs that keep
 * remote tracking refs up-to-date. Without periodic fetch, the ahead/behind
 * counts reported by `git status` are stale because the local tracking ref
 * (e.g. `origin/main`) only reflects the last fetch/pull/push.
 */
export const REMOTE_FETCH_INTERVAL_MS = 120_000;

export interface CreateProjectMetadataRemoteFetchPolicyDependencies {
	getProjectPath: () => string;
	limitRemoteFetch: <T>(fetch: () => Promise<T>) => Promise<T>;
	onFetchSucceeded: () => Promise<void>;
}

export class ProjectMetadataRemoteFetchPolicy {
	private fetchTimer: NodeJS.Timeout | null = null;
	private fetchPromise: Promise<void> | null = null;

	constructor(private readonly deps: CreateProjectMetadataRemoteFetchPolicyDependencies) {}

	start(): void {
		if (this.fetchTimer) {
			return;
		}
		this.fetchTimer = setInterval(() => {
			void this.performFetch();
		}, REMOTE_FETCH_INTERVAL_MS);
		this.fetchTimer.unref();
	}

	stop(): void {
		if (!this.fetchTimer) {
			return;
		}
		clearInterval(this.fetchTimer);
		this.fetchTimer = null;
	}

	requestFetch(): void {
		void this.performFetch();
	}

	private async performFetch(): Promise<void> {
		if (this.fetchPromise) {
			await this.fetchPromise;
			return;
		}

		this.fetchPromise = (async () => {
			try {
				const result = await this.deps.limitRemoteFetch(async () => {
					return await runGit(this.deps.getProjectPath(), ["fetch", "--all", "--prune"], {
						env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
						timeoutClass: "remoteFetch",
					});
				});
				if (result.ok) {
					await this.deps.onFetchSucceeded();
				}
			} catch {
				// Network/auth failures are non-fatal; the next cadence retries.
			}
		})().finally(() => {
			this.fetchPromise = null;
		});

		await this.fetchPromise;
	}
}
