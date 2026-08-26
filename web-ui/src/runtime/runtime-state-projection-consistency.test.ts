import { describe, expect, it } from "vitest";
import { resolveProjectNavigationTaskCounts } from "@/components/app/project-navigation-counts";
import { createInitialBoardData } from "@/data/board-data";
import {
	deriveAudibleTaskNotificationState,
	isNewAudibleNotification,
} from "@/hooks/notifications/audible-notifications";
import { buildProjectNotificationProjection } from "@/hooks/notifications/project-notifications";
import { createInitialRuntimeStateStreamStore, runtimeStateStreamReducer } from "@/runtime/runtime-state-stream-store";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestProjectStateResponse, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import { countTasksByColumn } from "@/utils/app-utils";
import { describeSessionState } from "@/utils/session-status";

function createUnprovenCodexAttention(taskId: string): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: "awaiting_review",
		reviewReason: "attention",
		agentId: "codex",
		pid: 100,
		sessionInstanceId: `session-${taskId}`,
		latestHookActivity: null,
		updatedAt: 100,
	});
}

describe("runtime state projection consistency", () => {
	it("keeps Needs Input exclusive from the Review pill and clears only Needs Input after a response", () => {
		const taskIds = ["task-1", "task-2", "task-3"];
		const board = createInitialBoardData();
		const review = board.columns.find((column) => column.id === "review");
		if (!review) throw new Error("Missing Review column.");
		review.cards = taskIds.map((taskId, index) => ({
			id: taskId,
			title: `Task ${index + 1}`,
			prompt: `Prompt ${index + 1}`,
			baseRef: "main",
			createdAt: index + 1,
			updatedAt: index + 1,
		}));
		const ordinaryReview = (taskId: string) =>
			createTestTaskSessionSummary({
				taskId,
				state: "awaiting_review",
				reviewReason: "hook",
				agentId: "claude",
				updatedAt: 100,
			});
		const waiting = createTestTaskSessionSummary({
			...ordinaryReview("task-3"),
			outstandingInteraction: {
				provider: "claude",
				kind: "question",
				status: "waiting",
				requestEventName: "PreToolUse",
				openedAt: 100,
				updatedAt: 100,
				responseSubmittedAt: null,
				responseKind: null,
				sessionInstanceId: "process-1",
				providerSessionId: "session-1",
				turnId: null,
				promptId: "prompt-1",
				toolUseId: "tool-1",
				elicitationId: null,
				providerAgentId: null,
				toolName: "AskUserQuestion",
			},
		});
		const sessions = {
			"task-1": ordinaryReview("task-1"),
			"task-2": ordinaryReview("task-2"),
			"task-3": waiting,
		};
		const projectState = createTestProjectStateResponse({ board, sessions, revision: 3 });
		const initial = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				runtimeBuildId: "test",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 3,
						taskCounts: { backlog: 0, in_progress: 0, review: 3, trash: 0 },
					},
				],
				projectState,
				projectMetadata: null,
				notificationSummariesByProject: { "project-a": Object.values(sessions) },
				notificationRevisionsByProject: { "project-a": 1 },
			},
		});

		expect(countTasksByColumn(initial.projectState?.board ?? createInitialBoardData()).review).toBe(3);
		expect(buildProjectNotificationProjection(initial.notificationMemory.projects, "project-a")).toMatchObject({
			needsInputByProject: { "project-a": 1 },
			currentProjectHasNeedsInput: true,
		});
		expect(resolveProjectNavigationTaskCounts(initial.projects[0]!.taskCounts, 1)).toMatchObject({
			review: 2,
			needsInput: 1,
		});
		expect(describeSessionState(initial.projectState?.sessions["task-3"] ?? null)).toBe("Waiting for input");

		const submitted = createTestTaskSessionSummary({
			...waiting,
			updatedAt: 110,
			outstandingInteraction: {
				...waiting.outstandingInteraction!,
				status: "response_submitted",
				updatedAt: 110,
				responseSubmittedAt: 110,
				responseKind: "submit",
			},
		});
		const afterSession = runtimeStateStreamReducer(initial, {
			type: "task_sessions_updated",
			projectId: "project-a",
			summaries: [submitted],
		});
		const afterNotification = runtimeStateStreamReducer(afterSession, {
			type: "task_notification",
			projectId: "project-a",
			notificationRevision: 2,
			summaries: [submitted],
		});

		expect(countTasksByColumn(afterNotification.projectState?.board ?? createInitialBoardData()).review).toBe(3);
		expect(
			buildProjectNotificationProjection(afterNotification.notificationMemory.projects, "project-a"),
		).toMatchObject({
			needsInputByProject: {},
			currentProjectHasNeedsInput: false,
		});
		expect(resolveProjectNavigationTaskCounts(afterNotification.projects[0]!.taskCounts, 0)).toMatchObject({
			review: 3,
			needsInput: 0,
		});
		expect(describeSessionState(afterNotification.projectState?.sessions["task-3"] ?? null)).toBe(
			"Response sent — awaiting agent confirmation",
		);
		expect(
			isNewAudibleNotification(
				deriveAudibleTaskNotificationState(waiting),
				deriveAudibleTaskNotificationState(submitted),
			),
		).toBe(false);
	});

	it("keeps three unproven Codex attention tasks in Review without fabricating Needs Input", () => {
		const taskIds = ["task-1", "task-2", "task-3"];
		const board = createInitialBoardData();
		const review = board.columns.find((column) => column.id === "review");
		if (!review) {
			throw new Error("Missing Review column.");
		}
		review.cards = taskIds.map((taskId, index) => ({
			id: taskId,
			title: `Task ${index + 1}`,
			prompt: `Prompt ${index + 1}`,
			baseRef: "main",
			createdAt: index + 1,
			updatedAt: index + 1,
		}));
		const sessions = Object.fromEntries(taskIds.map((taskId) => [taskId, createUnprovenCodexAttention(taskId)]));
		const projectState = createTestProjectStateResponse({ board, sessions, revision: 3 });

		const state = runtimeStateStreamReducer(createInitialRuntimeStateStreamStore("project-a"), {
			type: "snapshot",
			payload: {
				type: "snapshot",
				runtimeBuildId: "test",
				currentProjectId: "project-a",
				projects: [
					{
						id: "project-a",
						path: "/tmp/project-a",
						name: "Project A",
						boardRevision: 3,
						taskCounts: { backlog: 0, in_progress: 0, review: 3, trash: 0 },
					},
				],
				projectState,
				projectMetadata: null,
				notificationSummariesByProject: { "project-a": Object.values(sessions) },
				notificationRevisionsByProject: { "project-a": 1 },
			},
		});

		expect(countTasksByColumn(state.projectState?.board ?? createInitialBoardData()).review).toBe(3);
		expect(Object.values(state.projectState?.sessions ?? {}).map((summary) => describeSessionState(summary))).toEqual(
			["Interrupted", "Interrupted", "Interrupted"],
		);
		expect(buildProjectNotificationProjection(state.notificationMemory.projects, "project-a")).toMatchObject({
			needsInputByProject: {},
			currentProjectHasNeedsInput: false,
		});
	});
});
