import { describe, expect, it } from "vitest";
import { resolveProjectNavigationTaskCounts } from "@/components/app/project-navigation-counts";

describe("resolveProjectNavigationTaskCounts", () => {
	it("makes Needs Input override Review in navigation pills", () => {
		expect(resolveProjectNavigationTaskCounts({ backlog: 2, in_progress: 1, review: 3, trash: 4 }, 2)).toEqual({
			backlog: 2,
			inProgress: 1,
			review: 1,
			needsInput: 2,
		});
	});

	it("does not suppress a newer notification projection behind an older board count", () => {
		expect(resolveProjectNavigationTaskCounts({ backlog: 0, in_progress: 0, review: 1, trash: 0 }, 3)).toEqual({
			backlog: 0,
			inProgress: 0,
			review: 0,
			needsInput: 3,
		});
	});

	it("clamps invalid negative notification counts without changing board counts", () => {
		expect(resolveProjectNavigationTaskCounts({ backlog: 0, in_progress: 0, review: 2, trash: 0 }, -1)).toEqual({
			backlog: 0,
			inProgress: 0,
			review: 2,
			needsInput: 0,
		});
	});
});
