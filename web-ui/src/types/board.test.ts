import { describe, expect, it } from "vitest";

import { getTaskAutoReviewCancelButtonLabel } from "@/types";

describe("getTaskAutoReviewCancelButtonLabel", () => {
	it("always returns the trash cancel button label regardless of mode", () => {
		expect(getTaskAutoReviewCancelButtonLabel("commit")).toBe("Cancel Auto-trash");
		expect(getTaskAutoReviewCancelButtonLabel("pr")).toBe("Cancel Auto-trash");
		expect(getTaskAutoReviewCancelButtonLabel("move_to_trash")).toBe("Cancel Auto-trash");
	});
});
