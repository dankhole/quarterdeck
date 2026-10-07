import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeNotificationPresentationLease } from "../../../src/server/runtime-notification-presentation";

describe("socket-bound notification presentation", () => {
	afterEach(() => vi.useRealTimers());
	it("rearms an early expiry callback without extending the ownership deadline", () => {
		vi.useFakeTimers();
		let now = 0;
		const changed = vi.fn();
		const lease = new RuntimeNotificationPresentationLease(randomUUID(), changed, () => now);
		lease.acquire({});
		now = 14_999;
		vi.advanceTimersByTime(15_000);
		expect(changed).toHaveBeenCalledTimes(1);
		now = 15_000;
		vi.advanceTimersByTime(1);
		expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ owner: "browser" }));
		lease.dispose();
	});
	it("expires a paused owner even when the wall clock moves backwards", () => {
		vi.useFakeTimers();
		const lease = new RuntimeNotificationPresentationLease(randomUUID(), vi.fn());
		lease.acquire({});
		vi.setSystemTime(Date.now() - 86_400_000);
		vi.advanceTimersByTime(15_000);
		expect(lease.getState().owner).toBe("browser");
		expect(lease.acquire({})).toBe(true);
		lease.dispose();
	});
	it("admits one socket and requires its generation and current epoch to renew", () => {
		vi.useFakeTimers();
		const generation = randomUUID();
		const changed = vi.fn();
		const lease = new RuntimeNotificationPresentationLease(generation, changed);
		const first = {},
			second = {};
		const initial = lease.getState();
		expect(lease.acquire(first)).toBe(true);
		const owned = lease.getState();
		if (!owned.epoch) throw new Error("Expected an ownership epoch");
		expect(owned).toMatchObject({ owner: "desktop", runtimeGeneration: generation });
		expect(owned.epoch).not.toBe(initial.epoch);
		expect(lease.acquire(second)).toBe(false);
		expect(lease.renew(first, randomUUID(), owned.epoch)).toBe(false);
		expect(lease.renew(first, generation, randomUUID())).toBe(false);
		expect(lease.renew(second, generation, owned.epoch)).toBe(false);
		lease.release(second);
		vi.advanceTimersByTime(10_000);
		expect(lease.renew(first, generation, owned.epoch)).toBe(true);
		vi.advanceTimersByTime(10_000);
		expect(lease.getState()).toEqual(owned);
		vi.advanceTimersByTime(5_000);
		const expired = lease.getState();
		if (!expired.epoch) throw new Error("Expected a release epoch");
		expect(expired.owner).toBe("browser");
		expect(expired.epoch).not.toBe(owned.epoch);
		expect(lease.renew(first, generation, owned.epoch)).toBe(false);
		expect(lease.renew(second, generation, expired.epoch)).toBe(true);
		expect(changed).toHaveBeenCalledTimes(3);
		lease.dispose();
	});
	it("releases the selected socket and disposes without broadcasting or reacquiring", () => {
		vi.useFakeTimers();
		const changed = vi.fn();
		const lease = new RuntimeNotificationPresentationLease(randomUUID(), changed);
		const socket = {};
		lease.acquire(socket);
		lease.release(socket);
		expect(lease.getState().owner).toBe("browser");
		lease.acquire(socket);
		lease.dispose();
		vi.advanceTimersByTime(30_000);
		expect(changed).toHaveBeenCalledTimes(3);
		expect(lease.acquire(socket)).toBe(false);
	});
});
