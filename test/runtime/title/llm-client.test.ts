import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../../../src/title/llm-client";

const { acquireSlot, releaseSlot, resetRateLimiter, MAX_CONCURRENT, MAX_PER_MINUTE, WINDOW_MS } = _testing;

describe("llm-client rate limiter", () => {
	beforeEach(() => {
		resetRateLimiter();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		resetRateLimiter();
	});

	it("acquireSlot succeeds when under limits", () => {
		expect(acquireSlot()).toBe(true);
		expect(_testing.inFlight).toBe(1);
	});

	it("concurrent limit: acquireSlot returns false at MAX_CONCURRENT", () => {
		for (let i = 0; i < MAX_CONCURRENT; i++) {
			expect(acquireSlot()).toBe(true);
		}
		expect(_testing.inFlight).toBe(MAX_CONCURRENT);
		expect(acquireSlot()).toBe(false);
	});

	it("per-minute limit: acquireSlot returns false at MAX_PER_MINUTE", () => {
		// Acquire and immediately release to stay under concurrent limit
		// but accumulate timestamps in the per-minute window.
		for (let i = 0; i < MAX_PER_MINUTE; i++) {
			expect(acquireSlot()).toBe(true);
			releaseSlot();
		}
		// All slots released, but per-minute timestamps are still in the window.
		expect(_testing.inFlight).toBe(0);
		expect(_testing.callTimestamps.length).toBe(MAX_PER_MINUTE);
		expect(acquireSlot()).toBe(false);
	});

	it("releaseSlot decrements inFlight correctly", () => {
		acquireSlot();
		acquireSlot();
		expect(_testing.inFlight).toBe(2);

		releaseSlot();
		expect(_testing.inFlight).toBe(1);

		releaseSlot();
		expect(_testing.inFlight).toBe(0);
	});

	it("releaseSlot does not go below zero", () => {
		releaseSlot();
		expect(_testing.inFlight).toBe(0);
	});

	it("window expiry: timestamps older than WINDOW_MS are pruned", () => {
		let fakeNow = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

		// Fill up per-minute slots.
		for (let i = 0; i < MAX_PER_MINUTE; i++) {
			acquireSlot();
			releaseSlot();
		}
		expect(acquireSlot()).toBe(false);

		// Advance time past the window.
		fakeNow += WINDOW_MS + 1;

		// Old timestamps should be pruned, allowing new acquisitions.
		expect(acquireSlot()).toBe(true);
		expect(_testing.callTimestamps.length).toBe(1);
	});
});
