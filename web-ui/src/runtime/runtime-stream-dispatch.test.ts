import { describe, expect, it } from "vitest";
import { resolveStreamMessage } from "@/runtime/runtime-stream-dispatch";

describe("resolveStreamMessage", () => {
	it("requests a reconnect when projects_updated changes the active project", () => {
		const result = resolveStreamMessage(
			{
				type: "projects_updated",
				currentProjectId: "project-b",
				projects: [
					{
						id: "project-b",
						path: "/tmp/project-b",
						name: "Project B",
						taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
					},
				],
			},
			{ activeProjectId: "project-a" },
		);

		expect(result.nextActiveProjectId).toBe("project-b");
		expect(result.reconnectProjectId).toBe("project-b");
		expect(result.actions).toEqual([
			{
				type: "projects_updated",
				payload: {
					type: "projects_updated",
					currentProjectId: "project-b",
					projects: [
						{
							id: "project-b",
							path: "/tmp/project-b",
							name: "Project B",
							taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
						},
					],
				},
				nextProjectId: "project-b",
			},
		]);
	});

	it("ignores project-scoped deltas for inactive projects while still accepting notifications", () => {
		const ignoredProjectDelta = resolveStreamMessage(
			{
				type: "project_state_updated",
				projectId: "project-b",
				projectState: {
					repoPath: "/tmp/project-b",
					statePath: "/tmp/project-b/.quarterdeck",
					git: {
						currentBranch: "main",
						defaultBranch: "main",
						branches: ["main"],
					},
					board: { columns: [], dependencies: [] },
					sessions: {},
					revision: 1,
				},
			},
			{ activeProjectId: "project-a" },
		);
		const notification = resolveStreamMessage(
			{
				type: "task_notification",
				projectId: "project-b",
				summaries: [],
			},
			{ activeProjectId: "project-a" },
		);

		expect(ignoredProjectDelta.actions).toEqual([]);
		expect(notification.actions).toEqual([
			{
				type: "task_notification",
				projectId: "project-b",
				summaries: [],
			},
		]);
	});

	it("preserves task notification removals", () => {
		const result = resolveStreamMessage(
			{
				type: "task_notification",
				projectId: "project-b",
				summaries: [],
				removedTaskIds: ["task-1"],
			},
			{ activeProjectId: "project-a" },
		);

		expect(result.actions).toEqual([
			{
				type: "task_notification",
				projectId: "project-b",
				summaries: [],
				removedTaskIds: ["task-1"],
			},
		]);
	});
});
