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
	const store = sessionStoreMethods;
	const manager = {
		store,
		recordHookReceived: vi.fn(),
		observeTaskSessionLaunchHook: vi.fn(() => true),
		evaluateHookEventOrder: vi.fn(() => ({ accepted: true })),
		commitHookEventOrder: vi.fn(),
	} as unknown as TerminalSessionManager;
	manager.applyProviderHook = vi.fn((taskId, input) => {
		const summary = store.getSummary?.(taskId) ?? null;
		if (!summary) return null;
		const providerEvent: Parameters<typeof reduceSessionTransition>[1] = {
			type: "provider.hook" as const,
			event: input.event,
			metadata: input.metadata,
			occurredAt: input.delivery?.occurredAt,
			correlatedToolUseId: input.metadata?.toolUseId ?? null,
			sessionEvidence: "live",
		};
		const providerResult = reduceSessionTransition(summary, providerEvent);
		if (providerResult.changed) {
			const reviewReason = providerResult.patch.reviewReason;
			const configuredSummary =
				providerResult.patch.state === "awaiting_review"
					? toReviewSummary?.(
							taskId,
							reviewReason === "attention" || reviewReason === "error" ? reviewReason : "hook",
						)
					: providerResult.patch.state === "running"
						? toRunningSummary?.(taskId)
						: null;
			if (configuredSummary) {
				return {
					...providerResult,
					summary: configuredSummary,
				};
			}
		}
		return {
			...providerResult,
			summary: providerResult.changed ? { ...summary, ...providerResult.patch } : summary,
		};
	});
	return manager;
}

export function mockStore(manager: TerminalSessionManager): Record<string, ReturnType<typeof vi.fn>> {
	return manager.store as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

export function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	const {
		lastProviderHookOccurredAt = null,
		nativeWorkEvidence = null,
		recentProviderHookDeliveryIds = [],
		recentProviderHookOrderObservations = [],
		...summaryOverrides
	} = overrides;
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
		lastProviderHookOccurredAt,
		recentProviderHookDeliveryIds,
		recentProviderHookOrderObservations,
		latestHookActivity: null,
		outstandingInteraction: null,
		nativeWorkEvidence,
		stalledSince: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...summaryOverrides,
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
		...overrides,
	});
}
