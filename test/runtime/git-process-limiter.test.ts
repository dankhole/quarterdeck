import { describe, expect, it, vi } from "vitest";

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

	it("rechecks cancellation between immediate admission and operation without stranding the next waiter", async () => {
		const limiter = new GitProcessLimiter(1);
		const controller = new AbortController();
		const operation = vi.fn(async () => "obsolete");
		const cancelled = limiter.run("background", operation, { signal: controller.signal });
		const next = limiter.run("background", async () => "next");
		controller.abort();
		await expect(cancelled).rejects.toBeInstanceOf(GitProcessAdmissionAbortedError);
		await expect(next).resolves.toBe("next");
		expect(operation).not.toHaveBeenCalled();
		expect(limiter.getSnapshot()).toMatchObject({
			active: 0,
			activeByPriority: { foreground: 0, userAction: 0, background: 0 },
			queued: { foreground: 0, userAction: 0, background: 0 },
		});
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

	it("lets background work bypass capped user actions without using foreground reservations", async () => {
		const limiter = new GitProcessLimiter(8, 2, { userActionLimit: 3 });
		const userBlockers = Array.from({ length: 4 }, () => deferred());
		const backgroundBlockers = Array.from({ length: 4 }, () => deferred());
		const foregroundBlockers = Array.from({ length: 2 }, () => deferred());
		const running = userBlockers.map((blocker) => limiter.run("userAction", () => blocker.promise));
		running.push(...backgroundBlockers.map((blocker) => limiter.run("background", () => blocker.promise)));
		running.push(...foregroundBlockers.map((blocker) => limiter.run("foreground", () => blocker.promise)));
		await flush();
		expect(limiter.getSnapshot()).toMatchObject({
			active: 8,
			userActionLimit: 3,
			activeByPriority: { foreground: 2, userAction: 3, background: 3 },
			queued: { foreground: 0, userAction: 1, background: 1 },
		});
		for (const blocker of [...userBlockers, ...backgroundBlockers, ...foregroundBlockers]) blocker.resolve();
		await Promise.all(running);
		expect(limiter.getSnapshot().activeByPriority).toEqual({ foreground: 0, userAction: 0, background: 0 });
	});

	it("hands a released user-action slot to the oldest user action before background", async () => {
		const limiter = new GitProcessLimiter(8, 2, { userActionLimit: 3 });
		const blockers = Array.from({ length: 6 }, () => deferred());
		const running = blockers.map((blocker, index) =>
			limiter.run(index < 3 ? "userAction" : "background", () => blocker.promise),
		);
		const order: string[] = [];
		const queuedBlockers = Array.from({ length: 3 }, () => deferred());
		const queued = ["first", "second", "background"].map((name, index) =>
			limiter.run(index < 2 ? "userAction" : "background", async () => {
				order.push(name);
				await queuedBlockers[index]?.promise;
			}),
		);
		blockers[0]?.resolve();
		await flush();
		expect(order).toEqual(["first"]);
		queuedBlockers[0]?.resolve();
		await flush();
		expect(order).toEqual(["first", "second"]);
		queuedBlockers[1]?.resolve();
		await flush();
		expect(order).toEqual(["first", "second", "background"]);
		for (const blocker of [...blockers, ...queuedBlockers]) blocker.resolve();
		await Promise.all([...running, ...queued]);
	});

	it.each(["abort", "deadline"] as const)(
		"removes a capped waiter on %s without blocking background",
		async (mode) => {
			vi.useFakeTimers();
			const limiter = new GitProcessLimiter(8, 2, { userActionLimit: 3 });
			const blockers = Array.from({ length: 3 }, () => deferred());
			const running = blockers.map((blocker) => limiter.run("userAction", () => blocker.promise));
			const controller = new AbortController();
			let started = false;
			const waiting = limiter.run(
				"userAction",
				async () => {
					started = true;
				},
				{
					signal: controller.signal,
					maxWaitMs: 20,
				},
			);
			const rejected = expect(waiting).rejects.toBeInstanceOf(
				mode === "abort" ? GitProcessAdmissionAbortedError : GitProcessQueueTimeoutError,
			);
			try {
				await expect(limiter.run("background", async () => "admitted")).resolves.toBe("admitted");
				if (mode === "abort") controller.abort();
				else await vi.advanceTimersByTimeAsync(20);
				await rejected;
				expect(started).toBe(false);
				expect(limiter.getSnapshot()).toMatchObject({ active: 3, queued: { userAction: 0 } });
			} finally {
				for (const blocker of blockers) blocker.resolve();
				await Promise.all(running);
				vi.useRealTimers();
			}
		},
	);

	it.each([
		{ cap: 0, expected: 1 },
		{ cap: -3, expected: 1 },
		{ cap: 0.9, expected: 1 },
		{ cap: 2.9, expected: 2 },
		{ cap: 20, expected: 6 },
		{ cap: undefined, expected: null },
		{ cap: Number.NaN, expected: null },
		{ cap: Number.POSITIVE_INFINITY, expected: null },
	])("clamps finite user-action cap $cap and leaves non-finite caps disabled", ({ cap, expected }) => {
		expect(new GitProcessLimiter(8, 2, { userActionLimit: cap }).getSnapshot().userActionLimit).toBe(expected);
	});

	it.each([
		{ limit: 1, reserved: 1 },
		{ limit: 8, reserved: 8 },
	])("caps against normalized reservations for limit $limit and reserved $reserved", async ({ limit, reserved }) => {
		const limiter = new GitProcessLimiter(limit, reserved, { userActionLimit: 3 });
		expect(limiter.getSnapshot()).toMatchObject({ reservedForegroundSlots: limit - 1, userActionLimit: 1 });
		const blocker = deferred();
		const running = limiter.run("userAction", () => blocker.promise);
		const next = limiter.run("userAction", async () => "admitted");
		await flush();
		expect(limiter.getSnapshot()).toMatchObject({ active: 1, queued: { userAction: 1 } });
		blocker.resolve();
		await running;
		await expect(next).resolves.toBe("admitted");
		expect(limiter.getSnapshot()).toMatchObject({ active: 0, activeByPriority: { userAction: 0 } });
	});

	it("releases per-class accounting when an operation fails", async () => {
		const limiter = new GitProcessLimiter(8, 2, { userActionLimit: 3 });
		await expect(
			limiter.run("userAction", async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow("failed");
		expect(limiter.getSnapshot()).toMatchObject({ active: 0, activeByPriority: { userAction: 0 } });
	});

	it.each([Number.POSITIVE_INFINITY, 0, -1])(
		"bypasses the user-action cap when limit %s is disabled",
		async (limit) => {
			const limiter = new GitProcessLimiter(limit, 2, { userActionLimit: 3 });
			const blockers = Array.from({ length: 10 }, () => deferred());
			let started = 0;
			const running = blockers.map((blocker) =>
				limiter.run("userAction", async () => {
					started += 1;
					await blocker.promise;
				}),
			);
			await flush();
			expect(started).toBe(10);
			expect(limiter.getSnapshot().active).toBe(0);
			for (const blocker of blockers) blocker.resolve();
			await Promise.all(running);
		},
	);

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
