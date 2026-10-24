// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveProjectNavigationTaskCounts } from "@/components/app/project-navigation-counts";

describe("resolveProjectNavigationTaskCounts", () => {
	it("makes Needs Input override Review in navigation pills", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 1, review: 3, trash: 4 }, 2)).toEqual({
			inProgress: 1,
			review: 1,
			needsInput: 2,
			error: 0,
		});
	});

	it("does not suppress a newer notification projection behind an older board count", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 0, review: 1, trash: 0 }, 3)).toEqual({
			inProgress: 0,
			review: 0,
			needsInput: 3,
			error: 0,
		});
	});

	it("keeps Error and Needs Input exclusive from ordinary Review", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 1, review: 4, trash: 5 }, 1, 2)).toEqual({
			inProgress: 1,
			review: 1,
			needsInput: 1,
			error: 2,
		});
	});

	it("shows only Error when all Review tasks have errors", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 0, review: 2, trash: 0 }, 0, 2)).toEqual({
			inProgress: 0,
			review: 0,
			needsInput: 0,
			error: 2,
		});
	});

	it("preserves newer Error and Needs Input counts when they exceed the board total", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 0, review: 1, trash: 0 }, 1, 2)).toEqual({
			inProgress: 0,
			review: 0,
			needsInput: 1,
			error: 2,
		});
	});

	it("clamps negative Error counts independently", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 1, review: 3, trash: 2 }, 1, -2)).toEqual({
			inProgress: 1,
			review: 2,
			needsInput: 1,
			error: 0,
		});
	});

	it("clamps invalid negative notification counts without changing board counts", () => {
		expect(resolveProjectNavigationTaskCounts({ in_progress: 0, review: 2, trash: 0 }, -1)).toEqual({
			inProgress: 0,
			review: 2,
			needsInput: 0,
			error: 0,
		});
	});
});
