import { describe, expect, it } from "vitest";

import { slugifyBranchName } from "./branch-utils";

describe("slugifyBranchName", () => {
	it("converts title to valid branch name", () => {
		expect(slugifyBranchName("Add Auth Middleware")).toBe("quarterdeck/add-auth-middleware");
	});

	it("handles special characters", () => {
		expect(slugifyBranchName("Fix bug #123 (urgent!)")).toBe("quarterdeck/fix-bug-123-urgent");
	});

	it("truncates long titles", () => {
		const longTitle = "a".repeat(100);
		const result = slugifyBranchName(longTitle);
		expect(result.length).toBeLessThanOrEqual(60);
		expect(result.startsWith("quarterdeck/")).toBe(true);
	});

	it("returns empty for empty/whitespace title", () => {
		expect(slugifyBranchName("   ")).toBe("");
	});

	it("handles all-special-char title", () => {
		expect(slugifyBranchName("!!!")).toBe("");
	});
});
