import type {
	RuntimeHookEvent,
	RuntimeHookIngestRequest,
	RuntimeHookMetadata,
	RuntimeTaskHookActivity,
	RuntimeTaskNativeWorkEvidence,
	RuntimeTaskOutstandingInteraction,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../../src/core";
import type { SessionTransitionEvent } from "../../src/terminal";

type TestTaskSessionSummaryOverrides = Omit<
	Partial<RuntimeTaskSessionSummary>,
	| "latestHookActivity"
	| "outstandingInteraction"
	| "nativeWorkEvidence"
	| "latestTurnCheckpoint"
	| "previousTurnCheckpoint"
	| "conversationSummaries"
> & {
	latestHookActivity?: Partial<RuntimeTaskHookActivity> | null;
	outstandingInteraction?: RuntimeTaskOutstandingInteraction | null;
	nativeWorkEvidence?: RuntimeTaskSessionSummary["nativeWorkEvidence"];
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

export function createTestTaskOutstandingInteraction(
	overrides: Partial<RuntimeTaskOutstandingInteraction> = {},
): RuntimeTaskOutstandingInteraction {
	return {
		provider: "claude",
		kind: "question",
		status: "waiting",
		requestEventName: "PreToolUse",
		openedAt: 1,
		updatedAt: 1,
		responseSubmittedAt: null,
		responseKind: null,
		sessionInstanceId: "process-1",
		providerSessionId: "session-1",
		turnId: null,
		promptId: null,
		toolUseId: "tool-1",
		elicitationId: null,
		providerAgentId: null,
		toolName: "AskUserQuestion",
		...overrides,
	};
}

export function createTestTaskNativeWorkEvidence(
	overrides: Partial<RuntimeTaskNativeWorkEvidence> = {},
): RuntimeTaskNativeWorkEvidence {
	const confirmedAt = Date.now();
	return {
		provider: "codex",
		sessionInstanceId: "process-1",
		providerSessionId: "session-1",
		turnId: "turn-1",
		hookEventName: "UserPromptSubmit",
		confirmedAt,
		expiresAt: confirmedAt + 300_000,
		...overrides,
	};
}

export function createTestTaskSessionSummary(
	overrides: TestTaskSessionSummaryOverrides = {},
): RuntimeTaskSessionSummary {
	const {
		latestHookActivity,
		outstandingInteraction,
		nativeWorkEvidence,
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
		lastProviderHookOccurredAt: null,
		recentProviderHookDeliveryIds: [],
		recentProviderHookOrderObservations: [],
		latestHookActivity: resolvedLatestHookActivity,
		outstandingInteraction: outstandingInteraction ? { ...outstandingInteraction } : null,
		nativeWorkEvidence: nativeWorkEvidence ? { ...nativeWorkEvidence } : null,
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

export function createTestProviderHookEvent(
	event: RuntimeHookEvent,
	options: {
		source?: "claude" | "codex" | "pi";
		hookEventName?: string;
		metadata?: Omit<RuntimeHookMetadata, "source" | "hookEventName">;
		occurredAt?: number;
		correlatedToolUseId?: string | null;
		sessionEvidence?: Extract<SessionTransitionEvent, { type: "provider.hook" }>["sessionEvidence"];
	} = {},
): Extract<SessionTransitionEvent, { type: "provider.hook" }> {
	return {
		type: "provider.hook",
		event,
		metadata: {
			source: options.source ?? "claude",
			sessionInstanceId: "process-1",
			hookEventName:
				options.hookEventName ??
				(event === "to_review" ? "Stop" : event === "to_in_progress" ? "PreToolUse" : "PostCompact"),
			...options.metadata,
		},
		occurredAt: options.occurredAt ?? 1,
		confirmedAt: options.occurredAt ?? 1,
		correlatedToolUseId: options.correlatedToolUseId ?? null,
		sessionEvidence: options.sessionEvidence ?? "live",
	};
}

export function createTestProviderHookRequest(
	summary: RuntimeTaskSessionSummary,
	event: RuntimeHookEvent,
	options: {
		hookEventName?: string;
		metadata?: Omit<RuntimeHookMetadata, "source" | "hookEventName" | "sessionInstanceId">;
		occurredAt?: number;
	} = {},
): RuntimeHookIngestRequest {
	const source = summary.agentId === "codex" || summary.agentId === "pi" ? summary.agentId : "claude";
	return {
		taskId: summary.taskId,
		projectId: "project-1",
		event,
		metadata: {
			source,
			hookEventName:
				options.hookEventName ??
				(event === "to_review" ? "Stop" : event === "to_in_progress" ? "PreToolUse" : "PostCompact"),
			sessionInstanceId: summary.sessionInstanceId ?? undefined,
			...options.metadata,
		},
		delivery: {
			id: "00000000-0000-4000-8000-000000000001",
			occurredAt: options.occurredAt ?? Date.now(),
		},
	};
}
