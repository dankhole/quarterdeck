import { createInitialBoardData } from "@/data/board-data";
import type {
	RuntimeProjectStateResponse,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "@/runtime/types";
import type { BoardData } from "@/types";

type TestTaskSessionSummaryOverrides = Omit<
	Partial<RuntimeTaskSessionSummary>,
	"latestHookActivity" | "latestTurnCheckpoint" | "previousTurnCheckpoint" | "conversationSummaries"
> & {
	latestHookActivity?: Partial<RuntimeTaskHookActivity> | null;
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
