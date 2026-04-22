import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import type { PtySession } from "../../../src/terminal/pty-session";
import {
	createActiveProcessState,
	createProcessEntry,
	type ProcessEntry,
} from "../../../src/terminal/session-manager-types";
import { InMemorySessionSummaryStore } from "../../../src/terminal/session-summary-store";
import { SessionTransitionController } from "../../../src/terminal/session-transition-controller";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

function createMockSession(): PtySession {
	return {
		pid: 1234,
		write: vi.fn(),
		resize: vi.fn(),
		sendSignal: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
	} as unknown as PtySession;
}

function createEntry(taskId = "task-1"): ProcessEntry {
	const entry = createProcessEntry(taskId);
	entry.active = createActiveProcessState({
		session: createMockSession(),
		cols: 120,
		rows: 40,
		willAutoTrust: true,
	});
	return entry;
}

describe("SessionTransitionController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fans out summary updates only to active session listeners", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ taskId: "task-1" }),
			"task-2": createSummary({ taskId: "task-2" }),
		});

		const entries = new Map<string, ProcessEntry>();
		const activeEntry = createEntry("task-1");
		const onState = vi.fn();
		activeEntry.listeners.set(1, { onState });
		entries.set("task-1", activeEntry);
		entries.set("task-2", createProcessEntry("task-2"));

		const controller = new SessionTransitionController(store, entries);
		const summary = store.getSummary("task-1");
		expect(summary).not.toBeNull();
		if (!summary) {
			return;
		}

		controller.broadcastSummary(summary);

		expect(onState).toHaveBeenCalledTimes(1);
		const delivered = onState.mock.calls[0][0] as RuntimeTaskSessionSummary;
		expect(delivered).toEqual(summary);
		expect(delivered).not.toBe(summary);
	});

	it("owns review-transition side effects alongside the state-machine event", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "running", reviewReason: null }),
		});

		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) {
			return;
		}
		active.workspaceTrustBuffer = "trust prompt";
		active.awaitingCodexPromptAfterEnter = true;

		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const result = controller.applyTransitionEvent(entry, { type: "hook.to_review" });

		expect(result?.changed).toBe(true);
		expect(result?.summary.state).toBe("awaiting_review");
		expect(result?.summary.reviewReason).toBe("hook");
		expect(entry.active?.workspaceTrustBuffer).toBe("");
		expect(entry.active?.awaitingCodexPromptAfterEnter).toBe(false);
	});

	it("clears interrupt recovery when a transition returns the session to running", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "error",
				latestHookActivity: {
					source: "codex",
					activityText: "Waiting",
					hookEventName: "Stop",
					notificationType: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					conversationSummaryText: null,
				},
			}),
		});

		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) {
			return;
		}
		active.interruptRecoveryTimer = setTimeout(() => {}, 5_000);

		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const result = controller.applyTransitionEvent(entry, { type: "hook.to_in_progress" });

		expect(result?.changed).toBe(true);
		expect(result?.summary.state).toBe("running");
		expect(result?.summary.reviewReason).toBeNull();
		expect(entry.active?.interruptRecoveryTimer).toBeNull();
	});

	it("leaves process-side flags untouched when the transition is a no-op", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "idle", reviewReason: null }),
		});

		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) {
			return;
		}
		active.workspaceTrustBuffer = "keep";
		active.awaitingCodexPromptAfterEnter = true;

		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const result = controller.applyTransitionEvent(entry, { type: "hook.to_review" });

		expect(result?.changed).toBe(false);
		expect(result?.summary.state).toBe("idle");
		expect(entry.active?.workspaceTrustBuffer).toBe("keep");
		expect(entry.active?.awaitingCodexPromptAfterEnter).toBe(true);
	});
});
