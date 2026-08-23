import { describe, expect, it } from "vitest";

import type { RuntimeProjectStateResponse } from "../../../src/core";
import { ProjectStateDiagnosticTracker } from "../../../src/server/project-state-diagnostics";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function stateWithTask(
	columnId: "in_progress" | "review",
	sessionState: "running" | "awaiting_review",
): RuntimeProjectStateResponse {
	const card = {
		id: "task-1",
		title: null,
		prompt: "private prompt",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
	return {
		repoPath: "/repo",
		statePath: "/state",
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		board: {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: columnId === "in_progress" ? [card] : [] },
				{ id: "review", title: "Review", cards: columnId === "review" ? [card] : [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		},
		sessions: {
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: sessionState }),
		},
		revision: 3,
	};
}

describe("ProjectStateDiagnosticTracker", () => {
	it("retains only bounded ownership metadata and shared work-column divergences", () => {
		const tracker = new ProjectStateDiagnosticTracker();
		tracker.observe("project-1", stateWithTask("review", "running"));

		expect(tracker.getSnapshot()).toEqual({
			projects: [
				{
					projectId: "project-1",
					revision: 3,
					cardCounts: { backlog: 0, in_progress: 0, review: 1, trash: 0 },
					sessionCount: 1,
					sessionColumnDivergences: [
						{
							taskId: "task-1",
							sessionState: "running",
							actualColumnId: "review",
							expectedColumnId: "in_progress",
						},
					],
					lastObservedAt: expect.any(Number),
				},
			],
		});
		expect(JSON.stringify(tracker.getSnapshot())).not.toContain("private prompt");
	});

	it("filters project and task-owned divergence details at capture time", () => {
		const tracker = new ProjectStateDiagnosticTracker();
		tracker.observe("project-1", stateWithTask("review", "running"));
		tracker.observe("project-2", stateWithTask("review", "running"));

		const snapshot = tracker.getSnapshot({ projectId: "project-1", taskId: "other-task" });
		expect(snapshot.projects).toHaveLength(1);
		expect(snapshot.projects[0]?.projectId).toBe("project-1");
		expect(snapshot.projects[0]?.sessionColumnDivergences).toEqual([]);
	});
});
