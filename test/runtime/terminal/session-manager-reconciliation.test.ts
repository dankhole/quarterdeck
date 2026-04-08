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

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

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

const defaultTaskRequest = {
	taskId: "task-1",
	agentId: "claude" as const,
	binary: "claude",
	args: [] as string[],
	cwd: "/tmp/task-1",
	prompt: "Fix the bug",
};

/**
 * Helper: applies permission hook activity while session is running, then
 * triggers Escape → 5s interrupt recovery → "awaiting_review"/"attention"
 * with stale latestHookActivity. This is the Path 1 sequence from the spec.
 * Escape only triggers interrupt recovery from state === "running", so this
 * must be called before any transitionToReview.
 */
async function setupStalePermissionAfterEscape(manager: TerminalSessionManager, taskId: string): Promise<void> {
	manager.applyHookActivity(taskId, {
		hookEventName: "PermissionRequest",
		activityText: "Waiting for approval",
		source: "claude",
	});
	manager.writeInput(taskId, Buffer.from([0x1b]));
	await vi.advanceTimersByTimeAsync(5_000);
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

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		expect(manager.getSummary("task-1")?.state).toBe("running");
		manager.startReconciliation();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("error");

		manager.stopReconciliation();
	});

	it("startReconciliation is idempotent (28)", async () => {
		setupMockPtySpawn(DEAD_PID);

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		manager.startReconciliation();
		manager.startReconciliation(); // second call should be a no-op

		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");

		manager.stopReconciliation();
	});

	it("stopReconciliation clears the timer (29)", async () => {
		// Use process.pid (alive) so dead process check doesn't interfere
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		await setupStalePermissionAfterEscape(manager, "task-1");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("attention");
		expect(manager.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.startReconciliation();
		manager.stopReconciliation();

		// After 10s, no reconciliation should fire
		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.getSummary("task-1")?.latestHookActivity).not.toBeNull();
	});

	it("dead process in running state triggers recovery (30)", async () => {
		setupMockPtySpawn(DEAD_PID);

		const onState = vi.fn();
		const onExit = vi.fn();
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState, onOutput: vi.fn(), onExit });
		await manager.startTaskSession(defaultTaskRequest);

		expect(manager.getSummary("task-1")?.state).toBe("running");
		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("error");
		expect(onExit).toHaveBeenCalledWith(null);

		manager.stopReconciliation();
	});

	it("dead process in awaiting_review state triggers recovery (31)", async () => {
		setupMockPtySpawn(DEAD_PID);

		const onExit = vi.fn();
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit });
		await manager.startTaskSession(defaultTaskRequest);

		manager.transitionToReview("task-1", "hook");
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("hook");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("error");
		expect(onExit).toHaveBeenCalledWith(null);

		manager.stopReconciliation();
	});

	it("stale permission badge cleared after Escape-triggered attention review (32)", async () => {
		// Use process.pid (alive) so dead process check doesn't interfere
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		await setupStalePermissionAfterEscape(manager, "task-1");
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("attention");
		expect(manager.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.getSummary("task-1")?.latestHookActivity).toBeNull();
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("attention");

		manager.stopReconciliation();
	});

	it("session resumes to running when output detected after review (33)", async () => {
		// Use process.pid (alive) so dead process check doesn't interfere
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		manager.transitionToReview("task-1", "hook");
		manager.applyHookActivity("task-1", {
			hookEventName: "PermissionRequest",
			source: "claude",
		});
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");

		// Advance time so output timestamp is strictly after hook timestamp
		await vi.advanceTimersByTimeAsync(1);

		// Agent produces output (updates lastOutputAt after lastHookAt)
		spawnedSessions[0]?.triggerData("agent resumed working\n");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.reviewReason).toBeNull();
		expect(manager.getSummary("task-1")?.latestHookActivity).toBeNull();

		manager.stopReconciliation();
	});

	it("legitimate awaiting_review with no output is not touched (34)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		manager.transitionToReview("task-1", "hook");
		manager.applyHookActivity("task-1", {
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		});

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("hook");
		expect(manager.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.stopReconciliation();
	});

	it("completed and interrupted sessions are not modified (35)", async () => {
		const manager = new TerminalSessionManager();
		// Hydrate with a completed session (no active process, no auto-restart risk)
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "exit",
				pid: null,
				exitCode: 0,
			}),
		});

		expect(manager.getSummary("task-1")?.reviewReason).toBe("exit");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("exit");

		manager.stopReconciliation();
	});

	it("onState listener receives corrected summary (36)", async () => {
		setupMockPtySpawn(process.pid);

		const onState = vi.fn();
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState, onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		await setupStalePermissionAfterEscape(manager, "task-1");
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
		const manager = new TerminalSessionManager();
		manager.onSummary(summaryListener);
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		await setupStalePermissionAfterEscape(manager, "task-1");
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

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		manager.applyHookActivity("task-1", {
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		});

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// Dead process takes priority → state becomes error review, not just activity cleared
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("error");

		manager.stopReconciliation();
	});

	it("error in one entry does not prevent checking others (39)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager();

		// Task 1: stale permission badge via Path 1
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);
		await setupStalePermissionAfterEscape(manager, "task-1");
		expect(manager.getSummary("task-1")?.reviewReason).toBe("attention");

		// Task 2: another stale permission badge via Path 1
		manager.attach("task-2", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({ ...defaultTaskRequest, taskId: "task-2" });
		await setupStalePermissionAfterEscape(manager, "task-2");
		expect(manager.getSummary("task-2")?.reviewReason).toBe("attention");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.getSummary("task-1")?.latestHookActivity).toBeNull();
		expect(manager.getSummary("task-2")?.latestHookActivity).toBeNull();

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

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		await setupStalePermissionAfterEscape(manager, "task-1");
		expect(manager.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// Reconciliation cleared it
		expect(manager.getSummary("task-1")?.latestHookActivity).toBeNull();

		// New hook arrives immediately after
		manager.applyHookActivity("task-1", {
			hookEventName: "ToolUse",
			activityText: "Running bash",
			source: "claude",
		});

		// Hook overwrites the cleared value
		expect(manager.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("ToolUse");

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

		const manager = new TerminalSessionManager();

		// Task A: running with dead PID
		manager.attach("task-a", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({ ...defaultTaskRequest, taskId: "task-a" });
		expect(manager.getSummary("task-a")?.state).toBe("running");

		// Task B: stale permission badge via Path 1 (with alive PID)
		manager.attach("task-b", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession({ ...defaultTaskRequest, taskId: "task-b" });
		await setupStalePermissionAfterEscape(manager, "task-b");
		expect(manager.getSummary("task-b")?.reviewReason).toBe("attention");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// Task A: dead process recovered
		expect(manager.getSummary("task-a")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-a")?.reviewReason).toBe("error");
		// Task B: stale permission cleared
		expect(manager.getSummary("task-b")?.latestHookActivity).toBeNull();

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

	it("transitionToRunning clears latestHookActivity (50)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		manager.transitionToReview("task-1", "hook");
		manager.applyHookActivity("task-1", {
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		});
		expect(manager.getSummary("task-1")?.latestHookActivity).not.toBeNull();

		manager.transitionToRunning("task-1");

		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.latestHookActivity).toBeNull();
	});

	it("transitionToRunning with null latestHookActivity is a no-op (51)", async () => {
		setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		// transitionToReview clears latestHookActivity before hook transition
		manager.transitionToReview("task-1", "hook");
		expect(manager.getSummary("task-1")?.latestHookActivity).toBeNull();

		manager.transitionToRunning("task-1");

		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.latestHookActivity).toBeNull();
	});

	it("resume_from_review action clears latestHookActivity before transition (52)", async () => {
		const spawnedSessions = setupMockPtySpawn(process.pid);

		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(defaultTaskRequest);

		manager.transitionToReview("task-1", "hook");
		manager.applyHookActivity("task-1", {
			hookEventName: "PermissionRequest",
			activityText: "Waiting for approval",
			source: "claude",
		});

		// Advance time so output timestamp is strictly after hook timestamp
		await vi.advanceTimersByTimeAsync(1);

		// Trigger terminal output (updates lastOutputAt after lastHookAt)
		spawnedSessions[0]?.triggerData("agent resumed working\n");

		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.latestHookActivity).toBeNull();

		manager.stopReconciliation();
	});
});
