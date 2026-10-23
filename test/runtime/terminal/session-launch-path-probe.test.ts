import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessMock = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>());
vi.mock("node:fs/promises", () => ({ access: accessMock }));

import { probeSessionLaunchPaths } from "../../../src/terminal/session-launch-path-probe";

interface HeldAccess {
	path: string;
	resolve: () => void;
	reject: (error: Error) => void;
}

let held: HeldAccess[];

function holdAccesses(): void {
	accessMock.mockImplementation(
		(path) =>
			new Promise<void>((resolve, reject) => {
				held.push({ path, resolve, reject });
			}),
	);
}

function settle(path: string, exists = true): void {
	const operation = held.find((entry) => entry.path === path);
	if (!operation) throw new Error(`No active access for ${path}`);
	if (exists) operation.resolve();
	else operation.reject(new Error("unavailable"));
}

describe("session launch path probe", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		held = [];
		accessMock.mockReset();
		accessMock.mockResolvedValue(undefined);
	});

	afterEach(async () => {
		// Expire consumers before releasing OS operations, just as shutdown
		// cannot cancel access itself. No abandoned queue may issue later I/O.
		await vi.advanceTimersByTimeAsync(2_000);
		for (const operation of held) operation.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
	});

	it("reports access success and all filesystem errors without caching results", async () => {
		accessMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("EACCES"));
		expect(await probeSessionLaunchPaths(["/exists", "/denied"])).toEqual(
			new Map([
				["/exists", true],
				["/denied", false],
			]),
		);
		accessMock.mockRejectedValueOnce(new Error("ENOENT"));
		expect(await probeSessionLaunchPaths(["/exists"])).toEqual(new Map([["/exists", false]]));
		expect(accessMock).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("caps actual access concurrency at two and deduplicates paths within a batch", async () => {
		holdAccesses();
		const result = probeSessionLaunchPaths(["/a", "/a", "/b", "/c"]);
		expect(accessMock.mock.calls).toEqual([["/a"], ["/b"]]);
		settle("/a");
		await vi.advanceTimersByTimeAsync(0);
		expect(accessMock.mock.calls).toEqual([["/a"], ["/b"], ["/c"]]);
		settle("/b");
		settle("/c");
		expect(await result).toEqual(
			new Map([
				["/a", true],
				["/b", true],
				["/c", true],
			]),
		);
	});

	it("shares a queued path admitted after both batches captured their identities", async () => {
		holdAccesses();
		const occupied = probeSessionLaunchPaths(["/busy-a", "/busy-b"]);
		const first = probeSessionLaunchPaths(["/shared"]);
		const second = probeSessionLaunchPaths(["/shared"]);
		settle("/busy-a");
		await vi.advanceTimersByTimeAsync(0);
		expect(accessMock.mock.calls).toEqual([["/busy-a"], ["/busy-b"], ["/shared"]]);
		settle("/shared");
		expect(await first).toEqual(new Map([["/shared", true]]));
		expect(await second).toEqual(new Map([["/shared", true]]));
		settle("/busy-b");
		await occupied;
	});

	it("does not give a new batch an already-started access result", async () => {
		holdAccesses();
		const oldBatch = probeSessionLaunchPaths(["/same-path"]);
		expect(await probeSessionLaunchPaths(["/same-path"])).toEqual(new Map([["/same-path", null]]));
		expect(accessMock).toHaveBeenCalledTimes(1);
		settle("/same-path", false);
		expect(await oldBatch).toEqual(new Map([["/same-path", false]]));

		accessMock.mockResolvedValue(undefined);
		expect(await probeSessionLaunchPaths(["/same-path"])).toEqual(new Map([["/same-path", true]]));
		expect(accessMock).toHaveBeenCalledTimes(2);
	});

	it("returns unknown at deadline and removes expired queue entries under repeated path churn", async () => {
		holdAccesses();
		const occupied = probeSessionLaunchPaths(["/hung-a", "/hung-b"], 20);
		for (let batch = 0; batch < 10; batch += 1) {
			const paths = Array.from({ length: 100 }, (_, index) => `/queued-${batch}-${index}`);
			const pending = probeSessionLaunchPaths(paths, 20);
			await vi.advanceTimersByTimeAsync(20);
			expect([...(await pending).values()]).toEqual(Array(100).fill(null));
			expect(accessMock).toHaveBeenCalledTimes(2);
		}
		expect(await occupied).toEqual(
			new Map([
				["/hung-a", null],
				["/hung-b", null],
			]),
		);
		settle("/hung-a", false);
		settle("/hung-b");
		await vi.advanceTimersByTimeAsync(0);
		expect(accessMock).toHaveBeenCalledTimes(2);

		accessMock.mockResolvedValue(undefined);
		expect(await probeSessionLaunchPaths(["/queued-0-0"])).toEqual(new Map([["/queued-0-0", true]]));
		expect(accessMock).toHaveBeenCalledTimes(3);
	});

	it("skips wall-clock-expired queue entries even before the deadline timer callback runs", async () => {
		holdAccesses();
		const occupied = probeSessionLaunchPaths(["/busy-a", "/busy-b"], 20);
		const queued = probeSessionLaunchPaths(["/expired-a", "/expired-b"], 20);
		vi.setSystemTime(Date.now() + 21);
		settle("/busy-a");
		expect(await queued).toEqual(
			new Map([
				["/expired-a", null],
				["/expired-b", null],
			]),
		);
		expect(accessMock.mock.calls).toEqual([["/busy-a"], ["/busy-b"]]);
		settle("/busy-b");
		expect([...(await occupied).values()]).toEqual([null, null]);
	});

	it("canceling one expired consumer preserves another consumer of a queued check", async () => {
		holdAccesses();
		const occupied = probeSessionLaunchPaths(["/busy-a", "/busy-b"]);
		const expired = probeSessionLaunchPaths(["/shared"], 10);
		const current = probeSessionLaunchPaths(["/shared"], 50);
		await vi.advanceTimersByTimeAsync(10);
		expect(await expired).toEqual(new Map([["/shared", null]]));
		settle("/busy-a");
		await vi.advanceTimersByTimeAsync(0);
		expect(accessMock.mock.calls).toEqual([["/busy-a"], ["/busy-b"], ["/shared"]]);
		settle("/shared", false);
		expect(await current).toEqual(new Map([["/shared", false]]));
		settle("/busy-b");
		await occupied;
	});

	it("empty batches need neither filesystem work nor a deadline timer", async () => {
		expect(await probeSessionLaunchPaths([])).toEqual(new Map());
		expect(accessMock).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
