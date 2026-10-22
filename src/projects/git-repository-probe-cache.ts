import { areFileSystemPathsEqual } from "../core/path-comparison";
import type { GitRepositoryProbeResult } from "./git-repository-probe";

/**
 * How long a definite Git root observation may satisfy availability callers
 * that accept cached results. Zero disables reuse: every such caller probes
 * again, while concurrent callers still share one in-flight probe.
 */
export const PROJECT_GIT_PROBE_CACHE_TTL_MS = 10_000;
/** Background re-probe schedule after Git could not answer; bounded by its length. */
export const PROJECT_GIT_PROBE_INDETERMINATE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000];

export interface GitRepositoryProbeCacheOptions {
	probe: (path: string, projectId: string) => Promise<GitRepositoryProbeResult>;
	ttlMs?: number;
	retryDelaysMs?: readonly number[];
	now?: () => number;
	/** Called after a scheduled background re-probe completes for the same path. */
	onRetryObserved?: (projectId: string, result: GitRepositoryProbeResult) => void;
}

export interface GitRepositoryProbeReadOptions {
	/** Oldest acceptable cached result; zero forces a probe (or joins one in flight). */
	maxAgeMs?: number;
	/**
	 * Accept the last answer for this path however old it is; probe only when none
	 * exists. For readers such as project-list rebuilds that must not spawn Git.
	 */
	allowStale?: boolean;
}

interface CacheEntry {
	path: string;
	result: GitRepositoryProbeResult;
	observedAt: number;
	validUntil: number;
}

interface InFlightProbe {
	path: string;
	generation: number;
	promise: Promise<GitRepositoryProbeResult>;
}

interface RetryState {
	attempt: number;
	timer: NodeJS.Timeout | null;
}

/**
 * Policy layer around the per-project Git root probe: one in-flight probe per
 * project, a short reuse window, and bounded background re-probes after an
 * indeterminate result. The probe remains the only source of the answer.
 */
export class GitRepositoryProbeCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly inFlight = new Map<string, InFlightProbe>();
	private readonly generations = new Map<string, number>();
	private readonly retries = new Map<string, RetryState>();
	private readonly ttlMs: number;
	private readonly retryDelaysMs: readonly number[];
	private readonly now: () => number;
	private closed = false;

	constructor(private readonly options: GitRepositoryProbeCacheOptions) {
		this.ttlMs = Math.max(0, options.ttlMs ?? PROJECT_GIT_PROBE_CACHE_TTL_MS);
		this.retryDelaysMs = options.retryDelaysMs ?? PROJECT_GIT_PROBE_INDETERMINATE_RETRY_DELAYS_MS;
		this.now = options.now ?? Date.now;
	}

	async probe(
		projectId: string,
		path: string,
		options: GitRepositoryProbeReadOptions = {},
	): Promise<GitRepositoryProbeResult> {
		const maxAgeMs = options.maxAgeMs ?? Number.POSITIVE_INFINITY;
		const entry = this.entries.get(projectId);
		if (options.allowStale && entry && areFileSystemPathsEqual(entry.path, path)) return entry.result;
		const now = this.now();
		if (
			entry &&
			now < entry.validUntil &&
			now - entry.observedAt < maxAgeMs &&
			areFileSystemPathsEqual(entry.path, path)
		) {
			return entry.result;
		}
		return await this.run(projectId, path);
	}

	/** Drops reuse for a project after a location change or removal. */
	invalidate(projectId: string): void {
		this.generations.set(projectId, this.generation(projectId) + 1);
		this.entries.delete(projectId);
		this.inFlight.delete(projectId);
		this.cancelRetry(projectId);
	}

	close(): void {
		this.closed = true;
		for (const projectId of Array.from(this.retries.keys())) this.cancelRetry(projectId);
	}

	async waitForIdle(): Promise<void> {
		while (this.inFlight.size > 0) {
			await Promise.allSettled(Array.from(this.inFlight.values(), (flight) => flight.promise));
		}
	}

	private run(projectId: string, path: string): Promise<GitRepositoryProbeResult> {
		const generation = this.generation(projectId);
		const existing = this.inFlight.get(projectId);
		if (existing && existing.generation === generation && areFileSystemPathsEqual(existing.path, path)) {
			return existing.promise;
		}
		const promise = this.options.probe(path, projectId).then((result) => {
			if (this.generation(projectId) === generation) this.store(projectId, path, result);
			return result;
		});
		const flight: InFlightProbe = { path, generation, promise };
		this.inFlight.set(projectId, flight);
		const clear = () => {
			if (this.inFlight.get(projectId) === flight) this.inFlight.delete(projectId);
		};
		promise.then(clear, clear);
		return promise;
	}

	private generation(projectId: string): number {
		return this.generations.get(projectId) ?? 0;
	}

	private store(projectId: string, path: string, result: GitRepositoryProbeResult): void {
		const observedAt = this.now();
		if (result !== "indeterminate") {
			this.cancelRetry(projectId);
			this.entries.set(projectId, { path, result, observedAt, validUntil: observedAt + this.ttlMs });
			return;
		}
		const retry = this.retries.get(projectId) ?? { attempt: 0, timer: null };
		this.retries.set(projectId, retry);
		const delay = this.retryDelaysMs[retry.attempt];
		// Hold the indeterminate answer until the next re-probe, never past the TTL.
		this.entries.set(projectId, {
			path,
			result,
			observedAt,
			validUntil: observedAt + Math.min(this.ttlMs, delay ?? this.ttlMs),
		});
		if (this.closed || delay === undefined || retry.timer) return;
		retry.attempt += 1;
		retry.timer = setTimeout(() => {
			retry.timer = null;
			if (this.closed || this.retries.get(projectId) !== retry) return;
			this.run(projectId, path).then(
				(next) => {
					if (this.closed) return;
					try {
						this.options.onRetryObserved?.(projectId, next);
					} catch {
						// Observers cannot change the probe policy.
					}
				},
				() => undefined,
			);
		}, delay);
		retry.timer.unref?.();
	}

	private cancelRetry(projectId: string): void {
		const retry = this.retries.get(projectId);
		if (retry?.timer) clearTimeout(retry.timer);
		this.retries.delete(projectId);
	}
}
