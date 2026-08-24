import { vi } from "vitest";

import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../../src/core";
import {
	type HookSessionReviewReason,
	reduceSessionTransition,
	type SessionSummaryStore,
	type TerminalSessionManager,
} from "../../../../src/terminal";
import { type CreateHooksApiDependencies, createHooksApi } from "../../../../src/trpc";

type HookTransitionSummaryFactories = {
	toReviewSummary?: (taskId: string, reason: HookSessionReviewReason) => RuntimeTaskSessionSummary | null;
	toRunningSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
};

type MockStoreMethods = Partial<SessionSummaryStore> & HookTransitionSummaryFactories;

export function createMockManager(storeMethods: MockStoreMethods): TerminalSessionManager {
	const { toReviewSummary, toRunningSummary, ...sessionStoreMethods } = storeMethods;
	const store = {
		...sessionStoreMethods,
		applyHookMetadata:
			sessionStoreMethods.applyHookMetadata ??
			vi.fn((taskId: string, metadata: Parameters<SessionSummaryStore["applyHookMetadata"]>[1]) => {
				const {
					sessionId: _sessionId,
					sessionInstanceId: _sessionInstanceId,
					turnId: _turnId,
					toolUseId: _toolUseId,
					transcriptPath: _transcriptPath,
					...activity
				} = metadata;
				return sessionStoreMethods.applyHookActivity?.(taskId, activity);
			}),
	};
	return {
		store,
		applyHookTransition: vi.fn((taskId, transition) => {
			const configuredSummary =
				transition.type === "hook.to_review"
					? toReviewSummary?.(taskId, transition.reason ?? "hook")
					: toRunningSummary?.(taskId);
			if (configuredSummary) {
				return {
					changed: true,
					patch: {},
					clearAttentionBuffer: true,
					summary: configuredSummary,
				};
			}
			const summary = store.getSummary?.(taskId) ?? null;
			if (!summary) {
				return null;
			}
			const result = reduceSessionTransition(summary, transition);
			return {
				...result,
				summary: result.changed ? { ...summary, ...result.patch } : summary,
			};
		}),
		recordHookReceived: vi.fn(),
		observeTaskSessionLaunchHook: vi.fn(() => true),
		evaluateHookEventOrder: vi.fn(() => ({ accepted: true })),
		commitHookEventOrder: vi.fn(),
	} as unknown as TerminalSessionManager;
}

export function mockStore(manager: TerminalSessionManager): Record<string, ReturnType<typeof vi.fn>> {
	return manager.store as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

export function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/worktree",
		resumeSessionId: null,
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

export function permissionActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
	return {
		hookEventName: "PermissionRequest",
		notificationType: null,
		activityText: "Waiting for approval",
		toolName: null,
		toolInputSummary: null,
		finalMessage: null,
		source: "claude",
		conversationSummaryText: null,
		...overrides,
	};
}

export function nullFilledActivity(partial: Partial<RuntimeTaskHookActivity>): RuntimeTaskHookActivity {
	return {
		hookEventName: partial.hookEventName ?? null,
		notificationType: partial.notificationType ?? null,
		activityText: partial.activityText ?? null,
		toolName: partial.toolName ?? null,
		toolInputSummary: partial.toolInputSummary ?? null,
		finalMessage: partial.finalMessage ?? null,
		source: partial.source ?? null,
		conversationSummaryText: partial.conversationSummaryText ?? null,
	};
}

export function createTestApi(manager: TerminalSessionManager, overrides: Partial<CreateHooksApiDependencies> = {}) {
	return createHooksApi({
		projects: { getProjectPathById: vi.fn(() => "/tmp/repo") },
		terminals: {
			getTerminalManagerForProject: vi.fn(() => null),
			ensureTerminalManagerForProject: vi.fn(async () => manager),
		},
		broadcaster: { broadcastRuntimeProjectStateUpdated: vi.fn(), broadcastTaskReadyForReview: vi.fn() },
		...overrides,
	});
}
