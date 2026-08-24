import { describe, expect, it } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import { createInitialRuntimeStateStreamStore, runtimeStateStreamReducer } from "@/runtime/runtime-state-stream-store";
import type { RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestProjectStateResponse, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import type { BoardData } from "@/types";

function createSessionSummary(taskId: string, updatedAt: number): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: "running",
		agentId: "codex",
		sessionLaunchPath: "/tmp/project-a",
		startedAt: updatedAt - 10,
		updatedAt,
		lastOutputAt: updatedAt,
		lastHookAt: updatedAt,
	});
}

function createProjectState(
	revision: number,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	boardTaskIds: readonly string[] = Object.keys(sessions),
): RuntimeProjectStateResponse {
	return createTestProjectStateResponse({
		board: createBoardWithTasks(boardTaskIds),
		sessions,
		revision,
	});
}

function createBoardWithTasks(taskIds: readonly string[]): BoardData {
	const board = createInitialBoardData();
	const now = 1;
	return {
		...board,
		columns: board.columns.map((column) =>
			column.id === "in_progress"
				? {
						...column,
						cards: taskIds.map((taskId) => ({
							id: taskId,
							title: null,
							prompt: `Prompt for ${taskId}`,
							baseRef: "main",
							createdAt: now,
							updatedAt: now,
						})),
					}
				: column,
		),
	};
}

describe("runtimeStateStreamReducer", () => {
	it("seeds preloaded project state and notification memory on requested project change", () => {
		const preloadedSession = createSessionSummary("task-1", 200);
		const preloadedProjectState = createProjectState(3, {
			"task-1": preloadedSession,
		});
		const initialState = createInitialRuntimeStateStreamStore(null);

		const nextState = runtimeStateStreamReducer(initialState, {
			type: "requested_project_changed",
			preloadedProjectState,
			requestedProjectId: "project-a",
		});

		expect(nextState.currentProjectId).toBe("project-a");
		expect(nextState.projectState?.sessions["task-1"]?.updatedAt).toBe(200);
		expect(nextState.notificationMemory.projects["project-a"]?.sessions["task-1"]?.updatedAt).toBe(200);
		expect(nextState.hasReceivedSnapshot).toBe(true);
	});

	it("keeps newer preloaded sessions when the initial snapshot replays older data", () => {
		const preloadedProjectState = createProjectState(3, {
			"task-1": createSessionSummary("task-1", 200),
		});
		const preloadedState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "requested_project_changed",
			preloadedProjectState,
			requestedProjectId: "project-a",
		});

		const nextState = runtimeStateStreamReducer(preloadedState, {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(3, {
					"task-1": createSessionSummary("task-1", 100),
				}),
				projectMetadata: null,
			},
		});

		expect(nextState.projectState?.sessions["task-1"]?.updatedAt).toBe(200);
		expect(nextState.notificationMemory.projects["project-a"]?.sessions["task-1"]?.updatedAt).toBe(200);
	});

	it("never reconciles same-shaped task sessions across project snapshots", () => {
		const projectAState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [],
				projectState: createProjectState(3, {
					"shared-task-id": createSessionSummary("shared-task-id", 500),
				}),
				projectMetadata: null,
			},
		});
		const projectBState = runtimeStateStreamReducer(projectAState, {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-b",
				projects: [],
				projectState: createProjectState(1, {
					"shared-task-id": createSessionSummary("shared-task-id", 100),
				}),
				projectMetadata: null,
			},
		});

		expect(projectBState.currentProjectId).toBe("project-b");
		expect(projectBState.projectState?.sessions["shared-task-id"]?.updatedAt).toBe(100);
	});

	it("keeps newer current sessions when a project-state update replays older data", () => {
		const currentState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "requested_project_changed",
			preloadedProjectState: createProjectState(3, {
				"task-1": createSessionSummary("task-1", 200),
			}),
			requestedProjectId: "project-a",
		});

		const nextState = runtimeStateStreamReducer(currentState, {
			type: "project_state_updated",
			projectId: "project-a",
			projectState: createProjectState(3, {
				"task-1": createSessionSummary("task-1", 100),
			}),
		});

		expect(nextState.projectState?.sessions["task-1"]?.updatedAt).toBe(200);
		expect(nextState.notificationMemory.projects["project-a"]?.sessions["task-1"]?.updatedAt).toBe(200);
	});

	it("drops stale tasks missing from a later authoritative project snapshot", () => {
		const preloadedProjectState = createProjectState(3, {
			"task-1": createSessionSummary("task-1", 200),
			"task-2": createSessionSummary("task-2", 150),
		});
		const preloadedState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "requested_project_changed",
			preloadedProjectState,
			requestedProjectId: "project-a",
		});

		const nextState = runtimeStateStreamReducer(preloadedState, {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(4, {
					"task-1": createSessionSummary("task-1", 100),
				}),
				projectMetadata: null,
			},
		});

		expect(nextState.projectState?.sessions["task-1"]?.updatedAt).toBe(200);
		expect(nextState.projectState?.sessions["task-2"]).toBeUndefined();
	});

	it("merges later task-session deltas and keeps notification memory monotonic", () => {
		const snapshotState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(1, {
					"task-1": createSessionSummary("task-1", 100),
				}),
				projectMetadata: null,
			},
		});

		const withDelta = runtimeStateStreamReducer(snapshotState, {
			type: "task_sessions_updated",
			projectId: "project-a",
			summaries: [createSessionSummary("task-1", 250)],
		});
		const withInitialNotification = runtimeStateStreamReducer(withDelta, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 1,
			summaries: [createSessionSummary("task-1", 200)],
		});
		const withOlderNotification = runtimeStateStreamReducer(withInitialNotification, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 2,
			summaries: [createSessionSummary("task-1", 150)],
		});

		expect(withDelta.projectState?.sessions["task-1"]?.updatedAt).toBe(250);
		expect(withInitialNotification.notificationMemory.projects["project-a"]?.sessions["task-1"]?.updatedAt).toBe(200);
		expect(withOlderNotification.notificationMemory.projects["project-a"]?.sessions["task-1"]?.updatedAt).toBe(200);

		const withNewerNotification = runtimeStateStreamReducer(withOlderNotification, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 3,
			summaries: [createSessionSummary("task-1", 300)],
		});

		expect(withNewerNotification.notificationMemory.projects["project-a"]?.sessions["task-1"]?.updatedAt).toBe(300);
	});

	it("seeds cross-project notification memory from the initial snapshot", () => {
		const nextState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
					{
						id: "project-b",
						path: "/tmp/project-b",
						name: "Project B",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(1, {
					"task-1": createSessionSummary("task-1", 100),
				}),
				projectMetadata: null,
				notificationSummariesByProject: {
					"project-b": [createSessionSummary("task-2", 150)],
				},
			},
		});

		expect(nextState.notificationMemory.projects["project-a"]?.sessions["task-1"]?.updatedAt).toBe(100);
		expect(nextState.notificationMemory.projects["project-b"]?.sessions["task-2"]?.updatedAt).toBe(150);
	});

	it("replaces project notification buckets from authoritative snapshots", () => {
		const snapshotState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
					},
					{
						id: "project-b",
						path: "/tmp/project-b",
						name: "Project B",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(1, {}),
				projectMetadata: null,
			},
		});
		const withStaleNotification = runtimeStateStreamReducer(snapshotState, {
			type: "task_notification",
			projectId: "project-b",
			notificationRevision: 1,
			summaries: [createSessionSummary("stale-task", 100)],
		});

		const nextState = runtimeStateStreamReducer(withStaleNotification, {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
					},
					{
						id: "project-b",
						path: "/tmp/project-b",
						name: "Project B",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(2, {}),
				projectMetadata: null,
				notificationSummariesByProject: {
					"project-b": [createSessionSummary("live-task", 200)],
				},
				notificationRevisionsByProject: {
					"project-b": 2,
				},
			},
		});

		expect(nextState.notificationMemory.projects["project-b"]?.sessions["live-task"]?.updatedAt).toBe(200);
		expect(nextState.notificationMemory.projects["project-b"]?.sessions["stale-task"]).toBeUndefined();
	});

	it("clears stale active-project notifications through the notification projection owner", () => {
		const withStaleNotification = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 1,
			summaries: [createSessionSummary("orphan-task", 100)],
		});

		const nextState = runtimeStateStreamReducer(withStaleNotification, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 2,
			summaries: [],
			replace: true,
		});

		expect(nextState.notificationMemory.projects["project-a"]).toBeUndefined();
	});

	it("removes notification tasks from live tombstone deltas", () => {
		const withNotification = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 1,
			summaries: [createSessionSummary("task-1", 100)],
		});

		const nextState = runtimeStateStreamReducer(withNotification, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 2,
			summaries: [],
			removedTaskIds: ["task-1"],
		});

		expect(nextState.notificationMemory.projects["project-a"]).toBeUndefined();
	});

	it("replaces notification buckets from authoritative notification deltas", () => {
		const withNotification = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 1,
			summaries: [createSessionSummary("stale-task", 100)],
		});

		const replaced = runtimeStateStreamReducer(withNotification, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 2,
			summaries: [createSessionSummary("live-task", 200)],
			replace: true,
		});

		expect(replaced.notificationMemory.projects["project-a"]?.sessions["live-task"]?.updatedAt).toBe(200);
		expect(replaced.notificationMemory.projects["project-a"]?.sessions["stale-task"]).toBeUndefined();

		const cleared = runtimeStateStreamReducer(replaced, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 3,
			summaries: [],
			replace: true,
		});

		expect(cleared.notificationMemory.projects["project-a"]).toBeUndefined();
	});

	it("prunes notification state for removed projects on projects_updated", () => {
		const snapshotState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
					{
						id: "project-b",
						path: "/tmp/project-b",
						name: "Project B",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(1, {
					"task-1": createSessionSummary("task-1", 100),
				}),
				projectMetadata: null,
			},
		});

		const withOtherProjectNotification = runtimeStateStreamReducer(snapshotState, {
			type: "task_notification",
			projectId: "project-b",
			notificationRevision: 1,
			summaries: [createSessionSummary("task-2", 150)],
		});

		const nextState = runtimeStateStreamReducer(withOtherProjectNotification, {
			type: "projects_updated",
			payload: {
				type: "projects_updated",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
			},
			nextProjectId: "project-a",
		});

		expect(nextState.notificationMemory.projects["project-a"]?.sessions["task-1"]?.updatedAt).toBe(100);
		expect(nextState.notificationMemory.projects["project-b"]).toBeUndefined();
	});

	it("pairs project pills with the board revision included in a snapshot", () => {
		const nextState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 1,
						taskCounts: { backlog: 0, in_progress: 0, review: 1, trash: 0 },
					},
				],
				projectState: createProjectState(3, {
					"task-1": createSessionSummary("task-1", 100),
				}),
				projectMetadata: null,
			},
		});

		expect(nextState.projects[0]).toMatchObject({
			boardRevision: 3,
			taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
		});
	});

	it("does not regress pills or board state when stream messages arrive out of order", () => {
		const current = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 5,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(5, {
					"task-1": createSessionSummary("task-1", 100),
				}),
				projectMetadata: null,
			},
		});
		const afterStaleProjects = runtimeStateStreamReducer(current, {
			type: "projects_updated",
			nextProjectId: "project-a",
			payload: {
				type: "projects_updated",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 4,
						taskCounts: { backlog: 0, in_progress: 0, review: 1, trash: 0 },
					},
				],
			},
		});
		const afterStaleState = runtimeStateStreamReducer(afterStaleProjects, {
			type: "project_state_updated",
			projectId: "project-a",
			projectState: createProjectState(4, {}),
		});

		expect(afterStaleProjects.projects[0]?.boardRevision).toBe(5);
		expect(afterStaleProjects.projects[0]?.taskCounts.in_progress).toBe(1);
		expect(afterStaleState).toBe(afterStaleProjects);
	});

	it("keeps exact counts for a project after switching away at the same board revision", () => {
		const projectAState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 5,
						taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(5, {
					"task-a": createSessionSummary("task-a", 100),
				}),
				projectMetadata: null,
			},
		});
		const switching = runtimeStateStreamReducer(projectAState, {
			type: "requested_project_changed",
			requestedProjectId: "project-b",
			preloadedProjectState: null,
		});
		expect(switching.currentProjectId).toBe("project-b");

		const projectBState = runtimeStateStreamReducer(switching, {
			type: "snapshot",
			payload: {
				type: "snapshot",
				currentProjectId: "project-b",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a-renamed",
						name: "Project A Renamed",
						boardRevision: 5,
						taskCounts: { backlog: 0, in_progress: 0, review: 1, trash: 0 },
					},
					{
						id: "project-b",
						path: "/tmp/project-b",
						name: "Project B",
						boardRevision: 2,
						taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
					},
				],
				projectState: createProjectState(2, {}),
				projectMetadata: null,
			},
		});

		expect(projectBState.projects.find((project) => project.id === "project-a")).toMatchObject({
			path: "/tmp/project-a-renamed",
			name: "Project A Renamed",
			boardRevision: 5,
			taskCounts: { backlog: 0, in_progress: 1, review: 0, trash: 0 },
		});
	});

	it("allows an unproven same-revision project summary to self-heal", () => {
		const fallbackState = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "projects_updated",
			payload: {
				type: "projects_updated",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
					},
				],
			},
			nextProjectId: "project-a",
		});
		const recovered = runtimeStateStreamReducer(fallbackState, {
			type: "projects_updated",
			payload: {
				type: "projects_updated",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 0,
						taskCounts: { backlog: 2, in_progress: 0, review: 0, trash: 0 },
					},
				],
			},
			nextProjectId: "project-a",
		});

		expect(recovered.projects[0]?.taskCounts.backlog).toBe(2);
	});

	it("rejects every action delivered by an obsolete stream generation", () => {
		const current = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "stream_generation_changed",
			streamGeneration: 2,
			requestedProjectId: "project-a",
			preloadedProjectState: null,
		});
		const stale = runtimeStateStreamReducer(current, {
			type: "stream_action",
			streamGeneration: 1,
			action: {
				type: "task_title_updated",
				projectId: "project-a",
				taskId: "task-a",
				title: "Stale title",
			},
		});

		expect(stale).toBe(current);
	});

	it("rejects project-scoped actions that do not match the active project", () => {
		const current = createInitialRuntimeStateStreamStore("project-b");
		const stale = runtimeStateStreamReducer(current, {
			type: "task_base_ref_updated",
			projectId: "project-a",
			taskId: "shared-task-id",
			baseRef: "stale-base",
		});

		expect(stale).toBe(current);
	});

	it("ignores stale notification replacements and resets ordering on reconnect", () => {
		const current = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 5,
			summaries: [createSessionSummary("new-task", 500)],
		});
		const stale = runtimeStateStreamReducer(current, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 4,
			summaries: [createSessionSummary("stale-task", 400)],
			replace: true,
		});
		expect(stale).toBe(current);

		const reconnected = runtimeStateStreamReducer(stale, { type: "stream_connected" });
		const newRuntimeBaseline = runtimeStateStreamReducer(reconnected, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 1,
			summaries: [],
			replace: true,
		});
		expect(newRuntimeBaseline.notificationMemory.projects["project-a"]).toBeUndefined();
	});
});
