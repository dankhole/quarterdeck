import { describe, expect, it } from "vitest";

import {
	formatCardDetailSidePanelPercent,
	resolveCardDetailBranchPillLabel,
	resolveCardDetailFileBrowserScope,
} from "@/hooks/board/card-detail-view";

describe("formatCardDetailSidePanelPercent", () => {
	it("omits an unnecessary decimal while retaining fractional percentages", () => {
		expect(formatCardDetailSidePanelPercent(0.3)).toBe("30%");
		expect(formatCardDetailSidePanelPercent(0.255)).toBe("25.5%");
	});
});

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

describe("resolveCardDetailFileBrowserScope", () => {
	it("preserves task identity while browsing a read-only ref from task files", () => {
		expect(
			resolveCardDetailFileBrowserScope({
				type: "branch_view",
				ref: "origin/main",
				projectId: "project-1",
				taskId: "task-1",
				baseRef: "main",
			}),
		).toEqual({
			taskId: "task-1",
			baseRef: "main",
			ref: "origin/main",
		});
	});
});
