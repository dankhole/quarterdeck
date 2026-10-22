import { describe, expect, it } from "vitest";

import {
	GitProcessAdmissionAbortedError,
	GitProcessLimiter,
	GitProcessQueueTimeoutError,
} from "../../src/workdir/git-process-limiter";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("GitProcessLimiter", () => {
	it("admits foreground waiters before user actions and background work", async () => {
		const limiter = new GitProcessLimiter(2, 0);
		const blockers = [deferred(), deferred()];
		const order: string[] = [];
		const running = blockers.map((blocker) => limiter.run("background", () => blocker.promise));
		const queued = [
			limiter.run("background", async () => order.push("background")),
			limiter.run("userAction", async () => order.push("userAction")),
			limiter.run("foreground", async () => order.push("foreground")),
		];
		await flush();
		expect(limiter.getSnapshot()).toMatchObject({
			active: 2,
			queued: { foreground: 1, userAction: 1, background: 1 },
		});
		blockers[0]?.resolve();
		blockers[1]?.resolve();
		await Promise.all([...running, ...queued]);
		expect(order).toEqual(["foreground", "userAction", "background"]);
		expect(limiter.getSnapshot().active).toBe(0);
	});

	it("never lets long-running classes occupy reserved foreground slots", async () => {
		const limiter = new GitProcessLimiter(3, 1);
		const long = [deferred(), deferred()];
		const running = long.map((blocker) => limiter.run("userAction", () => blocker.promise));
		let backgroundStarted = false;
		const background = limiter.run("background", async () => {
			backgroundStarted = true;
		});
		await flush();
		expect(backgroundStarted).toBe(false);
		// The reserved slot still admits admission-path work immediately.
		await expect(limiter.run("foreground", async () => "admitted")).resolves.toBe("admitted");
		long[0]?.resolve();
		await background;
		expect(backgroundStarted).toBe(true);
		long[1]?.resolve();
		await Promise.all(running);
	});

	it("removes an aborted waiter from the queue without consuming a slot", async () => {
		const limiter = new GitProcessLimiter(1, 0);
		const blocker = deferred();
		const running = limiter.run("foreground", () => blocker.promise);
		const controller = new AbortController();
		const cancelled = limiter.run("background", async () => "ran", { signal: controller.signal });
		await flush();
		controller.abort();
		await expect(cancelled).rejects.toBeInstanceOf(GitProcessAdmissionAbortedError);
		expect(limiter.getSnapshot().queued.background).toBe(0);
		blocker.resolve();
		await running;
		await expect(limiter.run("background", async () => "next")).resolves.toBe("next");
		expect(limiter.getSnapshot().active).toBe(0);
	});

	it("fails a waiter that exceeds its maximum queue wait without starting it", async () => {
		const limiter = new GitProcessLimiter(1, 0);
		const blocker = deferred();
		const running = limiter.run("foreground", () => blocker.promise);
		let started = false;
		const waiting = limiter.run(
			"foreground",
			async () => {
				started = true;
			},
			{ maxWaitMs: 20 },
		);
		await expect(waiting).rejects.toBeInstanceOf(GitProcessQueueTimeoutError);
		expect(started).toBe(false);
		expect(limiter.getSnapshot().queued.foreground).toBe(0);
		blocker.resolve();
		await running;
		expect(limiter.getSnapshot().active).toBe(0);
	});

	it("is disabled by a non-finite limit", async () => {
		const limiter = new GitProcessLimiter(Number.POSITIVE_INFINITY, 2);
		const blockers = Array.from({ length: 20 }, () => deferred());
		let started = 0;
		const running = blockers.map((blocker) =>
			limiter.run("background", async () => {
				started += 1;
				await blocker.promise;
			}),
		);
		await flush();
		expect(started).toBe(20);
		for (const blocker of blockers) blocker.resolve();
		await Promise.all(running);
	});
});
