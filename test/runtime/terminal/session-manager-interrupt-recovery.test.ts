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
import type { RuntimeDiagnostics } from "../../../src/diagnostics";
import { InMemorySessionSummaryStore, reduceSessionTransition, TerminalSessionManager } from "../../../src/terminal";
import { createTestProviderHookRequest, createTestTaskSessionSummary } from "../../utilities/task-session-factory";

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

function applyCurrentProviderHook(
	manager: TerminalSessionManager,
	event: "to_review" | "to_in_progress",
	options: { occurredAt?: number } = {},
) {
	const summary = manager.store.getSummary("task-1");
	if (!summary) throw new Error("Expected task session summary.");
	return manager.applyProviderHook(
		"task-1",
		createTestProviderHookRequest(summary, event, { occurredAt: options.occurredAt }),
	);
}

async function startConfirmedTaskSession(
	manager: TerminalSessionManager,
	request: Parameters<TerminalSessionManager["startTaskSession"]>[0],
): Promise<void> {
	await manager.startTaskSession(request);
	const result = applyCurrentProviderHook(manager, "to_in_progress");
	if (result?.summary.state !== "running") {
		throw new Error("Expected the current provider hook to confirm Running.");
	}
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

	it.each([0, 130])(
		"preserves Ctrl-C as Interrupted when the process exits before recovery (code %i)",
		async (exitCode) => {
			const spawnedSessions = setupMockPtySpawn();

			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
			manager.attach("task-1", {
				onState: vi.fn(),
				onOutput: vi.fn(),
				onExit: vi.fn(),
			});

			await startConfirmedTaskSession(manager, {
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
			spawnedSessions[0]?.triggerExit(exitCode);
			await vi.advanceTimersByTimeAsync(100);

			// Should NOT have auto-restarted
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");
		},
	);

	it("transitions to interrupted Review after Ctrl+C if agent stays running with no output", async () => {
		setupMockPtySpawn();

		const onState = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput: vi.fn() });

		await startConfirmedTaskSession(manager, {
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

		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("interrupted");
	});

	it("transitions to interrupted Review after Escape if agent stays running with no output", async () => {
		setupMockPtySpawn();

		const onState = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput: vi.fn() });

		await startConfirmedTaskSession(manager, {
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

		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("interrupted");
	});

	it("returns a live interrupted review to running on the next confirmed provider hook", async () => {
		const spawnedSessions = setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await startConfirmedTaskSession(manager, {
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.writeInput("task-1", Buffer.from([0x1b]));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
		});
		expect(manager.getDiagnosticSnapshot().sessions[0]).toMatchObject({
			exiting: false,
			suppressAutoRestartOnExit: true,
		});

		manager.writeInput("task-1", Buffer.from("Continue working"));
		manager.writeInput("task-1", Buffer.from([0x0d]));
		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
		});
		applyCurrentProviderHook(manager, "to_in_progress", { occurredAt: Date.now() + 1 });

		expect(manager.store.getSummary("task-1")).toMatchObject({ state: "running", reviewReason: null });
		expect(manager.getDiagnosticSnapshot().sessions[0]?.suppressAutoRestartOnExit).toBe(false);
		expect(spawnedSessions[0]?.write).toHaveBeenLastCalledWith(Buffer.from([0x0d]));
	});

	it("cancels pending interrupt recovery when a new turn is confirmed before the timeout", async () => {
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await startConfirmedTaskSession(manager, {
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.writeInput("task-1", Buffer.from([0x1b]));
		await vi.advanceTimersByTimeAsync(1_000);
		manager.writeInput("task-1", Buffer.from([0x0d]));
		applyCurrentProviderHook(manager, "to_in_progress", { occurredAt: Date.now() + 1 });
		await vi.advanceTimersByTimeAsync(5_000);

		expect(manager.store.getSummary("task-1")).toMatchObject({ state: "running", reviewReason: null });
		expect(manager.getDiagnosticSnapshot().sessions[0]).toMatchObject({
			exiting: false,
			suppressAutoRestartOnExit: false,
		});
	});

	it("does not let a hook queued before the interrupt cancel recovery", async () => {
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await startConfirmedTaskSession(manager, {
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});
		const sessionInstanceId = manager.store.getSummary("task-1")?.sessionInstanceId;
		if (!sessionInstanceId) {
			throw new Error("Expected an active session instance.");
		}
		const beforeInterrupt = Date.now() - 1;

		manager.writeInput("task-1", Buffer.from([0x1b]));
		const result = applyCurrentProviderHook(manager, "to_in_progress", { occurredAt: beforeInterrupt });
		expect(result?.changed).toBe(false);
		await vi.advanceTimersByTimeAsync(5_000);

		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
		});
	});

	it("rejects input after an explicit PTY stop has begun", async () => {
		const spawnedSessions = setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await startConfirmedTaskSession(manager, {
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});
		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) return;
		session.wasInterrupted.mockReturnValue(true);

		expect(manager.writeInput("task-1", Buffer.from([0x0d]))).toBeNull();
		expect(session.write).not.toHaveBeenCalled();
	});

	it("records the interrupt source and resulting semantic state", async () => {
		setupMockPtySpawn();
		const recordEvent = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore(), {
			projectId: "project-1",
			diagnostics: { recordEvent } as unknown as RuntimeDiagnostics,
		});

		await startConfirmedTaskSession(manager, {
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.writeInput("task-1", Buffer.from([0x1b]));
		expect(recordEvent).toHaveBeenCalledWith(
			"session.interrupt_recovery_scheduled",
			{ signal: "escape", delayMs: 5_000 },
			expect.objectContaining({ projectId: "project-1", taskId: "task-1" }),
			expect.objectContaining({ essential: true }),
		);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(recordEvent).toHaveBeenCalledWith(
			"session.interrupt_recovery_applied",
			{
				signal: "escape",
				changed: true,
				nextState: "awaiting_review",
				nextReviewReason: "interrupted",
			},
			expect.objectContaining({ projectId: "project-1", taskId: "task-1" }),
			expect.objectContaining({ essential: true }),
		);
	});

	it("does not trigger interrupt recovery for ANSI escape sequences", async () => {
		setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn() });

		await startConfirmedTaskSession(manager, {
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

		await startConfirmedTaskSession(manager, {
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
		expect(summary?.reviewReason).toBe("interrupted");
	});

	it("does not trigger interrupt recovery for large pasted buffers containing 0x03", async () => {
		setupMockPtySpawn();

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn() });

		await startConfirmedTaskSession(manager, {
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
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("interrupted");
		expect(summary?.pid).toBeNull();

		const recovered = manager.recoverStaleSession("task-1");
		expect(recovered?.state).toBe("awaiting_review");
	});

	it("watchdog recovers a live session whose process died without an exit event", async () => {
		// Use a PID that doesn't exist so isProcessAlive returns false.
		const DEAD_PID = 999_999_999;
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => createMockPtySession(DEAD_PID, request));

		const onState = vi.fn();
		const onExit = vi.fn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState, onOutput: vi.fn(), onExit });

		await startConfirmedTaskSession(manager, {
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
	it("transitions from running to interrupted Review", () => {
		const summary = createSummary({ state: "running", reviewReason: null });
		const result = reduceSessionTransition(summary, { type: "interrupt.recovery" });

		expect(result.changed).toBe(true);
		expect(result.patch.state).toBe("awaiting_review");
		expect(result.patch.reviewReason).toBe("interrupted");
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
		await startConfirmedTaskSession(manager, {
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		// Agent completes work and sends to_review hook, then process exits
		// (code 1 is typical Claude Code shutdown noise — not a crash).
		applyCurrentProviderHook(manager, "to_review");
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
		await startConfirmedTaskSession(manager, {
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		// Transition to review, then process exits cleanly
		applyCurrentProviderHook(manager, "to_review");
		spawnedSessions[0]?.triggerExit(0);

		// Reason stays "hook" — process dying after handoff doesn't change the reason
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");

		// Viewer connects — should NOT restart
		const recovered = manager.recoverStaleSession("task-1");
		expect(recovered?.state).toBe("awaiting_review");
		expect(recovered?.reviewReason).toBe("hook");
		expect(spawnedSessions).toHaveLength(1);
	});

	it("hydrates awaiting_review entries with stale process ownership without changing review meaning", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
			}),
		});

		// A hook review with a persisted PID still owned an interactive chat when
		// the previous runtime ended. Recovery eligibility is process state; the
		// review reason remains authoritative user-facing meaning.
		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("hook");
		expect(summary?.pid).toBeNull();
		expect(summary?.startupRecoveryRequired).toBe(true);
	});

	it("keeps a hydrated recovery candidate in review when a viewer connects before startup recovery", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "hook",
			}),
		});

		// A viewer attachment must not change semantic state or launch a competing
		// recovery outside the startup coordinator.
		const recovered = manager.recoverStaleSession("task-1");
		expect(recovered?.state).toBe("awaiting_review");
		expect(recovered?.reviewReason).toBe("hook");
		expect(recovered?.startupRecoveryRequired).toBe(true);
	});

	it("hydrated awaiting_review entries with non-terminal review reasons are marked interrupted", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: null,
			}),
		});

		// Missing review reasons indicate the session was mid-restart.
		// Mark as interrupted so resumeInterruptedSessions can restart them.
		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("interrupted");
	});

	it("hydrated awaiting_review interrupted entries preserve explicit stop state", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.hydrateFromRecord({
			"task-1": createSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
			}),
		});

		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("interrupted");
	});
});
