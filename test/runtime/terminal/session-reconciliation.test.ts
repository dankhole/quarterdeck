import { describe, expect, it } from "vitest";

import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	checkDeadProcess,
	checkInterruptedNoRestart,
	checkProcesslessActiveSession,
	checkStaleHookActivity,
	checkStalledSession,
	isPermissionActivity,
	type ReconciliationEntry,
	reconciliationChecks,
	STALLED_HOOK_THRESHOLD_MS,
} from "../../../src/terminal/session-reconciliation";
import { reduceSessionTransition } from "../../../src/terminal/session-state-machine";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
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
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

function createEntry(
	summaryOverrides: Partial<RuntimeTaskSessionSummary> = {},
	options: {
		active?: unknown;
		restartRequest?: unknown;
		pendingAutoRestart?: unknown;
		pendingSessionStart?: boolean;
	} = {},
): ReconciliationEntry {
	return {
		summary: createSummary(summaryOverrides),
		active: "active" in options ? options.active : {},
		restartRequest: options.restartRequest !== undefined ? options.restartRequest : null,
		pendingAutoRestart: options.pendingAutoRestart !== undefined ? options.pendingAutoRestart : null,
		pendingSessionStart: options.pendingSessionStart ?? false,
	};
}

function permissionActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
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

function toolActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
	return {
		hookEventName: "ToolUse",
		notificationType: "tool_use",
		activityText: "Running bash",
		toolName: "bash",
		toolInputSummary: "ls -la",
		finalMessage: null,
		source: "claude",
		conversationSummaryText: null,
		...overrides,
	};
}

// ── isPermissionActivity ──────────────────────────────────────────────────

describe("isPermissionActivity", () => {
	it("returns true for hookEventName PermissionRequest (24a)", () => {
		expect(isPermissionActivity(permissionActivity({ notificationType: null, activityText: null }))).toBe(true);
	});

	it("returns true for notificationType permission_prompt (24b)", () => {
		expect(
			isPermissionActivity(
				permissionActivity({ hookEventName: null, notificationType: "permission_prompt", activityText: null }),
			),
		).toBe(true);
	});

	it("returns true for notificationType permission.asked (24c)", () => {
		expect(
			isPermissionActivity(
				permissionActivity({ hookEventName: null, notificationType: "permission.asked", activityText: null }),
			),
		).toBe(true);
	});

	it("returns true for activityText Waiting for approval (24d)", () => {
		expect(isPermissionActivity(permissionActivity({ hookEventName: null, notificationType: null }))).toBe(true);
	});

	it("is case-insensitive (24e)", () => {
		expect(isPermissionActivity(permissionActivity({ hookEventName: "permissionrequest" }))).toBe(true);
		expect(isPermissionActivity(permissionActivity({ hookEventName: "PERMISSIONREQUEST" }))).toBe(true);
		expect(
			isPermissionActivity(permissionActivity({ hookEventName: null, notificationType: "Permission_Prompt" })),
		).toBe(true);
		expect(
			isPermissionActivity(
				permissionActivity({ hookEventName: null, notificationType: null, activityText: "WAITING FOR APPROVAL" }),
			),
		).toBe(true);
	});

	it("returns false for non-matching activity (24f)", () => {
		expect(isPermissionActivity(toolActivity())).toBe(false);
	});

	it("returns false for null/undefined fields (24g)", () => {
		expect(
			isPermissionActivity(permissionActivity({ hookEventName: null, notificationType: null, activityText: null })),
		).toBe(false);
	});
});

// ── checkDeadProcess ──────────────────────────────────────────────────────

describe("checkDeadProcess", () => {
	it("returns recover_dead_process for dead PID in running state (1)", () => {
		const entry = createEntry({ state: "running", pid: 999_999_999 });
		expect(checkDeadProcess(entry, Date.now())).toEqual({ type: "recover_dead_process" });
	});

	it("returns recover_dead_process for dead PID in awaiting_review state (2)", () => {
		const entry = createEntry({ state: "awaiting_review", reviewReason: "hook", pid: 999_999_999 });
		expect(checkDeadProcess(entry, Date.now())).toEqual({ type: "recover_dead_process" });
	});

	it("returns null for alive PID (3)", () => {
		const entry = createEntry({ state: "running", pid: process.pid });
		expect(checkDeadProcess(entry, Date.now())).toBeNull();
	});

	it("returns null when pid is null (4)", () => {
		const entry = createEntry({ state: "running", pid: null });
		expect(checkDeadProcess(entry, Date.now())).toBeNull();
	});

	it("returns null when entry.active is falsy (5)", () => {
		const entry = createEntry({ state: "running", pid: 999_999_999 }, { active: null });
		expect(checkDeadProcess(entry, Date.now())).toBeNull();
	});

	it("returns null for idle state (6)", () => {
		const entry = createEntry({ state: "idle", pid: 999_999_999 });
		expect(checkDeadProcess(entry, Date.now())).toBeNull();
	});

	it("returns null for failed state (6a)", () => {
		const entry = createEntry({ state: "failed", pid: null, latestHookActivity: null });
		expect(checkDeadProcess(entry, Date.now())).toBeNull();
	});
});

// ── checkStaleHookActivity ────────────────────────────────────────────────

describe("checkStaleHookActivity", () => {
	it("returns clear_hook_activity for permission fields on attention review (18)", () => {
		const entry = createEntry({
			state: "awaiting_review",
			reviewReason: "attention",
			latestHookActivity: permissionActivity(),
		});
		expect(checkStaleHookActivity(entry, Date.now())).toEqual({ type: "clear_hook_activity" });
	});

	it("returns clear_hook_activity for permission fields on running state (19)", () => {
		const entry = createEntry({
			state: "running",
			latestHookActivity: permissionActivity(),
		});
		expect(checkStaleHookActivity(entry, Date.now())).toEqual({ type: "clear_hook_activity" });
	});

	it("returns null when latestHookActivity is null (20)", () => {
		const entry = createEntry({
			state: "awaiting_review",
			reviewReason: "attention",
			latestHookActivity: null,
		});
		expect(checkStaleHookActivity(entry, Date.now())).toBeNull();
	});

	it("returns null for legitimate hook review with permission fields (21)", () => {
		const entry = createEntry({
			state: "awaiting_review",
			reviewReason: "hook",
			latestHookActivity: permissionActivity(),
			lastHookAt: 5000,
			lastOutputAt: null,
		});
		expect(checkStaleHookActivity(entry, 6000)).toBeNull();
	});

	it("returns null for hook review with permission fields even with recent output (22)", () => {
		const entry = createEntry({
			state: "awaiting_review",
			reviewReason: "hook",
			latestHookActivity: permissionActivity(),
			lastHookAt: 1000,
			lastOutputAt: 5000,
		});
		// Terminal output (spinners, status bars) should not clear a legitimate permission badge
		expect(checkStaleHookActivity(entry, 6000)).toBeNull();
	});

	it("returns null for non-permission hook activity on running state (23)", () => {
		const entry = createEntry({
			state: "running",
			latestHookActivity: toolActivity(),
		});
		expect(checkStaleHookActivity(entry, Date.now())).toBeNull();
	});

	it("returns clear_hook_activity for permission fields on exit review (23a)", () => {
		const entry = createEntry({
			state: "awaiting_review",
			reviewReason: "exit",
			latestHookActivity: permissionActivity(),
		});
		expect(checkStaleHookActivity(entry, Date.now())).toEqual({ type: "clear_hook_activity" });
	});

	it("returns clear_hook_activity for permission fields on error review (23b)", () => {
		const entry = createEntry({
			state: "awaiting_review",
			reviewReason: "error",
			latestHookActivity: permissionActivity(),
		});
		expect(checkStaleHookActivity(entry, Date.now())).toEqual({ type: "clear_hook_activity" });
	});
});

// ── checkProcesslessActiveSession ────────────────────────────────────────

describe("checkProcesslessActiveSession", () => {
	it("returns mark_processless_error for running state with no process and restartRequest set", () => {
		const entry = createEntry({ state: "running" }, { active: null, restartRequest: { kind: "task" } });
		expect(checkProcesslessActiveSession(entry, Date.now())).toEqual({ type: "mark_processless_error" });
	});

	it("returns mark_processless_error for awaiting_review/hook with no process and restartRequest set", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "hook" },
			{ active: null, restartRequest: { kind: "task" } },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toEqual({ type: "mark_processless_error" });
	});

	it("returns null when already in error state", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "error" },
			{ active: null, restartRequest: { kind: "task" } },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns null when active process exists", () => {
		const entry = createEntry({ state: "running" }, { active: {}, restartRequest: { kind: "task" } });
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns null when restartRequest is null (hydrated entry)", () => {
		const entry = createEntry({ state: "running" }, { active: null, restartRequest: null });
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns null when pendingAutoRestart is set", () => {
		const entry = createEntry(
			{ state: "running" },
			{ active: null, restartRequest: { kind: "task" }, pendingAutoRestart: Promise.resolve() },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns null for idle state", () => {
		const entry = createEntry({ state: "idle" }, { active: null, restartRequest: { kind: "task" } });
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns null for awaiting_review/exit (clean completion)", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "exit" },
			{ active: null, restartRequest: { kind: "task" } },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns null for awaiting_review/interrupted", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "interrupted" },
			{ active: null, restartRequest: { kind: "task" } },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns null for awaiting_review/stalled (agent still alive, just quiet)", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "stalled" },
			{ active: null, restartRequest: { kind: "task" } },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns mark_processless_error for awaiting_review/attention with no process", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "attention" },
			{ active: null, restartRequest: { kind: "task" } },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toEqual({ type: "mark_processless_error" });
	});

	it("returns null when pendingSessionStart is true (session spawn in-flight)", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "attention" },
			{ active: null, restartRequest: { kind: "task" }, pendingSessionStart: true },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});
});

// ── checkStalledSession ──────────────────────────────────────────────────

describe("checkStalledSession", () => {
	it("returns mark_stalled when hook gap exceeds threshold and no recent output", () => {
		const nowMs = Date.now();
		const lastHookAt = nowMs - STALLED_HOOK_THRESHOLD_MS - 1;
		const entry = createEntry({ state: "running", lastHookAt, lastOutputAt: lastHookAt, stalledSince: null });
		expect(checkStalledSession(entry, nowMs)).toEqual({ type: "mark_stalled" });
	});

	it("returns null when hook gap is within threshold", () => {
		const nowMs = Date.now();
		const lastHookAt = nowMs - STALLED_HOOK_THRESHOLD_MS + 1;
		const entry = createEntry({ state: "running", lastHookAt, lastOutputAt: lastHookAt, stalledSince: null });
		expect(checkStalledSession(entry, nowMs)).toBeNull();
	});

	it("returns null when lastHookAt is null (no hooks received yet)", () => {
		const entry = createEntry({ state: "running", lastHookAt: null, stalledSince: null });
		expect(checkStalledSession(entry, Date.now())).toBeNull();
	});

	it("returns null when already marked as stalled", () => {
		const nowMs = Date.now();
		const lastHookAt = nowMs - STALLED_HOOK_THRESHOLD_MS - 1;
		const entry = createEntry({ state: "running", lastHookAt, stalledSince: nowMs - 30_000 });
		expect(checkStalledSession(entry, nowMs)).toBeNull();
	});

	it("returns null for non-running states", () => {
		const nowMs = Date.now();
		const lastHookAt = nowMs - STALLED_HOOK_THRESHOLD_MS - 1;
		const awaitingReview = createEntry({
			state: "awaiting_review",
			reviewReason: "hook",
			lastHookAt,
			stalledSince: null,
		});
		expect(checkStalledSession(awaitingReview, nowMs)).toBeNull();

		const idle = createEntry({ state: "idle", lastHookAt, stalledSince: null });
		expect(checkStalledSession(idle, nowMs)).toBeNull();
	});

	it("returns null when hooks are stale but terminal output is recent", () => {
		const nowMs = Date.now();
		const lastHookAt = nowMs - STALLED_HOOK_THRESHOLD_MS - 1;
		const lastOutputAt = nowMs - 10_000; // output 10s ago — still active
		const entry = createEntry({ state: "running", lastHookAt, lastOutputAt, stalledSince: null });
		expect(checkStalledSession(entry, nowMs)).toBeNull();
	});

	it("returns mark_stalled when both hooks and output exceed threshold", () => {
		const nowMs = Date.now();
		const staleTime = nowMs - STALLED_HOOK_THRESHOLD_MS - 1;
		const entry = createEntry({
			state: "running",
			lastHookAt: staleTime,
			lastOutputAt: staleTime,
			stalledSince: null,
		});
		expect(checkStalledSession(entry, nowMs)).toEqual({ type: "mark_stalled" });
	});

	it("returns mark_stalled when lastOutputAt is null and hooks exceed threshold", () => {
		const nowMs = Date.now();
		const lastHookAt = nowMs - STALLED_HOOK_THRESHOLD_MS - 1;
		const entry = createEntry({ state: "running", lastHookAt, lastOutputAt: null, stalledSince: null });
		expect(checkStalledSession(entry, nowMs)).toEqual({ type: "mark_stalled" });
	});
});

// ── checkInterruptedNoRestart ────────────────────────────────────────────

describe("checkInterruptedNoRestart", () => {
	it("returns move_interrupted_to_review for interrupted session with no pending auto-restart", () => {
		const entry = createEntry({ state: "interrupted", reviewReason: "interrupted" });
		entry.pendingAutoRestart = null;
		expect(checkInterruptedNoRestart(entry, Date.now())).toEqual({ type: "move_interrupted_to_review" });
	});

	it("returns null when session is not interrupted", () => {
		const entry = createEntry({ state: "running" });
		expect(checkInterruptedNoRestart(entry, Date.now())).toBeNull();
	});

	it("returns null when session is awaiting_review", () => {
		const entry = createEntry({ state: "awaiting_review", reviewReason: "exit" });
		expect(checkInterruptedNoRestart(entry, Date.now())).toBeNull();
	});

	it("returns null when pendingAutoRestart is set", () => {
		const entry = createEntry({ state: "interrupted", reviewReason: "interrupted" });
		entry.pendingAutoRestart = Promise.resolve();
		expect(checkInterruptedNoRestart(entry, Date.now())).toBeNull();
	});
});

// ── reconciliationChecks ordering ─────────────────────────────────────────

describe("reconciliationChecks", () => {
	it("are ordered by priority: dead process > processless recovery > interrupted cleanup > clear activity > stalled (24)", () => {
		expect(reconciliationChecks[0]).toBe(checkDeadProcess);
		expect(reconciliationChecks[1]).toBe(checkProcesslessActiveSession);
		expect(reconciliationChecks[2]).toBe(checkInterruptedNoRestart);
		expect(reconciliationChecks[3]).toBe(checkStaleHookActivity);
		expect(reconciliationChecks[4]).toBe(checkStalledSession);
		expect(reconciliationChecks).toHaveLength(5);
	});
});

// ── State machine regression tests ────────────────────────────────────────

describe("session-state-machine regression for reconciliation", () => {
	it("hook.to_in_progress from awaiting_review with hook reason transitions to running (25)", () => {
		const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });
		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("running");
		expect(result.patch.reviewReason).toBeNull();
	});

	it("hook.to_in_progress from awaiting_review with exit reason transitions to running (26)", () => {
		const summary = createSummary({ state: "awaiting_review", reviewReason: "exit" });
		const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });
		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("running");
		expect(result.patch.reviewReason).toBeNull();
	});

	it("autorestart.denied transitions interrupted to awaiting_review", () => {
		const summary = createSummary({ state: "interrupted", reviewReason: "interrupted" });
		const result = reduceSessionTransition(summary, { type: "autorestart.denied" });
		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("awaiting_review");
		expect(result.patch.reviewReason).toBe("interrupted");
	});

	it("autorestart.denied is a no-op for non-interrupted states", () => {
		const summary = createSummary({ state: "running" });
		const result = reduceSessionTransition(summary, { type: "autorestart.denied" });
		expect(result.changed).toBe(false);
	});
});

// ── Edge cases ────────────────────────────────────────────────────────────

describe("reconciliation edge cases", () => {
	it("skips idle sessions — all checks return null (40)", () => {
		const entry = createEntry({
			state: "idle",
			latestHookActivity: permissionActivity(),
		});
		for (const check of reconciliationChecks) {
			expect(check(entry, Date.now())).toBeNull();
		}
	});

	it("skips sessions with no active handle and no pid (41)", () => {
		const entry = createEntry({ state: "running", pid: null }, { active: null });
		expect(checkDeadProcess(entry, Date.now())).toBeNull();
	});
});
