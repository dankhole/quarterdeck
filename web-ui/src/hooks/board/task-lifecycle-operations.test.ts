import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHORITATIVE_REVISION_WAIT_TIMEOUT_MS, waitForAuthoritativeRevision } from "./task-lifecycle-operations";

describe("waitForAuthoritativeRevision", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns immediately when a revision is already available", async () => {
		const getAuthoritativeRevision = vi.fn(() => 7);
		const resultPromise = waitForAuthoritativeRevision(getAuthoritativeRevision);
		await expect(resultPromise).resolves.toBe(7);
		expect(getAuthoritativeRevision).toHaveBeenCalledTimes(1);
	});

	it("polls until a revision becomes available, within the bounded window", async () => {
		const getAuthoritativeRevision = vi.fn<() => number | null>().mockReturnValueOnce(null).mockReturnValue(3);
		const resultPromise = waitForAuthoritativeRevision(getAuthoritativeRevision);
		await vi.advanceTimersByTimeAsync(250);
		await expect(resultPromise).resolves.toBe(3);
	});

	it("gives up and returns null after the bounded timeout elapses", async () => {
		const getAuthoritativeRevision = vi.fn(() => null);
		const resultPromise = waitForAuthoritativeRevision(getAuthoritativeRevision);
		await vi.advanceTimersByTimeAsync(AUTHORITATIVE_REVISION_WAIT_TIMEOUT_MS);
		await expect(resultPromise).resolves.toBeNull();
	});

	it("respects an explicit shorter timeout", async () => {
		const getAuthoritativeRevision = vi.fn(() => null);
		const resultPromise = waitForAuthoritativeRevision(getAuthoritativeRevision, 500);
		await vi.advanceTimersByTimeAsync(500);
		await expect(resultPromise).resolves.toBeNull();
	});
});
