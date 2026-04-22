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

import type { RuntimeTaskSessionSummary } from "../../../src/core";
import { InMemorySessionSummaryStore, reduceSessionTransition, TerminalSessionManager } from "../../../src/terminal";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function setupMockPtySpawn() {
	const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
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

describe("TerminalSessionManager interrupt recovery", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("suppresses auto-restart when user sends Ctrl+C", async () => {
		const spawnedSessions = setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);

		// User sends Ctrl+C
		manager.writeInput("task-1", Buffer.from([0x03]));

		// Agent exits after receiving SIGINT
		spawnedSessions[0]?.triggerExit(130);
		await vi.advanceTimersByTimeAsync(100);

		// Should NOT have auto-restarted
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("error");
	});

	it("transitions to awaiting_review after Ctrl+C if agent stays running with no output", async () => {
		setupMockPtySpawn();

		const onState = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput: vi.fn() });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(manager.store.getSummary("task-1")?.state).toBe("running");

		// User sends Ctrl+C — agent doesn't exit
		manager.writeInput("task-1", Buffer.from([0x03]));

		// Wait for interrupt recovery timeout (5 seconds)
		await vi.advanceTimersByTimeAsync(5_000);

		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("attention");
	});

	it("transitions to awaiting_review after Escape if agent stays running with no output", async () => {
		setupMockPtySpawn();

		const onState = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput: vi.fn() });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(manager.store.getSummary("task-1")?.state).toBe("running");

		// User sends Escape — agent doesn't exit
		manager.writeInput("task-1", Buffer.from([0x1b]));

		// Wait for interrupt recovery timeout (5 seconds)
		await vi.advanceTimersByTimeAsync(5_000);

		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("attention");
	});

	it("does not trigger interrupt recovery for ANSI escape sequences", async () => {
		setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn() });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		// Arrow up key: ESC [ A (3 bytes starting with 0x1B)
		manager.writeInput("task-1", Buffer.from([0x1b, 0x5b, 0x41]));

		// Wait past the recovery timeout
		await vi.advanceTimersByTimeAsync(6_000);

		// Should still be running — multi-byte escape sequence is not a bare Escape
		expect(manager.store.getSummary("task-1")?.state).toBe("running");
	});

	it("still transitions to awaiting_review even if agent produces output after Ctrl+C", async () => {
		const spawnedSessions = setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn() });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		// User sends Ctrl+C
		manager.writeInput("task-1", Buffer.from([0x03]));

		// Agent produces output after the interrupt (e.g. Claude redraws prompt)
		await vi.advanceTimersByTimeAsync(2_000);
		spawnedSessions[0]?.triggerData("Prompt redraw...\n");

		// Wait past the recovery timeout
		await vi.advanceTimersByTimeAsync(4_000);

		// Should transition regardless — output alone doesn't cancel recovery.
		// If the agent is genuinely still working, its next hook will move it back.
		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("attention");
	});

	it("does not trigger interrupt recovery for large pasted buffers containing 0x03", async () => {
		setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn() });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		// Simulate pasting a larger buffer that happens to contain 0x03
		const pastedData = Buffer.from("some pasted text\x03with embedded ctrl-c byte");
		manager.writeInput("task-1", pastedData);

		// Wait past the recovery timeout
		await vi.advanceTimersByTimeAsync(6_000);

		// Should still be running — large buffer should not trigger interrupt detection
		expect(manager.store.getSummary("task-1")?.state).toBe("running");
	});

	it("marks crash-recovered running sessions as interrupted during hydration", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		// Hydrate with a session that claims to be running with a PID that doesn't exist
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "running",
				pid: 999_999_999, // PID that doesn't exist
			}),
		});

		// Hydration detects the stale running state and marks as interrupted.
		// recoverStaleSession is a no-op since it's no longer in an active state.
		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("interrupted");
		expect(summary?.reviewReason).toBe("interrupted");
		expect(summary?.pid).toBeNull();

		const recovered = manager.recoverStaleSession("task-1");
		expect(recovered?.state).toBe("interrupted");
	});

	it("watchdog recovers a live session whose process died without an exit event", async () => {
		// Use a PID that doesn't exist so isProcessAlive returns false.
		const DEAD_PID = 999_999_999;
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => createMockPtySession(DEAD_PID, request));

		const onState = vi.fn();
		const onExit = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput: vi.fn(), onExit });

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(manager.store.getSummary("task-1")?.state).toBe("running");
		expect(manager.store.getSummary("task-1")?.pid).toBe(DEAD_PID);

		// Start reconciliation and advance past one check interval (10s)
		manager.startReconciliation();
		await vi.advanceTimersByTimeAsync(10_000);

		// The reconciliation sweep should have recovered the card
		const recovered = manager.store.getSummary("task-1");
		expect(recovered?.state).toBe("awaiting_review");
		expect(recovered?.reviewReason).toBe("error");
		expect(onExit).toHaveBeenCalledWith(null);

		manager.stopReconciliation();
	});
});

describe("session-state-machine interrupt.recovery event", () => {
	it("transitions from running to awaiting_review with attention reason", () => {
		const summary = createSummary({ state: "running", reviewReason: null });
		const result = reduceSessionTransition(summary, { type: "interrupt.recovery" });

		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("awaiting_review");
		expect(result.patch.reviewReason).toBe("attention");
		expect(result.clearAttentionBuffer).toBe(true);
	});

	it("is a no-op when not in running state", () => {
		const summary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const result = reduceSessionTransition(summary, { type: "interrupt.recovery" });

		expect(result.changed).toBe(false);
	});
});

describe("recoverStaleSession with launched sessions", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not restart when process exits after agent already handed off via hook", async () => {
		const spawnedSessions = setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		// No listeners attached — simulates user not viewing this task
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		// Agent completes work and sends to_review hook, then process exits
		// (code 1 is typical Claude Code shutdown noise — not a crash).
		manager.store.transitionToReview("task-1", "hook");
		spawnedSessions[0]?.triggerExit(1);

		// Review reason should be preserved as "hook", not overwritten to "error"
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");

		// Viewer connects — recoverStaleSession should NOT restart since
		// the agent already completed its work
		const recovered = manager.recoverStaleSession("task-1");
		expect(recovered?.state).toBe("awaiting_review");
		expect(recovered?.reviewReason).toBe("hook");
		expect(spawnedSessions).toHaveLength(1);
	});

	it("preserves hook review reason on clean exit (code 0)", async () => {
		const spawnedSessions = setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		// Transition to review, then process exits cleanly
		manager.store.transitionToReview("task-1", "hook");
		spawnedSessions[0]?.triggerExit(0);

		// Reason stays "hook" — process dying after handoff doesn't change the reason
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");

		// Viewer connects — should NOT restart
		const recovered = manager.recoverStaleSession("task-1");
		expect(recovered?.state).toBe("awaiting_review");
		expect(recovered?.reviewReason).toBe("hook");
		expect(spawnedSessions).toHaveLength(1);
	});

	it("hydrated awaiting_review entries with terminal review reasons are preserved", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
			}),
		});

		// Terminal review reasons (hook, exit, error, etc.) represent completed
		// agent work and are preserved across server restarts.
		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("hook");
	});

	it("hydrated awaiting_review with terminal reason survives recoverStaleSession", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
			}),
		});

		// Simulates a viewer connecting after server restart — restartRequest is
		// null because it's in-memory only, but the review state should be preserved.
		const recovered = manager.recoverStaleSession("task-1");
		expect(recovered?.state).toBe("awaiting_review");
		expect(recovered?.reviewReason).toBe("hook");
	});

	it("hydrated awaiting_review entries with non-terminal review reasons are marked interrupted", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
			}),
		});

		// Non-terminal review reasons indicate the session was mid-restart.
		// Mark as interrupted so resumeInterruptedSessions can restart them.
		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("interrupted");
		expect(summary?.reviewReason).toBe("interrupted");
	});
});
