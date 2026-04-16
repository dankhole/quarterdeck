import { describe, expect, it, vi } from "vitest";
import {
	areSoundsSuppressed,
	deriveColumn,
	EVENT_PRIORITY,
	getSettleWindowMs,
	isEventSuppressedForProject,
	isTabVisible,
	resolveSessionSoundEvent,
	SETTLE_WINDOW_HOOK_MS,
	SETTLE_WINDOW_IMMEDIATE_MS,
} from "@/hooks/notifications/audible-notifications";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

function mockSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: "claude",
		workspacePath: "/tmp/repo",
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

describe("deriveColumn", () => {
	it("returns 'active' for running state", () => {
		expect(deriveColumn(mockSummary({ state: "running" }))).toBe("active");
	});

	it("returns 'silent' for interrupted state", () => {
		expect(deriveColumn(mockSummary({ state: "interrupted" }))).toBe("silent");
	});

	it("returns 'silent' for awaiting_review with interrupted reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "interrupted" }))).toBe("silent");
	});

	it("returns 'stopped' for awaiting_review with hook reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBe("stopped");
	});

	it("returns 'stopped' for awaiting_review with error reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe("stopped");
	});

	it("returns 'stopped' for awaiting_review with exit reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "exit" }))).toBe("stopped");
	});

	it("returns 'stopped' for awaiting_review with attention reason", () => {
		expect(deriveColumn(mockSummary({ state: "awaiting_review", reviewReason: "attention" }))).toBe("stopped");
	});

	it("returns 'stopped' for failed state", () => {
		expect(deriveColumn(mockSummary({ state: "failed" }))).toBe("stopped");
	});
});

describe("resolveSessionSoundEvent", () => {
	it("returns 'permission' for hook with approval activity", () => {
		const result = resolveSessionSoundEvent(
			mockSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					hookEventName: "PermissionRequest",
					notificationType: "permission.asked",
					activityText: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					source: null,
					conversationSummaryText: null,
				},
			}),
		);
		expect(result).toBe("permission");
	});

	it("returns 'review' for hook without approval activity", () => {
		const result = resolveSessionSoundEvent(
			mockSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					hookEventName: "SomeHook",
					notificationType: null,
					activityText: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					source: null,
					conversationSummaryText: null,
				},
			}),
		);
		expect(result).toBe("review");
	});

	it("returns 'review' for attention reason", () => {
		expect(resolveSessionSoundEvent(mockSummary({ state: "awaiting_review", reviewReason: "attention" }))).toBe(
			"review",
		);
	});

	it("returns 'review' for exit with code 0", () => {
		expect(
			resolveSessionSoundEvent(mockSummary({ state: "awaiting_review", reviewReason: "exit", exitCode: 0 })),
		).toBe("review");
	});

	it("returns 'failure' for exit with non-zero code", () => {
		expect(
			resolveSessionSoundEvent(mockSummary({ state: "awaiting_review", reviewReason: "exit", exitCode: 1 })),
		).toBe("failure");
	});

	it("returns 'failure' for exit with null code", () => {
		expect(
			resolveSessionSoundEvent(mockSummary({ state: "awaiting_review", reviewReason: "exit", exitCode: null })),
		).toBe("failure");
	});

	it("returns 'failure' for error reason", () => {
		expect(resolveSessionSoundEvent(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe(
			"failure",
		);
	});

	it("returns null for interrupted reason", () => {
		expect(
			resolveSessionSoundEvent(mockSummary({ state: "awaiting_review", reviewReason: "interrupted" })),
		).toBeNull();
	});

	it("returns 'failure' for failed state", () => {
		expect(resolveSessionSoundEvent(mockSummary({ state: "failed" }))).toBe("failure");
	});

	it("returns null for running state", () => {
		expect(resolveSessionSoundEvent(mockSummary({ state: "running" }))).toBeNull();
	});
});

describe("getSettleWindowMs", () => {
	it("returns hook settle window for hook-based review", () => {
		expect(getSettleWindowMs(mockSummary({ state: "awaiting_review", reviewReason: "hook" }))).toBe(
			SETTLE_WINDOW_HOOK_MS,
		);
	});

	it("returns immediate for non-hook review", () => {
		expect(getSettleWindowMs(mockSummary({ state: "awaiting_review", reviewReason: "error" }))).toBe(
			SETTLE_WINDOW_IMMEDIATE_MS,
		);
	});

	it("returns immediate for non-review state", () => {
		expect(getSettleWindowMs(mockSummary({ state: "running" }))).toBe(SETTLE_WINDOW_IMMEDIATE_MS);
	});
});

describe("EVENT_PRIORITY", () => {
	it("failure > permission > review", () => {
		expect(EVENT_PRIORITY.failure).toBeGreaterThan(EVENT_PRIORITY.permission);
		expect(EVENT_PRIORITY.permission).toBeGreaterThan(EVENT_PRIORITY.review);
	});
});

describe("isTabVisible", () => {
	it("returns true when document is undefined (SSR)", () => {
		const original = globalThis.document;
		Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
		try {
			expect(isTabVisible()).toBe(true);
		} finally {
			Object.defineProperty(globalThis, "document", { value: original, configurable: true });
		}
	});

	it("returns true when visible and focused", () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		expect(isTabVisible()).toBe(true);
		vi.restoreAllMocks();
	});

	it("returns false when visible but not focused", () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		expect(isTabVisible()).toBe(false);
		vi.restoreAllMocks();
	});

	it("returns false when hidden", () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		expect(isTabVisible()).toBe(false);
		vi.restoreAllMocks();
	});
});

describe("areSoundsSuppressed", () => {
	it("returns true when disabled", () => {
		expect(areSoundsSuppressed(false, false)).toBe(true);
	});

	it("returns false when enabled and not only-when-hidden", () => {
		expect(areSoundsSuppressed(true, false)).toBe(false);
	});

	it("returns true when enabled, only-when-hidden, and tab visible+focused", () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		expect(areSoundsSuppressed(true, true)).toBe(true);
		vi.restoreAllMocks();
	});

	it("returns false when enabled, only-when-hidden, and tab not focused", () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		expect(areSoundsSuppressed(true, true)).toBe(false);
		vi.restoreAllMocks();
	});
});

describe("isEventSuppressedForProject", () => {
	const suppress = { permission: false, review: true, failure: false };

	it("returns false when no current project", () => {
		expect(isEventSuppressedForProject("review", suppress, "proj-a", null)).toBe(false);
	});

	it("returns true when event is suppressed and task matches project", () => {
		expect(isEventSuppressedForProject("review", suppress, "proj-a", "proj-a")).toBe(true);
	});

	it("returns false when event is suppressed but task is from different project", () => {
		expect(isEventSuppressedForProject("review", suppress, "proj-b", "proj-a")).toBe(false);
	});

	it("returns false when event type is not suppressed", () => {
		expect(isEventSuppressedForProject("failure", suppress, "proj-a", "proj-a")).toBe(false);
	});

	it("returns false when task workspace is undefined", () => {
		expect(isEventSuppressedForProject("review", suppress, undefined, "proj-a")).toBe(false);
	});
});
