import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import {
	deriveTaskIndicatorState,
	type RuntimeTaskHookActivity,
	type RuntimeTaskSessionSummary,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core";
import type { RuntimeDiagnostics } from "../../../src/diagnostics";
import {
	InMemorySessionSummaryStore,
	LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
	TerminalSessionManager,
} from "../../../src/terminal";
import { MISSING_SESSION_LAUNCH_PATH_WARNING } from "../../../src/terminal/session-reconciliation-sweep";
import { createTestProviderHookRequest, createTestTaskHookActivity } from "../../utilities/task-session-factory";

// PID that is guaranteed to NOT exist — used for dead process tests.
const DEAD_PID = 999_999_999;

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function setupMockPtySpawn(pid: number) {
	const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		const session = createMockPtySession(pid, request);
		spawnedSessions.push(session);
		return session;
	});
	return spawnedSessions;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

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
		state: "running",
		agentId: "claude",
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

const defaultTaskRequest = {
	taskId: "task-1",
	agentId: "claude" as const,
	binary: "claude",
	args: [] as string[],
	cwd: process.cwd(),
	prompt: "Fix the bug",
};

/**
 * Helper: simulates a legacy or externally patched interrupted review that
 * retained stale permission activity. New interrupt recovery clears this
 * metadata immediately, but reconciliation still defends persisted drift.
 */
function setupStalePermissionReview(manager: TerminalSessionManager, taskId: string): void {
	manager.store.update(taskId, {
		state: "awaiting_review",
		reviewReason: "interrupted",
		lastHookAt: Date.now(),
		latestHookActivity: createTestTaskHookActivity({
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		}),
	});
}

function seedHookActivity(manager: TerminalSessionManager, activity: Partial<RuntimeTaskHookActivity>): void {
	manager.store.update("task-1", {
		lastHookAt: Date.now(),
		latestHookActivity: createTestTaskHookActivity(activity),
	});
}

function applyCurrentProviderHook(
	manager: TerminalSessionManager,
	event: "activity" | "to_review" | "to_in_progress",
	options: { taskId?: string; hookEventName?: string; metadata?: Record<string, string> } = {},
) {
	const taskId = options.taskId ?? "task-1";
	const summary = manager.store.getSummary(taskId);
	if (!summary) throw new Error("Expected task session summary.");
	return manager.applyProviderHook(
		taskId,
		createTestProviderHookRequest(summary, event, {
			hookEventName: options.hookEventName,
			metadata: options.metadata,
		}),
	);
}

function setupDefaultMocks(): void {
	prepareAgentLaunchMock.mockReset();
	ptySessionSpawnMock.mockReset();
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
	}));
}

// ── Reconciliation Sweep Lifecycle ────────────────────────────────────────

describe("reconciliation sweep lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setupDefaultMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reconciliation sweep runs every 10s (27)", async () => {
		setupMockPtySpawn(DEAD_PID);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);
		applyCurrentProviderHook(manager, "to_in_progress");

		expect(manager.store.getSummary("task-1")?.state).toBe("running");
		manager.startReconciliation();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("error");

		manager.stopReconciliation();
	});

	it("startReconciliation is idempotent (28)", async () => {
		setupMockPtySpawn(DEAD_PID);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		manager.startReconciliation();
		manager.startReconciliation(); // second call should be a no-op

		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

		manager.stopReconciliation();
	});

	it("stopReconciliation clears the timer (29)", async () => {
		// Use process.pid (alive) so dead process check doesn't interfere
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		setupStalePermissionReview(manager, "task-1");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");
		expect(manager.store.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.startReconciliation();
		manager.stopReconciliation();

		// After 10s, no reconciliation should fire
		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.store.getSummary("task-1")?.latestHookActivity).not.toBeNull();
	});

	it("dead process in running state triggers recovery (30)", async () => {
		setupMockPtySpawn(DEAD_PID);

		const onState = vi.fn();
		const onExit = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput: vi.fn(), onExit });
		await manager.startTaskSession(defaultTaskRequest);
		applyCurrentProviderHook(manager, "to_in_progress");

		expect(manager.store.getSummary("task-1")?.state).toBe("running");
		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("error");
		expect(onExit).toHaveBeenCalledWith(null);

		manager.stopReconciliation();
	});

	it("dead process in awaiting_review preserves review reason (31)", async () => {
		setupMockPtySpawn(DEAD_PID);

		const onExit = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// Process dying after the agent already handed off is cleanup noise —
		// the review reason should stay "hook", not flip to "error".
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");
		expect(onExit).toHaveBeenCalledWith(null);

		manager.stopReconciliation();
	});

	it("stops a live session and moves it to error review when its launch directory disappears", async () => {
		const spawnedSessions = setupMockPtySpawn(process.pid);
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({
			...defaultTaskRequest,
			cwd: "/tmp/quarterdeck-reconciliation-missing-launch-path",
		});

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(spawnedSessions[0]?.stop).toHaveBeenCalledWith({ interrupted: true });
		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			pid: process.pid,
			latestHookActivity: null,
			warningMessage: MISSING_SESSION_LAUNCH_PATH_WARNING,
		});

		manager.stopReconciliation();
	});

	it("stale permission badge is cleared from an interrupted review (32)", async () => {
		// Use process.pid (alive) so dead process check doesn't interfere
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		setupStalePermissionReview(manager, "task-1");
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");
		expect(manager.store.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.store.getSummary("task-1")?.latestHookActivity).toBeNull();
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");

		manager.stopReconciliation();
	});

	it("awaiting_review with terminal output is not falsely resumed (33)", async () => {
		// Agents produce incidental terminal output (spinners, status bars, prompt redraws)
		// while genuinely awaiting review. Reconciliation must not interpret this as "resumed."
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

		await vi.advanceTimersByTimeAsync(1);
		spawnedSessions[0]?.triggerData("status bar update\n");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");

		manager.stopReconciliation();
	});

	it("explicitly stopped sessions are not promoted by reconciliation", async () => {
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		seedHookActivity(manager, {
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		});
		manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");
		expect(manager.store.getSummary("task-1")?.latestHookActivity).toBeNull();

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");
		expect(manager.store.getSummary("task-1")?.latestHookActivity).toBeNull();

		manager.stopReconciliation();
	});

	it("legitimate awaiting_review with no output is not touched (34)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");
		seedHookActivity(manager, {
			hookEventName: "StatusUpdate",
			activityText: "Prior turn complete",
			source: "claude",
		});

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");
		expect(manager.store.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.stopReconciliation();
	});

	it("hydrated awaiting_review sessions with terminal review reasons are preserved (35)", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		// Sessions with terminal review reasons (exit, hook, error, etc.)
		// represent completed agent work and are preserved across restarts.
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "exit",
				pid: null,
				exitCode: 0,
			}),
		});

		// Terminal review reason preserved — not re-marked as interrupted
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("exit");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// No reconciliation action needed — session stays as-is
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("exit");

		manager.stopReconciliation();
	});

	it("preserves an interactive hook review while marking its stale process for startup recovery", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				pid: 1234,
				resumeSessionId: "session-1",
			}),
		});

		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			startupRecoveryRequired: true,
		});
		expect(manager.beginStartupRecovery("task-1", "recovery-1")).toBe(true);
		manager.completeStartupRecovery("task-1", "recovery-1");
		expect(manager.store.getSummary("task-1")?.startupRecoveryRequired).toBe(false);
	});

	it("keeps startup recovery eligibility durable after a second runtime hydration", () => {
		const firstRuntime = new TerminalSessionManager(new InMemorySessionSummaryStore());
		firstRuntime.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				pid: 1234,
			}),
		});
		const persisted = firstRuntime.store.getSummary("task-1");
		if (!persisted) {
			throw new Error("Expected the first runtime to hydrate the task.");
		}

		const secondRuntime = new TerminalSessionManager(new InMemorySessionSummaryStore());
		secondRuntime.hydrateFromRecord({ "task-1": persisted });

		expect(secondRuntime.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			startupRecoveryRequired: true,
		});
	});

	it("clears a durable recovery handoff when the user explicitly stops the task", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
				startupRecoveryRequired: true,
			}),
		});

		manager.stopTaskSession("task-1");

		expect(manager.store.getSummary("task-1")?.startupRecoveryRequired).toBe(false);
	});

	it("preserves a processless attention wait for bounded startup recovery", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "attention",
				pid: null,
				resumeSessionId: "session-1",
				startupRecoveryRequired: true,
				outstandingInteraction: {
					provider: "claude",
					kind: "question",
					status: "waiting",
					requestEventName: "PreToolUse",
					openedAt: 1,
					updatedAt: 1,
					responseSubmittedAt: null,
					responseKind: null,
					sessionInstanceId: "process-1",
					providerSessionId: "session-1",
					turnId: null,
					promptId: null,
					toolUseId: "tool-1",
					elicitationId: null,
					providerAgentId: null,
					toolName: "AskUserQuestion",
				},
			}),
		});

		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "attention",
			pid: null,
			startupRecoveryRequired: true,
		});
	});

	it("clears a stale durable recovery handoff from unproven legacy attention", () => {
		const recordEvent = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore(), {
			projectId: "project-1",
			diagnostics: { recordEvent } as unknown as RuntimeDiagnostics,
		});
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "attention",
				pid: null,
				resumeSessionId: "session-1",
				startupRecoveryRequired: true,
				latestHookActivity: null,
			}),
		});

		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "attention",
			pid: null,
			startupRecoveryRequired: false,
		});
		expect(recordEvent).toHaveBeenCalledWith(
			"session.persisted_state_reconciled",
			expect.objectContaining({
				action: "stale_recovery_requirement_cleared",
				requiresStartupRecovery: false,
			}),
			expect.objectContaining({ projectId: "project-1", taskId: "task-1" }),
			expect.objectContaining({ level: "warn", essential: true }),
		);
	});

	it("preserves the cold-start semantic matrix used by cards, project pills, and notifications", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			running: createSummary({ taskId: "running", state: "running", reviewReason: null, pid: 111 }),
			review: createSummary({
				taskId: "review",
				state: "awaiting_review",
				reviewReason: "hook",
				pid: 222,
			}),
			needsInput: createSummary({
				taskId: "needsInput",
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
				latestHookActivity: {
					hookEventName: "PermissionRequest",
					activityText: "Waiting for approval",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					notificationType: "permission_prompt",
					source: "claude",
					conversationSummaryText: null,
				},
			}),
			error: createSummary({
				taskId: "error",
				state: "awaiting_review",
				reviewReason: "error",
				pid: 333,
			}),
		});

		const running = manager.store.getSummary("running");
		const review = manager.store.getSummary("review");
		const needsInput = manager.store.getSummary("needsInput");
		const error = manager.store.getSummary("error");
		if (!running || !review || !needsInput || !error) {
			throw new Error("Expected the complete cold-start state matrix to hydrate.");
		}

		expect(running).toMatchObject({ state: "awaiting_review", reviewReason: "interrupted", pid: null });
		expect(review).toMatchObject({ state: "awaiting_review", reviewReason: "hook", pid: null });
		expect(needsInput).toMatchObject({ state: "awaiting_review", reviewReason: "hook", pid: null });
		expect(error).toMatchObject({ state: "awaiting_review", reviewReason: "error", pid: null });
		expect(deriveTaskIndicatorState(review)).toMatchObject({ reviewReady: true, needsInput: false });
		expect(deriveTaskIndicatorState(needsInput)).toMatchObject({ reviewReady: false, needsInput: true });
		expect(deriveTaskIndicatorState(error)).toMatchObject({ failure: true, needsInput: false });
		expect(running.startupRecoveryRequired).toBe(true);
		expect(review.startupRecoveryRequired).toBe(true);
		expect(error.startupRecoveryRequired).toBe(false);
	});

	it("hydrated awaiting_review sessions with non-terminal review reasons become interrupted (35b)", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		// Sessions with no terminal review reason were mid-restart — mark them
		// interrupted so resumeInterruptedSessions can restart them.
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: null,
				pid: null,
				exitCode: null,
			}),
		});

		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// Hydrated sessions have no restartRequest — reconciliation leaves them
		// in Review/Interrupted so resumeInterruptedSessions can restart them on
		// first UI connection.
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");

		manager.stopReconciliation();
	});

	it("marks legacy interrupted persistence as semantically uncertain without inventing a review state", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": runtimeTaskSessionSummarySchema.parse({
				...createSummary(),
				state: "interrupted",
				reviewReason: "interrupted",
				pid: null,
				startupRecoveryRequired: undefined,
			}),
		});

		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			startupRecoveryRequired: true,
			startupRecoverySemanticStateUncertain: true,
			warningMessage: LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
		});
	});

	it("keeps a restored legacy chat interrupted until new agent evidence establishes semantic state", async () => {
		setupMockPtySpawn(process.pid);
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": runtimeTaskSessionSummarySchema.parse({
				...createSummary(),
				state: "interrupted",
				reviewReason: "interrupted",
				pid: null,
				startupRecoveryRequired: undefined,
			}),
		});

		await manager.startTaskSession({
			...defaultTaskRequest,
			awaitReview: true,
			resumeSemanticState: {
				state: "awaiting_review",
				reviewReason: "interrupted",
				lastHookAt: null,
				latestHookActivity: null,
			},
			startupRecoverySemanticStateUncertain: true,
			startupRecoveryWarningMessage: LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
		});

		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: process.pid,
			startupRecoveryRequired: false,
			startupRecoverySemanticStateUncertain: true,
			warningMessage: LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
		});
	});

	it("hydrated explicitly stopped review sessions are preserved", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
				pid: null,
				exitCode: 0,
			}),
		});

		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");

		manager.stopReconciliation();
	});

	it("onState listener receives corrected summary (36)", async () => {
		setupMockPtySpawn(process.pid);

		const onState = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		setupStalePermissionReview(manager, "task-1");
		onState.mockClear();

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(onState).toHaveBeenCalled();
		const lastCall = onState.mock.calls[onState.mock.calls.length - 1][0] as RuntimeTaskSessionSummary;
		expect(lastCall.latestHookActivity).toBeNull();

		manager.stopReconciliation();
	});

	it("emitSummary called for each correction (37)", async () => {
		setupMockPtySpawn(process.pid);

		const summaryListener = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.store.onChange(summaryListener);
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		setupStalePermissionReview(manager, "task-1");
		summaryListener.mockClear();

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(summaryListener).toHaveBeenCalled();
		const lastSummary = summaryListener.mock.calls[
			summaryListener.mock.calls.length - 1
		][0] as RuntimeTaskSessionSummary;
		expect(lastSummary.latestHookActivity).toBeNull();

		manager.stopReconciliation();
	});

	it("only one action applied per entry per sweep (38)", async () => {
		setupMockPtySpawn(DEAD_PID);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		seedHookActivity(manager, {
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		});

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// Dead process takes priority → state becomes error review, not just activity cleared
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("error");

		manager.stopReconciliation();
	});

	it("error in one entry does not prevent checking others (39)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		// Task 1: stale permission badge on interrupted review
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);
		setupStalePermissionReview(manager, "task-1");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");

		// Task 2: another stale permission badge on interrupted review
		manager.attach("task-2", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({ ...defaultTaskRequest, taskId: "task-2" });
		setupStalePermissionReview(manager, "task-2");
		expect(manager.store.getSummary("task-2")?.reviewReason).toBe("interrupted");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.store.getSummary("task-1")?.latestHookActivity).toBeNull();
		expect(manager.store.getSummary("task-2")?.latestHookActivity).toBeNull();

		manager.stopReconciliation();
	});
});

// ── Incidental Terminal Output (Regression Guards) ───────────────────────
// Agents produce continuous terminal output (spinners, status bars, ANSI redraws)
// while genuinely idle or awaiting user input. These tests model realistic agent
// behavior to ensure reconciliation never misinterprets incidental output as
// evidence that the agent resumed working.

describe("incidental terminal output does not affect review state", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setupDefaultMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("terminal output does not update lastOutputAt or emit state summaries", async () => {
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const onState = vi.fn();
		const onOutput = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput, onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		expect(manager.store.getSummary("task-1")?.lastOutputAt).toBeNull();
		onState.mockClear();
		onOutput.mockClear();

		spawnedSessions[0]?.triggerData("status bar update\n");

		expect(onOutput).toHaveBeenCalled();
		expect(onState).not.toHaveBeenCalled();
		expect(manager.store.getSummary("task-1")?.lastOutputAt).toBeNull();

		manager.stopReconciliation();
	});

	it("continuous status bar updates over 60s do not resume from review (60)", async () => {
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");
		seedHookActivity(manager, {
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		});

		manager.startReconciliation();

		// Simulate Claude Code status bar updating every 2s for 60 seconds
		for (let elapsed = 0; elapsed < 60_000; elapsed += 2_000) {
			spawnedSessions[0]?.triggerData("\x1b[1;1H\x1b[K⏳ Waiting for permission...\x1b[0m");
			await vi.advanceTimersByTimeAsync(2_000);

			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");
		}

		manager.stopReconciliation();
	});

	it("spinner output across multiple reconciliation sweeps stays in review (61)", async () => {
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");

		manager.startReconciliation();

		// Each iteration: output right before sweep, then sweep fires
		const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		for (let sweep = 0; sweep < 5; sweep++) {
			// Output arrives mid-interval
			await vi.advanceTimersByTimeAsync(5_000);
			spawnedSessions[0]?.triggerData(`\r${spinnerFrames[sweep % spinnerFrames.length]} Processing...`);

			// Reconciliation sweep fires
			await vi.advanceTimersByTimeAsync(5_000);

			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		}

		manager.stopReconciliation();
	});

	it("permission badge preserved despite terminal output (62)", async () => {
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");
		seedHookActivity(manager, {
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		});

		manager.startReconciliation();

		// Terminal output well after hook
		await vi.advanceTimersByTimeAsync(15_000);
		spawnedSessions[0]?.triggerData("prompt redraw after 15s");
		await vi.advanceTimersByTimeAsync(10_000);

		// Both state and activity badge must survive
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");
		expect(manager.store.getSummary("task-1")?.latestHookActivity).not.toBeNull();
		expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("PermissionRequest");

		manager.stopReconciliation();
	});

	it("only a proper to_in_progress hook transitions out of review (63)", async () => {
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");

		manager.startReconciliation();

		// Lots of output — should not matter
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(3_000);
			spawnedSessions[0]?.triggerData(`output burst ${i}\n`);
		}
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

		// Only an explicit hook transition should move it to running
		const working = applyCurrentProviderHook(manager, "to_in_progress");
		expect({
			changed: working?.changed,
			state: working?.summary.state,
			reason: working?.summary.reviewReason,
			interaction: working?.summary.outstandingInteraction,
			metadataMode: working?.hookMetadataMode,
		}).toEqual({ changed: true, state: "running", reason: null, interaction: null, metadataMode: "apply" });
		expect(manager.store.getSummary("task-1")?.state).toBe("running");

		manager.stopReconciliation();
	});
});

// ── Edge Cases (Integration) ──────────────────────────────────────────────

describe("reconciliation integration edge cases", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setupDefaultMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("concurrent hook and reconciliation (43)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		setupStalePermissionReview(manager, "task-1");
		expect(manager.store.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// Reconciliation cleared it
		expect(manager.store.getSummary("task-1")?.latestHookActivity).toBeNull();

		// New hook arrives immediately after
		applyCurrentProviderHook(manager, "activity", {
			hookEventName: "ToolUse",
			metadata: { activityText: "Running bash" },
		});

		// Hook overwrites the cleared value
		expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("ToolUse");

		manager.stopReconciliation();
	});

	it("multiple entries with different corrections (44)", async () => {
		// Task A: dead process
		ptySessionSpawnMock.mockImplementationOnce((request: MockSpawnRequest) =>
			createMockPtySession(DEAD_PID, request),
		);
		// Task B: alive process
		ptySessionSpawnMock.mockImplementationOnce((request: MockSpawnRequest) =>
			createMockPtySession(process.pid, request),
		);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		// Task A: running with dead PID
		manager.attach("task-a", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({ ...defaultTaskRequest, taskId: "task-a" });
		applyCurrentProviderHook(manager, "to_in_progress", { taskId: "task-a" });
		expect(manager.store.getSummary("task-a")?.state).toBe("running");

		// Task B: stale permission badge on interrupted review (with alive PID)
		manager.attach("task-b", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({ ...defaultTaskRequest, taskId: "task-b" });
		setupStalePermissionReview(manager, "task-b");
		expect(manager.store.getSummary("task-b")?.reviewReason).toBe("interrupted");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// Task A: dead process recovered
		expect(manager.store.getSummary("task-a")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-a")?.reviewReason).toBe("error");
		// Task B: stale permission cleared
		expect(manager.store.getSummary("task-b")?.latestHookActivity).toBeNull();

		manager.stopReconciliation();
	});
});

// ── Phase 3: Proactive Clearing ───────────────────────────────────────────

describe("Phase 3: proactive latestHookActivity clearing", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setupDefaultMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a provider working hook replaces stale activity with current evidence (50)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");
		seedHookActivity(manager, {
			hookEventName: "StatusUpdate",
			activityText: "Prior turn complete",
			source: "claude",
		});
		expect(manager.store.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		const working = applyCurrentProviderHook(manager, "to_in_progress");
		expect({
			changed: working?.changed,
			state: working?.summary.state,
			reason: working?.summary.reviewReason,
			interaction: working?.summary.outstandingInteraction,
			metadataMode: working?.hookMetadataMode,
		}).toEqual({ changed: true, state: "running", reason: null, interaction: null, metadataMode: "apply" });

		expect(manager.store.getSummary("task-1")?.state).toBe("running");
		expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("PreToolUse");
	});

	it("a provider working hook records current activity after an ordinary review (51)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		applyCurrentProviderHook(manager, "to_review");
		expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("Stop");

		applyCurrentProviderHook(manager, "to_in_progress");

		expect(manager.store.getSummary("task-1")?.state).toBe("running");
		expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("PreToolUse");
	});
});
