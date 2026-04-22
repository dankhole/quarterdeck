import { describe, expect, it } from "vitest";

import { resolveCardDetailBranchPillLabel } from "@/hooks/board/card-detail-view";

describe("resolveCardDetailBranchPillLabel", () => {
	it("prefers an explicit branch-view ref", () => {
		expect(
			resolveCardDetailBranchPillLabel({
				resolvedScope: { type: "branch_view", ref: "origin/main", projectId: "project-1" },
				displayBranchLabel: "feature/task",
			}),
		).toBe("origin/main");
	});

	it("returns the already-resolved task display label for contextual task scope", () => {
		expect(
			resolveCardDetailBranchPillLabel({
				resolvedScope: {
					type: "task",
					taskId: "task-1",
					baseRef: "main",
					projectId: "project-1",
					branch: "feature/task",
				},
				displayBranchLabel: "deadbeef",
			}),
		).toBe("deadbeef");
	});
});
