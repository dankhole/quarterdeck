import { describe, expect, it } from "vitest";
import { resolveProjectNavigationTaskCounts } from "@/components/app/project-navigation-counts";

describe("resolveProjectNavigationTaskCounts", () => {
	it("makes Needs Input override Review in navigation pills", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 1, review: 3, trash: 4 }, 2)).toEqual({
			inProgress: 1,
			review: 1,
			needsInput: 2,
		});
	});

	it("does not suppress a newer notification projection behind an older board count", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 0, review: 1, trash: 0 }, 3)).toEqual({
			inProgress: 0,
			review: 0,
			needsInput: 3,
		});
	});

	it("clamps invalid negative notification counts without changing board counts", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 0, review: 2, trash: 0 }, -1)).toEqual({
			inProgress: 0,
			review: 2,
			needsInput: 0,
		});
	});
});
