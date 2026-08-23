import { createGitProcessEnv, normalizeDiagnosticErrorClass } from "../core";
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
	onFetchCompleted?: (result: ProjectMetadataRemoteFetchResult) => void;
}

export interface ProjectMetadataRemoteFetchResult {
	durationMs: number;
	succeeded: boolean;
	errorClass: string | null;
}

export interface ProjectMetadataRemoteFetchDiagnosticSnapshot {
	timerActive: boolean;
	fetchInFlight: boolean;
	lastStartedAt: number | null;
	lastCompletedAt: number | null;
	lastSucceeded: boolean | null;
	lastErrorClass: string | null;
}

export class ProjectMetadataRemoteFetchPolicy {
	private fetchTimer: NodeJS.Timeout | null = null;
	private fetchPromise: Promise<void> | null = null;
	private lastStartedAt: number | null = null;
	private lastCompletedAt: number | null = null;
	private lastSucceeded: boolean | null = null;
	private lastErrorClass: string | null = null;

	constructor(private readonly deps: CreateProjectMetadataRemoteFetchPolicyDependencies) {}

	getDiagnosticSnapshot(): ProjectMetadataRemoteFetchDiagnosticSnapshot {
		return {
			timerActive: this.fetchTimer !== null,
			fetchInFlight: this.fetchPromise !== null,
			lastStartedAt: this.lastStartedAt,
			lastCompletedAt: this.lastCompletedAt,
			lastSucceeded: this.lastSucceeded,
			lastErrorClass: this.lastErrorClass,
		};
	}

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
			this.lastStartedAt = Date.now();
			this.lastErrorClass = null;
			try {
				const result = await this.deps.limitRemoteFetch(async () => {
					return await runGit(this.deps.getProjectPath(), ["fetch", "--all", "--prune"], {
						env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
						timeoutClass: "remoteFetch",
					});
				});
				if (result.ok) {
					await this.deps.onFetchSucceeded();
				} else {
					this.lastErrorClass = "GitCommandFailed";
				}
				this.lastSucceeded = result.ok;
			} catch (error) {
				this.lastSucceeded = false;
				this.lastErrorClass = error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError";
				// Network/auth failures are non-fatal; the next cadence retries.
			}
		})().finally(() => {
			this.lastCompletedAt = Date.now();
			try {
				this.deps.onFetchCompleted?.({
					durationMs: Math.max(0, this.lastCompletedAt - (this.lastStartedAt ?? this.lastCompletedAt)),
					succeeded: this.lastSucceeded === true,
					errorClass: this.lastErrorClass,
				});
			} catch {
				// Observability consumers must not affect the metadata retry policy.
			}
			this.fetchPromise = null;
		});

		await this.fetchPromise;
	}
}
