import { describe, expect, it } from "vitest";
import {
	isBranchRefValid,
	isPlanModeDisabledByAutoReview,
	isTaskSaveValid,
	resolveEffectiveBaseRef,
} from "@/hooks/board/task-editor";

describe("isPlanModeDisabledByAutoReview", () => {
	it("returns true when auto-review enabled with move_to_trash mode", () => {
		expect(isPlanModeDisabledByAutoReview(true, "move_to_trash")).toBe(true);
	});

	it("returns false when auto-review disabled", () => {
		expect(isPlanModeDisabledByAutoReview(false, "move_to_trash")).toBe(false);
	});

	it("returns false when auto-review mode is commit", () => {
		expect(isPlanModeDisabledByAutoReview(true, "commit")).toBe(false);
	});
});

describe("isBranchRefValid", () => {
	const branches = [{ value: "main" }, { value: "develop" }];

	it("returns true for a valid branch", () => {
		expect(isBranchRefValid("main", branches)).toBe(true);
	});

	it("returns false for an invalid branch", () => {
		expect(isBranchRefValid("nonexistent", branches)).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isBranchRefValid("", branches)).toBe(false);
	});
});

describe("isTaskSaveValid", () => {
	it("returns true with non-empty prompt and branch ref", () => {
		expect(isTaskSaveValid("do something", "main", "")).toBe(true);
	});

	it("returns true with non-empty prompt and fallback branch ref", () => {
		expect(isTaskSaveValid("do something", "", "main")).toBe(true);
	});

	it("returns false with empty prompt", () => {
		expect(isTaskSaveValid("", "main", "")).toBe(false);
	});

	it("returns false with whitespace-only prompt", () => {
		expect(isTaskSaveValid("   ", "main", "")).toBe(false);
	});

	it("returns false with no branch ref or fallback", () => {
		expect(isTaskSaveValid("do something", "", "")).toBe(false);
	});
});

describe("resolveEffectiveBaseRef", () => {
	it("returns branch ref when provided", () => {
		expect(resolveEffectiveBaseRef("develop", "main")).toBe("develop");
	});

	it("returns fallback when branch ref is empty", () => {
		expect(resolveEffectiveBaseRef("", "main")).toBe("main");
	});
});
