import { describe, expect, it } from "vitest";

import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../src/core";
import {
	checkDeadProcess,
	checkMissingSessionLaunchPath,
	checkProcesslessActiveSession,
	checkStaleHookActivity,
	isPermissionActivity,
	type ReconciliationEntry,
	reconciliationChecks,
	reduceSessionTransition,
} from "../../../src/terminal";
import {
	createTestProviderHookEvent,
	createTestTaskHookActivity,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		state: "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		...overrides,
	});
}

function createEntry(
	summaryOverrides: Partial<RuntimeTaskSessionSummary> = {},
	options: {
		active?: unknown;
		restartRequest?: unknown;
		pendingAutoRestart?: unknown;
		pendingSessionStart?: boolean;
		pendingStartupRecoveryToken?: string | null;
		suppressAutoRestartOnExit?: boolean;
		sessionLaunchPathExists?: boolean | null;
	} = {},
): ReconciliationEntry {
	return {
		summary: createSummary(summaryOverrides),
		active: "active" in options ? options.active : {},
		restartRequest: options.restartRequest !== undefined ? options.restartRequest : null,
		pendingAutoRestart: options.pendingAutoRestart !== undefined ? options.pendingAutoRestart : null,
		pendingSessionStart: options.pendingSessionStart ?? false,
		pendingStartupRecoveryToken: options.pendingStartupRecoveryToken ?? null,
		suppressAutoRestartOnExit: options.suppressAutoRestartOnExit ?? false,
		sessionLaunchPathExists: options.sessionLaunchPathExists ?? true,
	};
}

function permissionActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
	return createTestTaskHookActivity({
		hookEventName: "PermissionRequest",
		activityText: "Waiting for approval",
		source: "claude",
		...overrides,
	});
}

function toolActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
	return createTestTaskHookActivity({
		hookEventName: "ToolUse",
		notificationType: "tool_use",
		activityText: "Running bash",
		toolName: "bash",
		toolInputSummary: "ls -la",
		source: "claude",
		...overrides,
	});
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

	it("returns null for canonical error Review (6a)", () => {
		const entry = createEntry({
			state: "awaiting_review",
			reviewReason: "error",
			pid: null,
			latestHookActivity: null,
		});
		expect(checkDeadProcess(entry, Date.now())).toBeNull();
	});
});

// ── checkMissingSessionLaunchPath ───────────────────────────────────────

describe("checkMissingSessionLaunchPath", () => {
	it("recovers a running process whose launch directory disappeared", () => {
		const entry = createEntry({ state: "running" }, { sessionLaunchPathExists: false });
		expect(checkMissingSessionLaunchPath(entry, Date.now())).toEqual({ type: "recover_missing_launch_path" });
	});

	it("also stops an awaiting-review process whose launch directory disappeared", () => {
		const entry = createEntry({ state: "awaiting_review", reviewReason: "hook" }, { sessionLaunchPathExists: false });
		expect(checkMissingSessionLaunchPath(entry, Date.now())).toEqual({ type: "recover_missing_launch_path" });
	});

	it("does nothing while the session is already being stopped", () => {
		const entry = createEntry(
			{ state: "running" },
			{ sessionLaunchPathExists: false, suppressAutoRestartOnExit: true },
		);
		expect(checkMissingSessionLaunchPath(entry, Date.now())).toBeNull();
	});

	it("does nothing for an existing, absent, or inactive launch directory", () => {
		expect(checkMissingSessionLaunchPath(createEntry(), Date.now())).toBeNull();
		expect(
			checkMissingSessionLaunchPath(
				createEntry({ sessionLaunchPath: null }, { sessionLaunchPathExists: null }),
				Date.now(),
			),
		).toBeNull();
		expect(
			checkMissingSessionLaunchPath(createEntry({}, { active: null, sessionLaunchPathExists: false }), Date.now()),
		).toBeNull();
	});

	it("does nothing during another start or recovery operation", () => {
		expect(
			checkMissingSessionLaunchPath(
				createEntry({}, { sessionLaunchPathExists: false, pendingSessionStart: true }),
				Date.now(),
			),
		).toBeNull();
		expect(
			checkMissingSessionLaunchPath(
				createEntry({}, { sessionLaunchPathExists: false, pendingStartupRecoveryToken: "recovery" }),
				Date.now(),
			),
		).toBeNull();
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

	it("returns null for awaiting_review/hook — agent completed, process dying is expected", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "hook" },
			{ active: null, restartRequest: { kind: "task" } },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("marks an unresolved interaction as unknown when its process disappears", () => {
		const entry = createEntry(
			{
				state: "awaiting_review",
				reviewReason: "hook",
				outstandingInteraction: {
					provider: "claude",
					kind: "permission",
					status: "response_submitted",
					requestEventName: "PermissionRequest",
					openedAt: 100,
					updatedAt: 110,
					responseSubmittedAt: 110,
					responseKind: "submit",
					sessionInstanceId: "instance-1",
					providerSessionId: "session-1",
					turnId: null,
					promptId: "prompt-1",
					toolUseId: "tool-1",
					elicitationId: null,
					providerAgentId: null,
					toolName: "Bash",
				},
			},
			{ active: null, restartRequest: { kind: "task" } },
		);

		expect(checkProcesslessActiveSession(entry, Date.now())).toEqual({ type: "mark_processless_error" });
	});

	it("does not repeatedly reconcile an interaction already marked resolution unknown", () => {
		const entry = createEntry(
			{
				state: "awaiting_review",
				reviewReason: "error",
				outstandingInteraction: {
					provider: "codex",
					kind: "permission",
					status: "resolution_unknown",
					requestEventName: "permission_prompt",
					openedAt: 100,
					updatedAt: 120,
					responseSubmittedAt: 110,
					responseKind: "cancel",
					sessionInstanceId: "instance-1",
					providerSessionId: "session-1",
					turnId: "turn-1",
					promptId: null,
					toolUseId: "tool-1",
					elicitationId: null,
					providerAgentId: null,
					toolName: "Bash",
				},
			},
			{ active: null, restartRequest: { kind: "task" } },
		);

		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
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

	it("returns null for awaiting_review/attention — review state, not an error", () => {
		const entry = createEntry(
			{ state: "awaiting_review", reviewReason: "attention" },
			{ active: null, restartRequest: { kind: "task" } },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("returns null when pendingSessionStart is true (session spawn in-flight)", () => {
		const entry = createEntry(
			{ state: "running" },
			{ active: null, restartRequest: { kind: "task" }, pendingSessionStart: true },
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});

	it("does not mark a queued startup recovery as processless", () => {
		const entry = createEntry(
			{ state: "running" },
			{
				active: null,
				restartRequest: { kind: "task" },
				pendingStartupRecoveryToken: "recovery-token",
			},
		);
		expect(checkProcesslessActiveSession(entry, Date.now())).toBeNull();
	});
});

// ── checkInterruptedNoRestart ────────────────────────────────────────────

// ── reconciliationChecks ordering ─────────────────────────────────────────

describe("reconciliationChecks", () => {
	it("are ordered by priority: dead process > missing cwd > processless recovery > clear activity (24)", () => {
		expect(reconciliationChecks[0]).toBe(checkDeadProcess);
		expect(reconciliationChecks[1]).toBe(checkMissingSessionLaunchPath);
		expect(reconciliationChecks[2]).toBe(checkProcesslessActiveSession);
		expect(reconciliationChecks[3]).toBe(checkStaleHookActivity);
		expect(reconciliationChecks).toHaveLength(4);
	});
});

// ── State machine regression tests ────────────────────────────────────────

describe("session-state-machine regression for reconciliation", () => {
	it("a provider working hook from awaiting_review with hook reason transitions to running (25)", () => {
		const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));
		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("running");
		expect(result.patch.reviewReason).toBeNull();
	});

	it("a provider working hook from awaiting_review with exit reason transitions to running (26)", () => {
		const summary = createSummary({ state: "awaiting_review", reviewReason: "exit" });
		const result = reduceSessionTransition(summary, createTestProviderHookEvent("to_in_progress"));
		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("running");
		expect(result.patch.reviewReason).toBeNull();
	});

	it("autorestart.denied leaves canonical interrupted Review unchanged", () => {
		const summary = createSummary({ state: "awaiting_review", reviewReason: "interrupted" });
		const result = reduceSessionTransition(summary, { type: "autorestart.denied" });
		expect(result.changed).toBe(false);
		expect(result.patch).toEqual({});
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
