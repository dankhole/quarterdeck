import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitRepositoryProbeResult } from "../../../src/projects/git-repository-probe";
import { GitRepositoryProbeCache } from "../../../src/projects/git-repository-probe-cache";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("GitRepositoryProbeCache", () => {
	it("shares one in-flight probe and reuses a definite answer within the TTL", async () => {
		let now = 1_000;
		const gate = deferred<GitRepositoryProbeResult>();
		const probe = vi.fn(() => gate.promise);
		const cache = new GitRepositoryProbeCache({ probe, ttlMs: 10_000, now: () => now });
		const first = cache.probe("p", "/repo");
		const second = cache.probe("p", "/repo", { maxAgeMs: 0 });
		gate.resolve("repository");
		await expect(Promise.all([first, second])).resolves.toEqual(["repository", "repository"]);
		expect(probe).toHaveBeenCalledTimes(1);

		now += 5_000;
		await expect(cache.probe("p", "/repo")).resolves.toBe("repository");
		expect(probe).toHaveBeenCalledTimes(1);

		probe.mockResolvedValueOnce("not_repository");
		await expect(cache.probe("p", "/repo", { maxAgeMs: 0 })).resolves.toBe("not_repository");
		expect(probe).toHaveBeenCalledTimes(2);

		now += 10_000;
		probe.mockResolvedValueOnce("repository");
		await expect(cache.probe("p", "/repo")).resolves.toBe("repository");
		expect(probe).toHaveBeenCalledTimes(3);
	});

	it("never reuses an answer for another path and drops answers after invalidation", async () => {
		const probe = vi.fn(async (): Promise<GitRepositoryProbeResult> => "repository");
		const cache = new GitRepositoryProbeCache({ probe, ttlMs: 10_000 });
		await cache.probe("p", "/old");
		await cache.probe("p", "/new");
		expect(probe).toHaveBeenCalledTimes(2);

		const gate = deferred<GitRepositoryProbeResult>();
		probe.mockImplementationOnce(() => gate.promise);
		const stale = cache.probe("p", "/new", { maxAgeMs: 0 });
		cache.invalidate("p");
		gate.resolve("not_repository");
		await expect(stale).resolves.toBe("not_repository");
		// The invalidated probe's answer is not cached.
		await expect(cache.probe("p", "/new")).resolves.toBe("repository");
		expect(probe).toHaveBeenCalledTimes(4);
	});

	it("a zero TTL disables reuse without disabling single-flight", async () => {
		const gate = deferred<GitRepositoryProbeResult>();
		const probe = vi.fn(() => gate.promise);
		const cache = new GitRepositoryProbeCache({ probe, ttlMs: 0 });
		const joined = Promise.all([cache.probe("p", "/repo"), cache.probe("p", "/repo")]);
		gate.resolve("repository");
		await joined;
		probe.mockResolvedValue("repository");
		await cache.probe("p", "/repo");
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("re-probes an indeterminate answer on a bounded backoff and reports the result", async () => {
		vi.useFakeTimers();
		const results: GitRepositoryProbeResult[] = ["indeterminate", "indeterminate", "indeterminate", "repository"];
		const probe = vi.fn(async () => results.shift() ?? "repository");
		const observed: GitRepositoryProbeResult[] = [];
		const cache = new GitRepositoryProbeCache({
			probe,
			ttlMs: 10_000,
			retryDelaysMs: [100, 200],
			onRetryObserved: (_projectId, result) => observed.push(result),
		});
		await expect(cache.probe("p", "/repo")).resolves.toBe("indeterminate");
		// The indeterminate answer is held only until the next scheduled re-probe.
		await expect(cache.probe("p", "/repo")).resolves.toBe("indeterminate");
		expect(probe).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(probe).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(200);
		expect(probe).toHaveBeenCalledTimes(3);
		// Retries are exhausted; no further timers fire.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(probe).toHaveBeenCalledTimes(3);
		expect(observed).toEqual(["indeterminate", "indeterminate"]);
		// A later demand probe that answers definitively resets the schedule.
		await expect(cache.probe("p", "/repo")).resolves.toBe("repository");
	});

	it("close cancels scheduled re-probes", async () => {
		vi.useFakeTimers();
		const probe = vi.fn(async (): Promise<GitRepositoryProbeResult> => "indeterminate");
		const cache = new GitRepositoryProbeCache({ probe, retryDelaysMs: [100] });
		await cache.probe("p", "/repo");
		cache.close();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(probe).toHaveBeenCalledTimes(1);
		await cache.waitForIdle();
	});
});
