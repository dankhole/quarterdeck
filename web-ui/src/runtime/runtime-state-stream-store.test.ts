import { describe, expect, it } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import type { RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	createInitialRuntimeStateStreamStore,
	runtimeStateStreamReducer,
} from "@/runtime/runtime-state-stream-store";

function createSessionSummary(taskId: string, updatedAt: number): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		projectPath: "/tmp/project-a",
		pid: null,
		startedAt: updatedAt - 10,
		updatedAt,
		lastOutputAt: updatedAt,
		reviewReason: null,
		exitCode: null,
		lastHookAt: updatedAt,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
	};
}

function createProjectState(
	revision: number,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): RuntimeProjectStateResponse {
	return {
		repoPath: "/tmp/project-a",
		statePath: "/tmp/project-a/.quarterdeck",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: createInitialBoardData(),
		sessions,
		revision,
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
		expect(nextState.notificationMemory.sessions["task-1"]?.updatedAt).toBe(200);
		expect(nextState.notificationMemory.projectIds["task-1"]).toBe("project-a");
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
		expect(nextState.notificationMemory.sessions["task-1"]?.updatedAt).toBe(200);
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
			summaries: [createSessionSummary("task-1", 250)],
		});
		const withInitialNotification = runtimeStateStreamReducer(withDelta, {
			type: "task_notification",
			projectId: "project-a",
			summaries: [createSessionSummary("task-1", 200)],
		});
		const withOlderNotification = runtimeStateStreamReducer(withInitialNotification, {
			type: "task_notification",
			projectId: "project-a",
			summaries: [createSessionSummary("task-1", 150)],
		});

		expect(withDelta.projectState?.sessions["task-1"]?.updatedAt).toBe(250);
		expect(withInitialNotification.notificationMemory.sessions["task-1"]?.updatedAt).toBe(200);
		expect(withOlderNotification.notificationMemory.sessions["task-1"]?.updatedAt).toBe(200);

		const withNewerNotification = runtimeStateStreamReducer(withOlderNotification, {
			type: "task_notification",
			projectId: "project-a",
			summaries: [createSessionSummary("task-1", 300)],
		});

		expect(withNewerNotification.notificationMemory.sessions["task-1"]?.updatedAt).toBe(300);
		expect(withNewerNotification.notificationMemory.projectIds["task-1"]).toBe("project-a");
	});
});
