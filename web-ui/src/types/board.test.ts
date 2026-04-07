import { describe, expect, it } from "vitest";

import { getTaskAutoReviewActionLabel, getTaskAutoReviewCancelButtonLabel } from "@/types";

describe("getTaskAutoReviewActionLabel", () => {
	it("always returns trash regardless of mode", () => {
		expect(getTaskAutoReviewActionLabel("commit")).toBe("trash");
		expect(getTaskAutoReviewActionLabel("pr")).toBe("trash");
		expect(getTaskAutoReviewActionLabel("move_to_trash")).toBe("trash");
	});

	it("falls back to trash when the mode is missing", () => {
		expect(getTaskAutoReviewActionLabel(undefined)).toBe("trash");
	});

	it("always returns the trash cancel button label regardless of mode", () => {
		expect(getTaskAutoReviewCancelButtonLabel("commit")).toBe("Cancel Auto-trash");
		expect(getTaskAutoReviewCancelButtonLabel("pr")).toBe("Cancel Auto-trash");
		expect(getTaskAutoReviewCancelButtonLabel("move_to_trash")).toBe("Cancel Auto-trash");
	});
});
