import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopTransitionFreeze } from "./desktop-transition-freeze";

describe("final native transition seal", () => {
	afterEach(() => vi.useRealTimers());
	it("holds a committed navigation beyond its admission deadline and refuses replacement seals", () => {
		vi.useFakeTimers();
		const freeze = new DesktopTransitionFreeze(vi.fn());
		const request = {
			requestId: "navigation",
			runtimeGeneration: "current",
			reason: "reload" as const,
			freezeUntil: Date.now() + 30_000,
			freezeMode: "navigation" as const,
		};
		expect(freeze.seal(request)).toBe(true);
		vi.advanceTimersByTime(60_000);
		expect(freeze.active).toBe(true);
		expect(
			freeze.seal({
				requestId: "replacement",
				runtimeGeneration: "current",
				reason: "quit",
				freezeUntil: Date.now() + 1_000,
			}),
		).toBe(false);
		freeze.acceptRelease({ requestId: "replacement", runtimeGeneration: "current" });
		freeze.acceptRelease({ requestId: "navigation", runtimeGeneration: "stale" });
		const input = new Event("beforeinput", { cancelable: true, bubbles: true });
		document.body.dispatchEvent(input);
		expect(input.defaultPrevented).toBe(true);
		freeze.acceptRelease({ requestId: "navigation", runtimeGeneration: "current" });
		expect(freeze.active).toBe(false);
		const resumed = new Event("beforeinput", { cancelable: true, bubbles: true });
		document.body.dispatchEvent(resumed);
		expect(resumed.defaultPrevented).toBe(false);
	});
	it("refuses late or malformed navigation holds without freezing the document", () => {
		const freeze = new DesktopTransitionFreeze(vi.fn());
		const request = {
			requestId: "navigation",
			runtimeGeneration: "current",
			reason: "reload" as const,
			freezeMode: "navigation" as const,
		};
		expect(freeze.seal({ ...request, freezeUntil: Date.now() - 1 })).toBe(false);
		expect(freeze.seal({ ...request, freezeUntil: Date.now() + 30_001 })).toBe(false);
		expect(freeze.seal(request)).toBe(false);
		expect(freeze.seal({ ...request, reason: "quit", freezeUntil: Date.now() + 1_000 })).toBe(false);
		expect(freeze.active).toBe(false);
	});
	it("freezes input before acknowledgement and releases only the matching request", () => {
		const changed = vi.fn();
		const freeze = new DesktopTransitionFreeze(changed);
		expect(
			freeze.seal({
				requestId: "final",
				runtimeGeneration: "current",
				reason: "quit",
				freezeUntil: Date.now() + 1_000,
			}),
		).toBe(true);
		const input = new Event("beforeinput", { cancelable: true, bubbles: true });
		document.body.dispatchEvent(input);
		expect(input.defaultPrevented).toBe(true);
		freeze.acceptRelease({ requestId: "other", runtimeGeneration: "current" });
		expect(freeze.active).toBe(true);
		freeze.acceptRelease({ requestId: "final", runtimeGeneration: "stale" });
		expect(freeze.active).toBe(true);
		freeze.acceptRelease({ requestId: "final", runtimeGeneration: "current" });
		expect(freeze.active).toBe(false);
		const resumed = new Event("beforeinput", { cancelable: true, bubbles: true });
		document.body.dispatchEvent(resumed);
		expect(resumed.defaultPrevented).toBe(false);
	});
	it("expires a lost main-process seal and refuses unbounded or expired leases", () => {
		vi.useFakeTimers();
		const freeze = new DesktopTransitionFreeze(vi.fn());
		const request = { requestId: "final", runtimeGeneration: "current", reason: "reload" as const };
		expect(freeze.seal({ ...request, freezeUntil: Date.now() - 1 })).toBe(false);
		expect(freeze.seal({ ...request, freezeUntil: Date.now() + 30_001 })).toBe(false);
		expect(freeze.seal({ ...request, freezeUntil: Date.now() + 500 })).toBe(true);
		vi.advanceTimersByTime(500);
		expect(freeze.active).toBe(false);
		freeze.release();
	});
});
