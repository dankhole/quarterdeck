import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import type { PtySession } from "../../../src/terminal/pty-session";
import { scheduleInterruptRecovery } from "../../../src/terminal/session-interrupt-recovery";
import {
	createActiveProcessState,
	createProcessEntry,
	type ProcessEntry,
} from "../../../src/terminal/session-manager-types";
import { InMemorySessionSummaryStore } from "../../../src/terminal/session-summary-store";
import { SessionTransitionController } from "../../../src/terminal/session-transition-controller";
import { createTestProviderHookEvent } from "../../utilities/task-session-factory";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	const {
		outstandingInteraction = null,
		nativeWorkEvidence = null,
		lastProviderHookOccurredAt = null,
		recentProviderHookDeliveryIds = [],
		recentProviderHookOrderObservations = [],
		...summaryOverrides
	} = overrides;
	return {
		taskId: "task-1",
		sessionInstanceId: "session-test",
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
		lastProviderHookOccurredAt,
		recentProviderHookDeliveryIds,
		recentProviderHookOrderObservations,
		latestHookActivity: null,
		outstandingInteraction,
		nativeWorkEvidence,
		stalledSince: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...summaryOverrides,
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
		sessionInstanceId: "session-test",
		agentId: "codex",
		cols: 120,
		rows: 40,
		willAutoTrust: true,
	});
	return entry;
}

function currentProviderHook(
	event: "to_review" | "to_in_progress",
	options: { occurredAt?: number; sessionInstanceId?: string } = {},
) {
	return createTestProviderHookEvent(event, {
		source: "codex",
		occurredAt: options.occurredAt,
		metadata: { sessionInstanceId: options.sessionInstanceId ?? "session-test" },
	});
}

describe("SessionTransitionController", () => {
	it("settles native interruption after local Escape and keeps its causal fence until newer work", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createSummary({ state: "awaiting_review", reviewReason: "interrupted" }) });
		const entry = createEntry();
		const active = entry.active;
		if (!active) throw new Error("Missing active test process");
		active.lastInterruptAt = 100;
		active.interruptRecoveryStartedAt = 100;
		active.interruptRecoverySignal = "escape";
		active.interruptRecoveryTimer = setTimeout(() => {}, 5_000);
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const interrupt = createTestProviderHookEvent("to_review", {
			source: "codex",
			hookEventName: "Interrupt",
			occurredAt: 110,
			metadata: { sessionInstanceId: "session-test", sessionId: "session-1", turnId: "turn-1" },
		});
		expect(controller.applyTransitionEvent(entry, { ...interrupt, occurredAt: 99 })?.changed).toBe(false);
		expect(active.interruptRecoveryTimer).not.toBeNull();
		expect(controller.applyTransitionEvent(entry, interrupt)?.summary.reviewReason).toBe("interrupted");
		expect(active.interruptRecoveryTimer).toBeNull();
		expect(active.lastInterruptAt).toBe(110);
		expect(entry.suppressAutoRestartOnExit).toBe(true);
		expect(
			controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress", { occurredAt: 105 }))?.changed,
		).toBe(false);
		expect(
			controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress", { occurredAt: 120 }))?.summary
				.state,
		).toBe("running");
		expect(entry.suppressAutoRestartOnExit).toBe(false);
		expect(active.lastInterruptAt).toBe(110);
	});

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

		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const result = controller.applyTransitionEvent(entry, currentProviderHook("to_review"));

		expect(result?.changed).toBe(true);
		expect(result?.summary.state).toBe("awaiting_review");
		expect(result?.summary.reviewReason).toBe("hook");
		expect(entry.active?.workspaceTrustBuffer).toBe("");
	});

	it("owns running-transition side effects for direct store mutations", () => {
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
		active.resetOutputTransitionDetection = vi.fn();

		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const previous = store.getSummary("task-1");
		const summary = controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress"))?.summary ?? null;
		expect(previous).not.toBeNull();
		expect(summary).not.toBeNull();
		if (!summary) {
			return;
		}
		controller.observeSummaryChange(previous, summary);

		expect(summary.state).toBe("running");
		expect(summary.reviewReason).toBeNull();
		expect(entry.active?.interruptRecoveryTimer).toBeNull();
		expect(active.resetOutputTransitionDetection).toHaveBeenCalledTimes(1);
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

		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const result = controller.applyTransitionEvent(entry, currentProviderHook("to_review"));

		expect(result?.changed).toBe(false);
		expect(result?.summary.state).toBe("idle");
		expect(entry.active?.workspaceTrustBuffer).toBe("keep");
	});

	it("uses current live-process evidence to resume an interrupted review", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "awaiting_review", reviewReason: "interrupted" }),
		});

		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) return;
		active.interruptRecoveryTimer = setTimeout(() => {}, 5_000);
		active.interruptRecoveryStartedAt = 100;
		entry.suppressAutoRestartOnExit = true;
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));

		const hookEvent = currentProviderHook("to_in_progress", { occurredAt: 101 });
		const result = controller.applyTransitionEvent(entry, hookEvent);

		expect(result?.summary).toMatchObject({ state: "running", reviewReason: null });
		expect(active.interruptRecoveryTimer).toBeNull();
		expect(entry.suppressAutoRestartOnExit).toBe(false);
	});

	it("clears restart suppression when activity-style PreToolUse proves work", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createSummary({ state: "awaiting_review", reviewReason: "interrupted" }) });
		const entry = createEntry();
		if (!entry.active) throw new Error("missing fixture process");
		entry.active.lastInterruptAt = 100;
		entry.suppressAutoRestartOnExit = true;
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const result = controller.applyTransitionEvent(
			entry,
			createTestProviderHookEvent("activity", {
				source: "codex",
				hookEventName: "PreToolUse",
				occurredAt: 101,
				metadata: { sessionInstanceId: "session-test", turnId: "main", toolUseId: "fresh" },
			}),
		);
		expect(result?.summary.state).toBe("running");
		expect(entry.suppressAutoRestartOnExit).toBe(false);
		expect(entry.active.lastInterruptAt).toBe(100);
	});

	it("rejects pre-interrupt work after timer expiry and after newer work resumes", () => {
		vi.setSystemTime(10000);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createSummary({ state: "awaiting_review", reviewReason: "unconfirmed" }) });
		const entry = createEntry();
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress", { occurredAt: 10000 }));
		vi.setSystemTime(10100);
		scheduleInterruptRecovery(entry, "escape", {
			getEntry: () => entry,
			getSummary: () => store.getSummary("task-1"),
			applyTransitionEvent: (target, event) => controller.applyTransitionEvent(target, event),
		});
		vi.advanceTimersByTime(5001);
		const delayed = createTestProviderHookEvent("activity", {
			source: "codex",
			hookEventName: "PreToolUse",
			occurredAt: 10050,
			metadata: { sessionInstanceId: "session-test", turnId: "main", toolUseId: "delayed" },
		});
		expect(controller.applyTransitionEvent(entry, delayed)?.summary.state).toBe("awaiting_review");
		controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress", { occurredAt: 15102 }));
		const staleStop = currentProviderHook("to_review", { occurredAt: 10060 });
		expect(controller.applyTransitionEvent(entry, staleStop)?.summary.state).toBe("running");
		expect(entry.active?.lastInterruptAt).toBe(10100);
	});

	it("uses the first current foreground-start hook to enter Running", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "awaiting_review", reviewReason: "unconfirmed" }),
		});
		const entry = createEntry("task-1");
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));

		const result = controller.applyTransitionEvent(
			entry,
			createTestProviderHookEvent("to_in_progress", {
				source: "codex",
				hookEventName: "UserPromptSubmit",
				metadata: { sessionInstanceId: "session-test", turnId: "turn-1" },
			}),
		);

		expect(result?.summary).toMatchObject({
			state: "running",
			reviewReason: null,
			nativeWorkEvidence: {
				provider: "codex",
				sessionInstanceId: "session-test",
				turnId: "turn-1",
				hookEventName: "UserPromptSubmit",
			},
		});
	});

	it("uses a current completion hook to converge an interrupted review", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "awaiting_review", reviewReason: "interrupted" }),
		});
		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) return;
		active.interruptRecoveryStartedAt = 100;
		entry.suppressAutoRestartOnExit = true;
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));

		const result = controller.applyTransitionEvent(entry, currentProviderHook("to_review", { occurredAt: 101 }));

		expect(result?.summary).toMatchObject({ state: "awaiting_review", reviewReason: "hook" });
		expect(active.interruptRecoveryStartedAt).toBeNull();
		expect(entry.suppressAutoRestartOnExit).toBe(false);
	});

	it("refreshes current foreground execution evidence and clears interrupt policy", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "awaiting_review", reviewReason: "unconfirmed" }),
		});
		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) return;
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress", { occurredAt: 100 }));
		active.interruptRecoveryTimer = setTimeout(() => {}, 5_000);
		active.interruptRecoveryStartedAt = 100;
		entry.suppressAutoRestartOnExit = true;

		const result = controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress", { occurredAt: 101 }));

		expect(result?.changed).toBe(true);
		expect(result?.summary.state).toBe("running");
		expect(active.interruptRecoveryTimer).toBeNull();
		expect(entry.suppressAutoRestartOnExit).toBe(false);
	});

	it("keeps an admitted foreground execution Running until an authoritative lifecycle event ends it", async () => {
		vi.setSystemTime(1_000);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "awaiting_review", reviewReason: "unconfirmed" }),
		});
		const entry = createEntry("task-1");
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		const previous = store.getSummary("task-1");
		const confirmed = controller.applyTransitionEvent(
			entry,
			currentProviderHook("to_in_progress", { occurredAt: 1_000 }),
		)?.summary;
		if (!confirmed) throw new Error("Expected a confirmed Running summary.");
		controller.observeSummaryChange(previous, confirmed);

		expect(confirmed.state).toBe("running");
		expect(confirmed.nativeWorkEvidence).toMatchObject({ confirmedAt: 1_000 });
		await vi.advanceTimersByTimeAsync(30 * 60_000);

		expect(store.getSummary("task-1")).toMatchObject({
			state: "running",
			reviewReason: null,
			nativeWorkEvidence: { confirmedAt: 1_000 },
		});

		const completed = controller.applyTransitionEvent(entry, currentProviderHook("to_review"));
		expect(completed?.summary).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			nativeWorkEvidence: null,
		});
	});

	it("does not treat an unscoped, stale-session, or pre-interrupt hook as current live-process evidence", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "awaiting_review", reviewReason: "interrupted" }),
		});
		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) return;
		active.interruptRecoveryStartedAt = 100;
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));

		const unscoped = createTestProviderHookEvent("to_in_progress", {
			source: "codex",
			occurredAt: 101,
		});
		const results = [
			controller.applyTransitionEvent(entry, unscoped),
			controller.applyTransitionEvent(
				entry,
				currentProviderHook("to_in_progress", { occurredAt: 101, sessionInstanceId: "stale-session" }),
			),
			controller.applyTransitionEvent(entry, currentProviderHook("to_review", { occurredAt: 99 })),
			controller.applyTransitionEvent(entry, {
				...currentProviderHook("to_in_progress", { occurredAt: 101 }),
				occurredAt: undefined,
			}),
			controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress", { occurredAt: 99 })),
		];
		expect(results.every((result) => result?.changed === false)).toBe(true);
		expect(store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
		});
	});

	it("does not revive a PTY whose explicit stop has begun", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "awaiting_review", reviewReason: "interrupted" }),
		});

		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) return;
		vi.mocked(active.session.wasInterrupted).mockReturnValue(true);
		entry.suppressAutoRestartOnExit = true;
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));

		const result = controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress"));

		expect(result?.changed).toBe(false);
		expect(result?.summary).toMatchObject({ state: "awaiting_review", reviewReason: "interrupted" });
		expect(entry.suppressAutoRestartOnExit).toBe(true);
	});

	it("does not treat a Claude subagent hook as foreground interrupt-recovery evidence", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
				agentId: "claude",
			}),
		});
		const entry = createEntry("task-1");
		if (!entry.active) throw new Error("Expected active test session.");
		entry.active.agentId = "claude";
		entry.active.interruptRecoveryTimer = setTimeout(() => {}, 5_000);
		entry.active.interruptRecoveryStartedAt = 100;
		entry.suppressAutoRestartOnExit = true;
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));

		const result = controller.applyTransitionEvent(
			entry,
			createTestProviderHookEvent("to_in_progress", {
				source: "claude",
				occurredAt: 101,
				hookEventName: "PreToolUse",
				metadata: {
					sessionInstanceId: "session-test",
					toolUseId: "subagent-tool-1",
					providerAgentId: "subagent-1",
				},
			}),
		);

		expect(result?.changed).toBe(false);
		expect(result?.summary).toMatchObject({ state: "awaiting_review", reviewReason: "interrupted" });
		expect(entry.active.interruptRecoveryTimer).not.toBeNull();
		expect(entry.suppressAutoRestartOnExit).toBe(true);
	});

	it("owns missing-launch-path recovery and keeps the pid until process exit", () => {
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createSummary({ state: "awaiting_review", reviewReason: "unconfirmed", pid: 1234 }),
		});
		const entry = createEntry("task-1");
		const active = entry.active;
		expect(active).not.toBeNull();
		if (!active) return;
		const controller = new SessionTransitionController(store, new Map([["task-1", entry]]));
		controller.applyTransitionEvent(entry, currentProviderHook("to_in_progress"));
		active.interruptRecoveryTimer = setTimeout(() => {}, 5_000);
		active.workspaceTrustConfirmTimer = setTimeout(() => {}, 5_000);

		const summary = controller.recoverMissingLaunchPath(entry, "Launch folder missing.");

		expect(summary).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			pid: 1234,
			warningMessage: "Launch folder missing.",
		});
		expect(entry.suppressAutoRestartOnExit).toBe(true);
		expect(active.interruptRecoveryTimer).toBeNull();
		expect(active.workspaceTrustConfirmTimer).toBeNull();
		expect(active.session.stop).toHaveBeenCalledWith({ interrupted: true });
	});
});
