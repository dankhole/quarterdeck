import { describe, expect, it } from "vitest";
import { shouldRejectLegacyRuntimeStreamClient } from "../../../src/core/build-identity";

describe("shouldRejectLegacyRuntimeStreamClient", () => {
	it("rejects production stream clients that predate browser build identity", () => {
		expect(shouldRejectLegacyRuntimeStreamClient("production-build", null)).toBe(true);
		expect(shouldRejectLegacyRuntimeStreamClient("production-build", "  ")).toBe(true);
	});

	it("admits identified clients so the browser can resolve a mismatch from the snapshot", () => {
		expect(shouldRejectLegacyRuntimeStreamClient("production-build", "older-browser-build")).toBe(false);
	});

	it("keeps source-mode development compatible with unstamped clients", () => {
		expect(shouldRejectLegacyRuntimeStreamClient("development", null)).toBe(false);
	});
});
