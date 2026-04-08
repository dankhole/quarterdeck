import { describe, expect, it } from "vitest";

import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	checkDeadProcess,
	checkStaleHookActivity,
	isPermissionActivity,
	type ReconciliationEntry,
	reconciliationChecks,
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
	active: unknown = {},
): ReconciliationEntry {
	return {
		summary: createSummary(summaryOverrides),
		active,
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
		const entry = createEntry({ state: "running", pid: 999_999_999 }, null);
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

// ── reconciliationChecks ordering ─────────────────────────────────────────

describe("reconciliationChecks", () => {
	it("are ordered by priority: dead process > clear activity (24)", () => {
		expect(reconciliationChecks[0]).toBe(checkDeadProcess);
		expect(reconciliationChecks[1]).toBe(checkStaleHookActivity);
		expect(reconciliationChecks).toHaveLength(2);
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

	it("hook.to_in_progress from awaiting_review with exit reason is rejected (26)", () => {
		const summary = createSummary({ state: "awaiting_review", reviewReason: "exit" });
		const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });
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
		const entry = createEntry({ state: "running", pid: null }, null);
		expect(checkDeadProcess(entry, Date.now())).toBeNull();
	});
});
