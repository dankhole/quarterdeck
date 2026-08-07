import { describe, expect, it } from "vitest";

import { shouldForceResizeBeforeRestore, shouldSkipEmptyRestoreSnapshot } from "@/terminal/terminal-restore-policy";

describe("shouldForceResizeBeforeRestore", () => {
	it("forces current geometry for Claude and Codex restores", () => {
		expect(shouldForceResizeBeforeRestore("claude")).toBe(true);
		expect(shouldForceResizeBeforeRestore("codex")).toBe(true);
	});

	it("leaves other and unknown terminal types on normal restore behavior", () => {
		expect(shouldForceResizeBeforeRestore("pi")).toBe(false);
		expect(shouldForceResizeBeforeRestore(null)).toBe(false);
	});
});

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
