import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary, RuntimeTaskTurnCheckpoint } from "../../src/core";

type TestTaskSessionSummaryOverrides = Omit<
	Partial<RuntimeTaskSessionSummary>,
	"latestHookActivity" | "latestTurnCheckpoint" | "previousTurnCheckpoint" | "conversationSummaries"
> & {
	latestHookActivity?: Partial<RuntimeTaskHookActivity> | null;
	latestTurnCheckpoint?: RuntimeTaskTurnCheckpoint | null;
	previousTurnCheckpoint?: RuntimeTaskTurnCheckpoint | null;
	conversationSummaries?: RuntimeTaskSessionSummary["conversationSummaries"];
};

export function createTestTaskHookActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
	return {
		activityText: null,
		toolName: null,
		toolInputSummary: null,
		finalMessage: null,
		hookEventName: null,
		notificationType: null,
		source: null,
		conversationSummaryText: null,
		...overrides,
	};
}

export function createTestTaskSessionSummary(
	overrides: TestTaskSessionSummaryOverrides = {},
): RuntimeTaskSessionSummary {
	const {
		latestHookActivity,
		latestTurnCheckpoint,
		previousTurnCheckpoint,
		conversationSummaries,
		...summaryOverrides
	} = overrides;
	const resolvedLatestHookActivity =
		latestHookActivity == null ? null : createTestTaskHookActivity(latestHookActivity);

	return {
		taskId: "task-1",
		state: "idle",
		mode: null,
		agentId: null,
		sessionLaunchPath: null,
		resumeSessionId: null,
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: resolvedLatestHookActivity,
		stalledSince: null,
		warningMessage: null,
		latestTurnCheckpoint: latestTurnCheckpoint ?? null,
		previousTurnCheckpoint: previousTurnCheckpoint ?? null,
		conversationSummaries: conversationSummaries ? [...conversationSummaries] : [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...summaryOverrides,
	};
}
