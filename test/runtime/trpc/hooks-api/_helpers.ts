import { vi } from "vitest";

import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../../src/core/api-contract";
import type { TerminalSessionManager } from "../../../../src/terminal/session-manager";
import type { SessionSummaryStore } from "../../../../src/terminal/session-summary-store";
import { type CreateHooksApiDependencies, createHooksApi } from "../../../../src/trpc/hooks-api";

export function createMockManager(storeMethods: Partial<SessionSummaryStore>): TerminalSessionManager {
	return { store: storeMethods, recordHookReceived: vi.fn() } as unknown as TerminalSessionManager;
}

export function mockStore(manager: TerminalSessionManager): Record<string, ReturnType<typeof vi.fn>> {
	return manager.store as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

export function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
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
		workspaces: { getWorkspacePathById: vi.fn(() => "/tmp/repo") },
		terminals: {
			getTerminalManagerForWorkspace: vi.fn(() => null),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
		},
		broadcaster: { broadcastRuntimeWorkspaceStateUpdated: vi.fn(), broadcastTaskReadyForReview: vi.fn() },
		...overrides,
	});
}
