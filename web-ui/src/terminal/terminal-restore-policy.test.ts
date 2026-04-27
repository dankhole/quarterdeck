import { describe, expect, it } from "vitest";

import { shouldSkipEmptyRestoreSnapshot } from "@/terminal/terminal-restore-policy";

describe("shouldSkipEmptyRestoreSnapshot", () => {
	it("skips an empty restore when the terminal already has content", () => {
		expect(shouldSkipEmptyRestoreSnapshot("", ["", "Final: Done"])).toBe(true);
	});

	it("allows an empty restore when the terminal is also empty", () => {
		expect(shouldSkipEmptyRestoreSnapshot("", ["", "   "])).toBe(false);
	});

	it("allows non-empty restore snapshots", () => {
		expect(shouldSkipEmptyRestoreSnapshot("restored output", ["Final: Done"])).toBe(false);
	});
});
