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
	private disposed = false;
	private readonly admissionAbortController = new AbortController();
	private fetchTimer: NodeJS.Timeout | null = null;
	/** Cadence anchor: only a successful fetch defers the next one. */
	private lastSucceededAt: number | null = null;
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
		if (this.disposed || this.fetchTimer) {
			return;
		}
		// Keep the cadence anchored to the last successful fetch: restarting the
		// policy (visibility or reconnect) must not push a due fetch a full interval out.
		const sinceSuccess = this.lastSucceededAt === null ? null : Date.now() - this.lastSucceededAt;
		const firstDelay =
			sinceSuccess === null ? REMOTE_FETCH_INTERVAL_MS : Math.max(0, REMOTE_FETCH_INTERVAL_MS - sinceSuccess);
		this.fetchTimer = setTimeout(() => {
			void this.performFetch();
			this.fetchTimer = setInterval(() => {
				void this.performFetch();
			}, REMOTE_FETCH_INTERVAL_MS);
			this.fetchTimer.unref();
		}, firstDelay);
		this.fetchTimer.unref();
	}

	stop(): void {
		if (!this.fetchTimer) {
			return;
		}
		// clearTimeout and clearInterval are interchangeable in Node.
		clearTimeout(this.fetchTimer);
		this.fetchTimer = null;
	}

	dispose(): void {
		this.disposed = true;
		this.admissionAbortController.abort();
		this.stop();
	}

	requestFetch(): void {
		if (this.disposed) return;
		// Respect the normal cadence instead of fetching on every call: visibility
		// transitions and reconnects both route here, and a reconnect within the
		// idle grace period must not force a redundant `git fetch`.
		if (this.lastSucceededAt !== null && Date.now() - this.lastSucceededAt < REMOTE_FETCH_INTERVAL_MS) {
			return;
		}
		void this.performFetch();
	}

	async waitForIdle(): Promise<void> {
		await this.fetchPromise;
	}

	private async performFetch(): Promise<void> {
		if (this.disposed) return;
		if (this.fetchPromise) {
			await this.fetchPromise;
			return;
		}

		let skipped = false;
		this.fetchPromise = (async () => {
			this.lastStartedAt = Date.now();
			this.lastErrorClass = null;
			try {
				const result = await this.deps.limitRemoteFetch(async () => {
					// A retired controller may still have a fetch waiting for admission.
					if (this.disposed) return null;
					return await runGit(this.deps.getProjectPath(), ["fetch", "--all", "--prune"], {
						env: createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" }),
						timeoutClass: "remoteFetch",
						signal: this.admissionAbortController.signal,
					});
				});
				if (result === null || (this.disposed && result.failureKind === "aborted")) {
					skipped = true;
					return;
				}
				if (result.ok) {
					this.lastSucceededAt = Date.now();
					if (!this.disposed) await this.deps.onFetchSucceeded();
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
			if (skipped) {
				this.fetchPromise = null;
				return;
			}
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
