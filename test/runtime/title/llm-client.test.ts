import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing, sanitizeLlmResponse } from "../../../src/title/llm-client";

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

describe("sanitizeLlmResponse", () => {
	it("returns clean text unchanged", () => {
		expect(sanitizeLlmResponse("Fix Auth Bug")).toBe("Fix Auth Bug");
	});

	it("strips outer double quotes", () => {
		expect(sanitizeLlmResponse('"Fix Auth Bug"')).toBe("Fix Auth Bug");
	});

	it("strips outer single quotes", () => {
		expect(sanitizeLlmResponse("'Fix Auth Bug'")).toBe("Fix Auth Bug");
	});

	it("strips 'Title:' prefix", () => {
		expect(sanitizeLlmResponse("Title: Fix Auth Bug")).toBe("Fix Auth Bug");
	});

	it("strips 'Branch name:' prefix", () => {
		expect(sanitizeLlmResponse("Branch name: fix-auth-bug")).toBe("fix-auth-bug");
	});

	it("strips 'Summary:' prefix", () => {
		expect(sanitizeLlmResponse("Summary: Added auth middleware")).toBe("Added auth middleware");
	});

	it("strips 'Here\\'s a title:' preamble", () => {
		expect(sanitizeLlmResponse("Here's a title: Fix Auth Bug")).toBe("Fix Auth Bug");
	});

	it("strips 'Here is the summary:' preamble", () => {
		expect(sanitizeLlmResponse("Here is the summary: Added auth middleware")).toBe("Added auth middleware");
	});

	it("strips 'Sure, here\\'s' preamble", () => {
		expect(sanitizeLlmResponse("Sure, here's: Fix Auth Bug")).toBe("Fix Auth Bug");
	});

	it("strips 'Certainly!' preamble", () => {
		expect(sanitizeLlmResponse("Certainly! Fix Auth Bug")).toBe("Fix Auth Bug");
	});

	it("strips trailing 'let me know' noise", () => {
		expect(sanitizeLlmResponse("Fix Auth Bug. Let me know if you'd like something different.")).toBe("Fix Auth Bug.");
	});

	it("strips trailing 'would you like' noise", () => {
		expect(sanitizeLlmResponse("Fix Auth Bug. Would you like me to change it?")).toBe("Fix Auth Bug.");
	});

	it("rejects question responses", () => {
		expect(sanitizeLlmResponse("What kind of title would you like?")).toBeNull();
	});

	it("rejects refusal responses", () => {
		expect(sanitizeLlmResponse("I can't generate a title without more context")).toBeNull();
	});

	it("rejects 'I need more information' responses", () => {
		expect(sanitizeLlmResponse("I need more information about the task")).toBeNull();
	});

	it("rejects 'Could you provide' responses", () => {
		expect(sanitizeLlmResponse("Could you provide more details?")).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(sanitizeLlmResponse("")).toBeNull();
	});

	it("returns null for whitespace-only input", () => {
		expect(sanitizeLlmResponse("   ")).toBeNull();
	});

	it("handles combined preamble + quotes", () => {
		expect(sanitizeLlmResponse('Title: "Fix Auth Bug"')).toBe("Fix Auth Bug");
	});
});
