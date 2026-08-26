import { createInitialBoardData } from "@/data/board-data";
import type {
	RuntimeProjectStateResponse,
	RuntimeTaskHookActivity,
	RuntimeTaskNativeWorkEvidence,
	RuntimeTaskOutstandingInteraction,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "@/runtime/types";
import type { BoardData } from "@/types";

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

type TestProjectStateOverrides = Omit<Partial<RuntimeProjectStateResponse>, "board" | "sessions" | "git"> & {
	board?: BoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	git?: Partial<RuntimeProjectStateResponse["git"]>;
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

export function createTestProjectStateResponse(overrides: TestProjectStateOverrides = {}): RuntimeProjectStateResponse {
	const { board, sessions, git, revision, ...projectStateOverrides } = overrides;

	return {
		repoPath: "/tmp/project-a",
		statePath: "/tmp/project-a/.quarterdeck",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
			...git,
		},
		board: board ?? createInitialBoardData(),
		sessions: sessions ?? {},
		revision: revision ?? 1,
		...projectStateOverrides,
	};
}
