import { describe, expect, it } from "vitest";

import { getTaskAutoReviewCancelButtonLabel, resolveTaskAutoReviewMode } from "@/types";

describe("resolveTaskAutoReviewMode", () => {
	it("returns valid modes as-is", () => {
		expect(resolveTaskAutoReviewMode("commit")).toBe("commit");
		expect(resolveTaskAutoReviewMode("pr")).toBe("pr");
		expect(resolveTaskAutoReviewMode("move_to_trash")).toBe("move_to_trash");
	});

	it("defaults to move_to_trash for null/undefined", () => {
		expect(resolveTaskAutoReviewMode(null)).toBe("move_to_trash");
		expect(resolveTaskAutoReviewMode(undefined)).toBe("move_to_trash");
	});
});

describe("getTaskAutoReviewCancelButtonLabel", () => {
	it("returns mode-specific cancel labels", () => {
		expect(getTaskAutoReviewCancelButtonLabel("commit")).toBe("Cancel Auto-commit");
		expect(getTaskAutoReviewCancelButtonLabel("pr")).toBe("Cancel Auto-PR");
		expect(getTaskAutoReviewCancelButtonLabel("move_to_trash")).toBe("Cancel Auto-trash");
	});

	it("defaults to trash label for null/undefined", () => {
		expect(getTaskAutoReviewCancelButtonLabel(null)).toBe("Cancel Auto-trash");
		expect(getTaskAutoReviewCancelButtonLabel(undefined)).toBe("Cancel Auto-trash");
	});
});
