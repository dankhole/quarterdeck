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

import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import { createCodexTurnInterruptionDetector } from "../../../src/terminal/codex-turn-interruption";
import { DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER } from "../../../src/terminal/session-manager-types";
import { canApplyCodexRenderedTurnInterruption } from "../../../src/terminal/session-state-machine";
import { createHooksApi } from "../../../src/trpc";
import { createTestTaskOutstandingInteraction } from "../../utilities/task-session-factory";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
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

function setupMockPtySpawn() {
	const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
		spawnedSessions.push(session);
		return session;
	});
	return spawnedSessions;
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) {
		throw new Error("Deferred promise resolver was not initialized.");
	}
	return { promise, resolve: resolvePromise };
}

describe("TerminalSessionManager ordering invariants", () => {
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

	it("assigns an isolated hook identity to every spawned task process", async () => {
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		for (const taskId of ["task-1", "task-2"]) {
			await manager.startTaskSession({
				taskId,
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: `/tmp/${taskId}`,
				prompt: "Fix the bug",
			});
		}

		const firstInstanceId = prepareAgentLaunchMock.mock.calls[0]?.[0].hookSessionInstanceId as string;
		const secondInstanceId = prepareAgentLaunchMock.mock.calls[1]?.[0].hookSessionInstanceId as string;
		expect(firstInstanceId).toEqual(expect.any(String));
		expect(secondInstanceId).toEqual(expect.any(String));
		expect(firstInstanceId).not.toBe(secondInstanceId);
		expect(
			manager.evaluateHookEventOrder("task-1", {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "codex",
					hookEventName: "Stop",
					sessionInstanceId: secondInstanceId,
					turnId: "turn-1",
				},
				delivery: {
					id: "00000000-0000-4000-8000-000000000001",
					occurredAt: 100,
				},
			}),
		).toEqual({ accepted: false, reason: "stale_session" });
	});

	it("retains the exact launched binary and profile for ownership handoff", async () => {
		setupMockPtySpawn();
		prepareAgentLaunchMock.mockResolvedValueOnce({
			binary: "/synthetic/bin/codex",
			args: ["resume", "session-1"],
			env: { CODEX_HOME: "/synthetic/codex-home" },
		});
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startTaskSession({
			taskId: "task-owned",
			launchOperationId: "launch-owned",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-owned",
			prompt: "",
		});

		expect(manager.getTaskSessionProcessIdentity("task-owned")).toMatchObject({
			pid: 111,
			launchOperationId: "launch-owned",
			agentId: "codex",
			binary: "/synthetic/bin/codex",
			profileEnvironment: { CODEX_HOME: "/synthetic/codex-home" },
		});
	});

	it("does not publish Running when a task PTY exits during spawn handoff", async () => {
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			request.onExit?.({ exitCode: 1 });
			return session;
		});
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		const summary = await manager.startTaskSession({
			taskId: "task-immediate-exit",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-immediate-exit",
			prompt: "Fix the bug",
		});

		expect(summary).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			exitCode: 1,
			pid: null,
		});
		expect(manager.store.getSummary("task-immediate-exit")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			exitCode: 1,
			pid: null,
		});
	});

	it("does not publish Running when a shell PTY exits during spawn handoff", async () => {
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			request.onExit?.({ exitCode: 0 });
			return session;
		});
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		const summary = await manager.startShellSession({
			taskId: "shell-immediate-exit",
			binary: "zsh",
			args: [],
			cwd: "/tmp",
		});

		expect(summary).toMatchObject({ state: "idle", reviewReason: null, exitCode: 0, pid: null });
		expect(manager.store.getSummary("shell-immediate-exit")).toMatchObject({
			state: "idle",
			reviewReason: null,
			exitCode: 0,
			pid: null,
		});
	});

	it("classifies an exact delayed input hook after natural PTY exit as outcome unknown", async () => {
		const spawnedSessions = setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-late-input",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-late-input",
			prompt: "Fix the bug",
		});
		const sessionInstanceId = manager.store.getSummary("task-late-input")?.sessionInstanceId;
		if (!sessionInstanceId) throw new Error("Expected a session instance id.");
		spawnedSessions[0]?.triggerExit(0);
		const occurredAt = Date.now();
		const api = createHooksApi({
			projects: { getProjectPathById: () => "/tmp/repo" },
			terminals: {
				getTerminalManagerForProject: () => manager,
				ensureTerminalManagerForProject: async () => manager,
			},
		});

		await expect(
			api.ingest({
				taskId: "task-late-input",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "claude",
					hookEventName: "PermissionRequest",
					sessionInstanceId,
					promptId: "prompt-1",
					toolName: "Bash",
				},
				delivery: {
					id: "00000000-0000-4000-8000-000000000090",
					occurredAt,
				},
			}),
		).resolves.toEqual({ ok: true });

		expect(manager.store.getSummary("task-late-input")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			pid: null,
			startupRecoveryRequired: false,
			outstandingInteraction: {
				provider: "claude",
				status: "resolution_unknown",
				promptId: "prompt-1",
			},
		});
	});

	it("never lets delayed work evidence after natural PTY exit claim Running", async () => {
		const spawnedSessions = setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-late-work",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-late-work",
			prompt: "Fix the bug",
		});
		const sessionInstanceId = manager.store.getSummary("task-late-work")?.sessionInstanceId;
		if (!sessionInstanceId) throw new Error("Expected a session instance id.");
		spawnedSessions[0]?.triggerExit(0);
		const api = createHooksApi({
			projects: { getProjectPathById: () => "/tmp/repo" },
			terminals: {
				getTerminalManagerForProject: () => manager,
				ensureTerminalManagerForProject: async () => manager,
			},
		});

		await api.ingest({
			taskId: "task-late-work",
			projectId: "project-1",
			event: "to_in_progress",
			metadata: {
				source: "codex",
				hookEventName: "PostToolUse",
				sessionInstanceId,
				turnId: "turn-1",
				toolUseId: "tool-1",
				toolName: "Bash",
			},
			delivery: {
				id: "00000000-0000-4000-8000-000000000091",
				occurredAt: Date.now(),
			},
		});

		expect(manager.store.getSummary("task-late-work")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "exit",
			pid: null,
		});
	});

	it("ingests the real Claude PreToolUse → PermissionRequest → response → PostToolUse sequence", async () => {
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-claude",
			prompt: "Fix the bug",
		});
		const sessionInstanceId = manager.store.getSummary("task-claude")?.sessionInstanceId as string;
		const api = createHooksApi({
			projects: { getProjectPathById: () => "/tmp/repo" },
			terminals: {
				getTerminalManagerForProject: () => manager,
				ensureTerminalManagerForProject: async () => manager,
			},
		});
		let lastOccurredAt = Date.now();
		const ingest = async (
			index: number,
			event: "activity" | "to_review" | "to_in_progress",
			metadata: Record<string, string>,
		) => {
			const occurredAt = Math.max(Date.now(), lastOccurredAt + 1);
			lastOccurredAt = occurredAt;
			return await api.ingest({
				taskId: "task-claude",
				projectId: "project-1",
				event,
				metadata: { source: "claude", sessionInstanceId, promptId: "prompt-1", ...metadata },
				delivery: {
					id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
					occurredAt,
				},
			});
		};

		expect(
			await ingest(1, "activity", {
				hookEventName: "PreToolUse",
				toolName: "Bash",
				toolUseId: "tool-1",
			}),
		).toEqual({ ok: true });
		expect(
			await ingest(2, "to_review", {
				hookEventName: "PermissionRequest",
				toolName: "Bash",
			}),
		).toEqual({ ok: true });
		expect(manager.store.getSummary("task-claude")?.outstandingInteraction).toMatchObject({
			status: "waiting",
			toolUseId: "tool-1",
			promptId: "prompt-1",
		});

		manager.writeInput("task-claude", Buffer.from("yes\n"), { explicitUserSubmission: true });
		expect(manager.store.getSummary("task-claude")?.outstandingInteraction?.status).toBe("response_submitted");
		expect(manager.store.getSummary("task-claude")?.state).toBe("awaiting_review");

		expect(
			await ingest(3, "to_in_progress", {
				hookEventName: "PostToolUse",
				toolName: "Bash",
				toolUseId: "tool-1",
			}),
		).toEqual({ ok: true });
		expect(manager.store.getSummary("task-claude")).toMatchObject({
			state: "running",
			reviewReason: null,
			outstandingInteraction: null,
		});
	});

	it("coalesces duplicate lifecycle launches and rejects a different launch for the same task", async () => {
		const launchGate = createDeferred<void>();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => {
			await launchGate.promise;
			return {
				binary: input.binary,
				args: [...input.args],
				env: {},
			};
		});
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const request = {
			taskId: "task-lifecycle-launch",
			launchOperationId: "launch-operation-a",
			agentId: "codex" as const,
			binary: "codex",
			args: [],
			cwd: "/tmp/task-lifecycle-launch",
			prompt: "Fix the bug",
		};

		const first = manager.startTaskSession(request);
		const duplicate = manager.startTaskSession(request);
		await expect(manager.startTaskSession({ ...request, launchOperationId: "launch-operation-b" })).rejects.toThrow(
			"A different task session launch is already in progress.",
		);
		launchGate.resolve();
		const [firstSummary, duplicateSummary] = await Promise.all([first, duplicate]);

		expect(firstSummary).toEqual(duplicateSummary);
		expect(firstSummary.launchOperationId).toBe("launch-operation-a");
		expect(firstSummary.sessionInstanceId).toEqual(expect.any(String));
		expect(prepareAgentLaunchMock).toHaveBeenCalledOnce();
		expect(ptySessionSpawnMock).toHaveBeenCalledOnce();
	});

	it("rejects a stop for a replaced session instance without touching the active PTY", async () => {
		const spawnedSessions = setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const summary = await manager.startTaskSession({
			taskId: "task-stale-stop",
			launchOperationId: "launch-operation",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-stale-stop",
			prompt: "Fix the bug",
		});

		const result = await manager.stopTaskSessionAndWaitForExit("task-stale-stop", 1_000, "replaced-session-instance");

		expect(result).toMatchObject({
			didExit: false,
			outcome: "failed",
			requestedSessionInstanceId: "replaced-session-instance",
		});
		expect(result.error).toContain("replaced");
		expect(summary.sessionInstanceId).not.toBe("replaced-session-instance");
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
		expect(manager.store.getSummary("task-stale-stop")?.pid).toBe(111);
	});

	it("reports a clean exit only after the exact stopped PTY exits", async () => {
		const spawnedSessions = setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const summary = await manager.startTaskSession({
			taskId: "task-clean-stop",
			launchOperationId: "launch-operation",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-clean-stop",
			prompt: "Fix the bug",
		});
		if (!summary.sessionInstanceId) {
			throw new Error("Expected a session instance id.");
		}

		const stopped = manager.stopTaskSessionAndWaitForExit("task-clean-stop", 1_000, summary.sessionInstanceId);
		expect(spawnedSessions[0]?.stop).toHaveBeenCalledOnce();
		spawnedSessions[0]?.triggerExit(0);

		await expect(stopped).resolves.toMatchObject({
			didExit: true,
			outcome: "exited",
			requestedSessionInstanceId: summary.sessionInstanceId,
		});
	});

	it("confirms startup readiness only from the spawned conversation identity", async () => {
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const recoveryToken = "recovery-token";
		expect(manager.beginStartupRecovery("task-1", recoveryToken)).toBe(true);

		const started = await manager.startTaskSessionWithReadiness({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "session-1",
			startupRecoveryToken: recoveryToken,
		});
		expect(started.sessionInstanceId).toEqual(expect.any(String));
		const waiting = manager.waitForTaskSessionLaunch("task-1", started.sessionInstanceId ?? "", 1_000);

		manager.recordHookReceived("task-1");
		manager.observeTaskSessionLaunchHook("task-1", {
			sessionInstanceId: started.sessionInstanceId,
			sessionId: "session-1",
		});

		await expect(waiting).resolves.toEqual({
			status: "ready",
			sessionInstanceId: started.sessionInstanceId,
			observedSessionId: "session-1",
		});
	});

	it("rejects hooks that report a different targeted startup conversation", async () => {
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const recoveryToken = "recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);
		const started = await manager.startTaskSessionWithReadiness({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "expected-session",
			startupRecoveryToken: recoveryToken,
		});
		const waiting = manager.waitForTaskSessionLaunch("task-1", started.sessionInstanceId ?? "", 1_000);

		manager.recordHookReceived("task-1");
		expect(
			manager.observeTaskSessionLaunchHook("task-1", {
				sessionInstanceId: started.sessionInstanceId,
				sessionId: "wrong-session",
			}),
		).toBe(false);
		await expect(waiting).resolves.toMatchObject({
			status: "identity_mismatch",
			expectedSessionId: "expected-session",
			observedSessionId: "wrong-session",
		});
	});

	it("cancels startup retry ownership when the user submits input", async () => {
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const recoveryToken = "recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);
		const started = await manager.startTaskSessionWithReadiness({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			startupRecoveryToken: recoveryToken,
		});
		const waiting = manager.waitForTaskSessionLaunch("task-1", started.sessionInstanceId ?? "", 1_000);

		manager.writeInput("task-1", Buffer.from("continue\r"));

		await expect(waiting).resolves.toEqual({
			status: "user_engaged",
			sessionInstanceId: started.sessionInstanceId,
		});
		expect(manager.isStartupRecoveryCurrent("task-1", recoveryToken)).toBe(false);
	});

	it("does not cancel startup recovery when a processless task cannot receive input", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const recoveryToken = "recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);
		manager.store.update("task-1", { startupRecoveryRequired: true });

		expect(manager.writeInput("task-1", Buffer.from([0x0d]))).toBeNull();
		expect(manager.isStartupRecoveryCurrent("task-1", recoveryToken)).toBe(true);
		expect(manager.store.getSummary("task-1")?.startupRecoveryRequired).toBe(true);
	});

	it("cancels queued startup recovery when the manager is disposed", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const recoveryToken = "recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);

		manager.markInterruptedAndStopAll();

		expect(manager.isStartupRecoveryCurrent("task-1", recoveryToken)).toBe(false);
	});

	it("routes startup recovery exhaustion through the session transition owner", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.store.ensureEntry("task-1");
		manager.store.update("task-1", {
			state: "awaiting_review",
			reviewReason: "error",
			pid: null,
			resumeSessionId: "missing-session",
		});
		const recoveryToken = "recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);

		const summary = manager.finalizeStartupRecoveryFailure("task-1", recoveryToken, {
			processStillRunning: false,
			clearResumeSessionId: true,
			warningMessage: "Recovery failed.",
			fallbackReviewState: null,
		});

		expect(summary).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			pid: null,
			resumeSessionId: null,
			warningMessage: "Recovery failed.",
		});
	});

	it("uses real detached rows when launching Claude fullscreen sessions", async () => {
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startTaskSession({
			taskId: "task-classic",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-classic",
			prompt: "Classic",
			cols: 80,
			rows: 24,
		});
		await manager.startTaskSession({
			taskId: "task-fullscreen",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-fullscreen",
			prompt: "Fullscreen",
			cols: 80,
			rows: 24,
			claudeFullscreenEnabled: true,
			env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0" },
		});

		expect(ptySessionSpawnMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ cols: 80, rows: 24 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER }),
		);
		expect(ptySessionSpawnMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ cols: 80, rows: 24 }));
		expect(prepareAgentLaunchMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ claudeFullscreenEnabled: true }),
		);
	});

	it("keeps classic detached rows when Claude's escape hatch overrides the fullscreen setting", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startTaskSession({
			taskId: "task-fullscreen-overridden",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-fullscreen-overridden",
			prompt: "Fullscreen overridden",
			cols: 80,
			rows: 24,
			claudeFullscreenEnabled: true,
			env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledWith(
			expect.objectContaining({ cols: 80, rows: 24 * DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER }),
		);
		expect(prepareAgentLaunchMock).toHaveBeenCalledWith(expect.objectContaining({ claudeFullscreenEnabled: false }));
		expect(consoleWarn).toHaveBeenCalled();
		consoleWarn.mockRestore();
	});

	// ── Gap 1: onData transition-before-broadcast ordering ──────────────

	it("ignores an exit event from a replaced task PTY", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const spawnedSessions = setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const onExit = vi.fn();
		manager.attach("task-1", {
			onExit,
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});
		expect(manager.store.getSummary("task-1")?.pid).toBe(111);

		// Simulate a stale active process whose summary was already recovered.
		// A replacement start should not let the old exit callback tear down
		// the newly active process.
		manager.store.update("task-1", {
			state: "idle",
			reviewReason: null,
			pid: null,
		});
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Resume work",
		});
		expect(manager.store.getSummary("task-1")?.pid).toBe(222);

		spawnedSessions[0]?.triggerExit(0);

		expect(manager.store.getSummary("task-1")?.pid).toBe(222);
		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "unconfirmed",
		});
		expect(onExit).not.toHaveBeenCalled();
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining("[session-mgr]"),
			"ignoring stale task session exit for replaced process",
			expect.objectContaining({
				taskId: "task-1",
				exitingPid: 111,
				activePid: 222,
			}),
		);
	});

	it("ignores output from a replaced task PTY", async () => {
		const spawnedSessions = setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const onOutput = vi.fn();
		manager.attach("task-stale-output", { onOutput });
		const request = {
			taskId: "task-stale-output",
			agentId: "codex" as const,
			binary: "codex",
			args: [],
			cwd: "/tmp/task-stale-output",
			prompt: "Fix the bug",
		};

		await manager.startTaskSession(request);
		manager.store.update(request.taskId, { state: "idle", reviewReason: null, pid: null });
		await manager.startTaskSession({ ...request, prompt: "Resume work" });
		onOutput.mockClear();

		spawnedSessions[0]?.triggerData("stale output");
		expect(onOutput).not.toHaveBeenCalled();
		spawnedSessions[1]?.triggerData("current output");
		expect(onOutput).toHaveBeenCalledOnce();
		expect(onOutput).toHaveBeenCalledWith(Buffer.from("current output"));
	});

	it("ignores output and exit callbacks from a replaced shell PTY", async () => {
		const spawnedSessions = setupMockPtySpawn();
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const onOutput = vi.fn();
		const onExit = vi.fn();
		manager.attach("shell-stale-callback", { onOutput, onExit });
		const request = {
			taskId: "shell-stale-callback",
			binary: "zsh",
			args: [],
			cwd: "/tmp",
		};

		await manager.startShellSession(request);
		manager.store.update(request.taskId, { state: "idle", reviewReason: null, pid: null });
		await manager.startShellSession(request);
		onOutput.mockClear();

		spawnedSessions[0]?.triggerData("stale shell output");
		spawnedSessions[0]?.triggerExit(0);
		expect(onOutput).not.toHaveBeenCalled();
		expect(onExit).not.toHaveBeenCalled();
		expect(manager.store.getSummary(request.taskId)).toMatchObject({ state: "running", pid: 222 });

		spawnedSessions[1]?.triggerData("current shell output");
		expect(onOutput).toHaveBeenCalledWith(Buffer.from("current shell output"));
	});

	describe("onData transition-before-broadcast ordering", () => {
		it("keeps a newer provider-confirmed turn Running across a redraw with historical interruption text", async () => {
			const detector = createCodexTurnInterruptionDetector();
			prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
				binary: input.binary,
				args: [...input.args],
				env: {},
				detectOutputTransition: detector.detect,
				shouldInspectOutputForTransition: (summary: { state: string }) => summary.state === "running",
			}));
			const spawnedSessions = setupMockPtySpawn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
			manager.attach("task-interruption-redraw", { onOutput: () => undefined });

			await manager.startTaskSession({
				taskId: "task-interruption-redraw",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-interruption-redraw",
				prompt: "Fix the bug",
			});
			const sessionInstanceId = manager.store.getSummary("task-interruption-redraw")?.sessionInstanceId;
			if (!sessionInstanceId) throw new Error("Missing session instance id.");
			manager.applyProviderHook("task-interruption-redraw", {
				taskId: "task-interruption-redraw",
				projectId: "project-1",
				event: "to_in_progress",
				metadata: {
					source: "codex",
					hookEventName: "UserPromptSubmit",
					sessionInstanceId,
					turnId: "turn-1",
				},
				delivery: {
					id: "00000000-0000-4000-8000-000000000600",
					occurredAt: Date.now(),
				},
			});
			expect(manager.store.getSummary("task-interruption-redraw")?.state).toBe("running");

			spawnedSessions[0]?.triggerData(
				"\u001b[2J\u001b[H■ Conversation interrupted - tell the model what to do differently. " +
					"Something went wrong? Hit `/feedback` to report the issue.\r\n\r\n› Ask Codex to do anything",
			);
			await vi.advanceTimersByTimeAsync(1);
			expect(manager.store.getSummary("task-interruption-redraw")).toMatchObject({
				state: "awaiting_review",
				reviewReason: "interrupted",
			});

			manager.applyProviderHook("task-interruption-redraw", {
				taskId: "task-interruption-redraw",
				projectId: "project-1",
				event: "to_in_progress",
				metadata: {
					source: "codex",
					hookEventName: "UserPromptSubmit",
					sessionInstanceId,
					turnId: "turn-2",
				},
				delivery: {
					id: "00000000-0000-4000-8000-000000000601",
					occurredAt: Date.now() + 1,
				},
			});
			expect(manager.store.getSummary("task-interruption-redraw")?.state).toBe("running");

			spawnedSessions[0]?.triggerData(
				"\u001b[2J\u001b[H■ Conversation interrupted - tell the model what to do differently. " +
					"Something went wrong? Hit `/feedback` to report the issue.\r\n\r\n" +
					"› Ask Codex to do anything\r\n\r\n• Working on the follow-up\r\n" +
					"  └ Read src/terminal/session-state-machine.ts\r\n\r\n› Ask Codex to do anything",
			);
			await vi.advanceTimersByTimeAsync(1);
			expect(manager.store.getSummary("task-interruption-redraw")).toMatchObject({
				state: "running",
				reviewReason: null,
			});

			spawnedSessions[0]?.triggerData(
				"\u001b[2J\u001b[H■ Conversation interrupted - tell the model what to do differently. " +
					"Something went wrong? Hit `/feedback` to report the issue.\r\n\r\n› Ask Codex to do anything",
			);
			await vi.advanceTimersByTimeAsync(1);
			expect(manager.store.getSummary("task-interruption-redraw")).toMatchObject({
				state: "awaiting_review",
				reviewReason: "interrupted",
			});
		});

		it.each(["waiting", "response_submitted"] as const)(
			"retires a %s Codex approval when the current rendered turn is interrupted",
			async (status) => {
				const detector = createCodexTurnInterruptionDetector();
				prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
					binary: input.binary,
					args: [...input.args],
					env: {},
					detectOutputTransition: detector.detect,
					shouldInspectOutputForTransition: canApplyCodexRenderedTurnInterruption,
				}));
				const spawnedSessions = setupMockPtySpawn();
				const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
				manager.attach(`task-interrupted-approval-${status}`, { onOutput: () => undefined });

				await manager.startTaskSession({
					taskId: `task-interrupted-approval-${status}`,
					agentId: "codex",
					binary: "codex",
					args: [],
					cwd: `/tmp/task-interrupted-approval-${status}`,
					prompt: "Fix the bug",
				});
				const taskId = `task-interrupted-approval-${status}`;
				const sessionInstanceId = manager.store.getSummary(taskId)?.sessionInstanceId;
				if (!sessionInstanceId) throw new Error("Missing session instance id.");
				manager.store.update(taskId, {
					state: "awaiting_review",
					reviewReason: "hook",
					outstandingInteraction: createTestTaskOutstandingInteraction({
						provider: "codex",
						kind: "permission",
						status,
						providerAgentId: null,
						sessionInstanceId,
						responseSubmittedAt: status === "response_submitted" ? Date.now() : null,
						responseKind: status === "response_submitted" ? "cancel" : null,
					}),
				});

				spawnedSessions[0]?.triggerData(
					"\u001b[2J\u001b[H■ Conversation interrupted - tell the model what to do differently. " +
						"Something went wrong? Hit `/feedback` to report the issue.\r\n\r\n› Ask Codex to do anything",
				);
				await vi.advanceTimersByTimeAsync(1);

				expect(manager.store.getSummary(taskId)).toMatchObject({
					state: "awaiting_review",
					reviewReason: "interrupted",
					outstandingInteraction: null,
					latestHookActivity: null,
					nativeWorkEvidence: null,
				});
			},
		);

		it("moves visible Codex approvals before broadcast and resets after a hook-driven return", async () => {
			let detected = false;
			const resetDetection = vi.fn(() => {
				detected = false;
			});
			prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
				binary: input.binary,
				args: [...input.args],
				env: {},
				detectOutputTransition: (screen: { lines: string[] }) => {
					if (detected || !screen.lines.some((line) => line.includes("APPROVAL_OVERLAY"))) {
						return null;
					}
					detected = true;
					return { type: "agent.permission-prompt" as const };
				},
				shouldInspectOutputForTransition: (summary: { state: string; reviewReason: string | null }) =>
					summary.state === "running" || summary.reviewReason === "unconfirmed",
				resetOutputTransitionDetection: resetDetection,
			}));

			const spawnedSessions = setupMockPtySpawn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
			const statesSeenInOnOutput: Array<string | undefined> = [];
			manager.attach("task-approval", {
				onOutput: () => statesSeenInOnOutput.push(manager.store.getSummary("task-approval")?.state),
			});

			await manager.startTaskSession({
				taskId: "task-approval",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-approval",
				prompt: "Fix the bug",
			});
			resetDetection.mockClear();
			spawnedSessions[0]?.triggerData("APPROVAL_OVERLAY");
			await vi.advanceTimersByTimeAsync(1);

			expect(statesSeenInOnOutput).toEqual(["awaiting_review"]);
			expect(manager.store.getSummary("task-approval")).toMatchObject({
				state: "awaiting_review",
				reviewReason: "hook",
				latestHookActivity: {
					notificationType: "permission.asked",
				},
			});
			expect(resetDetection).not.toHaveBeenCalled();

			// A parallel PostToolUse cannot clear an untouched identity-free
			// compatibility wait.
			manager.applyProviderHook("task-approval", {
				taskId: "task-approval",
				projectId: "project-1",
				event: "to_in_progress",
				metadata: {
					source: "codex",
					hookEventName: "PostToolUse",
					sessionInstanceId: manager.store.getSummary("task-approval")?.sessionInstanceId,
					turnId: "turn-1",
					toolUseId: "tool-1",
				},
			});
			expect(manager.store.getSummary("task-approval")?.state).toBe("awaiting_review");
			expect(resetDetection).not.toHaveBeenCalled();

			// The rendered overlay's immediate y hotkey records the response, but
			// only later current native activity confirms resumed work and resets
			// the compatibility detector.
			manager.writeInput("task-approval", Buffer.from("y"));
			expect(manager.store.getSummary("task-approval")?.outstandingInteraction?.status).toBe("response_submitted");
			manager.applyProviderHook("task-approval", {
				taskId: "task-approval",
				projectId: "project-1",
				event: "to_in_progress",
				metadata: {
					source: "codex",
					hookEventName: "PostToolUse",
					sessionInstanceId: manager.store.getSummary("task-approval")?.sessionInstanceId,
					turnId: "turn-1",
					toolUseId: "tool-1",
				},
				delivery: {
					id: "00000000-0000-4000-8000-000000000501",
					occurredAt: Date.now() + 1,
				},
			});

			expect(manager.store.getSummary("task-approval")?.state).toBe("running");
			expect(resetDetection).toHaveBeenCalledTimes(1);

			spawnedSessions[0]?.triggerData("\r\nAPPROVAL_OVERLAY_SECOND");
			await vi.advanceTimersByTimeAsync(1);

			expect(manager.store.getSummary("task-approval")?.state).toBe("awaiting_review");
			expect(statesSeenInOnOutput).toEqual(["awaiting_review", "awaiting_review"]);
		});

		it("listeners see awaiting_review when onData does not trigger a transition", async () => {
			prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
				binary: input.binary,
				args: [...input.args],
				env: {},
				detectOutputTransition: () => null,
			}));

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

			const sessionInstanceId = manager.store.getSummary("task-1")?.sessionInstanceId as string;
			manager.applyProviderHook("task-1", {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "claude",
					hookEventName: "Stop",
					sessionInstanceId,
					turnId: "turn-1",
				},
			});

			const statesSeenInOnOutput: Array<string | undefined> = [];
			manager.attach("task-1", {
				onOutput: () => {
					statesSeenInOnOutput.push(manager.store.getSummary("task-1")?.state);
				},
			});

			// Send data that does NOT contain the transition trigger
			spawnedSessions[0]?.triggerData("some ordinary output");
			await vi.advanceTimersByTimeAsync(1);

			expect(statesSeenInOnOutput).toHaveLength(1);
			expect(statesSeenInOnOutput[0]).toBe("awaiting_review");
		});
	});

	// ── Provider-confirmed user-response ordering ───────────────────────

	describe("writeInput defers semantic state until provider confirmation", () => {
		it("does not treat a TUI-local Enter action as a resumed agent turn", async () => {
			const spawnedSessions = setupMockPtySpawn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

			await manager.startTaskSession({
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});

			const sessionInstanceId = manager.store.getSummary("task-1")?.sessionInstanceId as string;
			manager.applyProviderHook("task-1", {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "codex",
					hookEventName: "Stop",
					sessionInstanceId,
					turnId: "turn-1",
				},
			});
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			manager.writeInput("task-1", Buffer.from("/model"));
			manager.writeInput("task-1", Buffer.from([0x0d]));

			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(manager.store.getSummary("task-1")?.reviewReason).toBe("hook");
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(2);

			manager.applyProviderHook("task-1", {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_in_progress",
				delivery: {
					id: "00000000-0000-4000-8000-000000000101",
					occurredAt: Date.now(),
				},
				metadata: {
					source: "codex",
					hookEventName: "UserPromptSubmit",
					sessionInstanceId,
					turnId: "turn-2",
				},
			});

			expect(manager.store.getSummary("task-1")?.state).toBe("running");
		});

		it("keeps a Codex approval wait until PostToolUse confirms work resumed", async () => {
			const spawnedSessions = setupMockPtySpawn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

			await manager.startTaskSession({
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});

			const sessionInstanceId = manager.store.getSummary("task-1")?.sessionInstanceId as string;
			manager.applyProviderHook("task-1", {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					hookEventName: "PermissionRequest",
					notificationType: "permission.asked",
					activityText: "Waiting for approval",
					toolName: "Bash",
					toolUseId: "tool-1",
					turnId: "turn-1",
					sessionInstanceId,
					source: "codex",
				},
			});

			manager.writeInput("task-1", Buffer.from([0x1b, 0x5b, 0x42]));
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("PermissionRequest");

			manager.writeInput("task-1", Buffer.from("pasted\rtext"));
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			manager.writeInput("task-1", Buffer.from([0x0d]));

			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("PermissionRequest");
			expect(manager.store.getSummary("task-1")?.outstandingInteraction?.status).toBe("response_submitted");
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(3);

			manager.applyProviderHook("task-1", {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_in_progress",
				delivery: {
					id: "00000000-0000-4000-8000-000000000102",
					occurredAt: Date.now(),
				},
				metadata: {
					source: "codex",
					hookEventName: "PostToolUse",
					sessionInstanceId,
					turnId: "turn-1",
					toolName: "Bash",
					toolUseId: "tool-1",
				},
			});

			expect(manager.store.getSummary("task-1")?.state).toBe("running");
			expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("PostToolUse");
		});

		it.each(["y", "1"] as const)(
			"records Codex's immediate %s approval without claiming Running before PostToolUse",
			async (approvalChoice) => {
				const spawnedSessions = setupMockPtySpawn();
				const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

				await manager.startTaskSession({
					taskId: "task-codex-y",
					agentId: "codex",
					binary: "codex",
					args: [],
					cwd: "/tmp/task-codex-y",
					prompt: "Fix the bug",
				});

				const sessionInstanceId = manager.store.getSummary("task-codex-y")?.sessionInstanceId as string;
				const preToolUse = {
					taskId: "task-codex-y",
					projectId: "project-1",
					event: "activity" as const,
					delivery: {
						id: "00000000-0000-4000-8000-000000000103",
						occurredAt: Date.now() - 1,
					},
					metadata: {
						source: "codex",
						hookEventName: "PreToolUse",
						toolName: "Bash",
						toolUseId: "tool-1",
						turnId: "turn-1",
						sessionInstanceId,
					},
				};
				expect(manager.evaluateHookEventOrder("task-codex-y", preToolUse)).toEqual({ accepted: true });
				manager.applyProviderHook("task-codex-y", preToolUse);
				manager.commitHookEventOrder("task-codex-y", preToolUse, true);
				manager.applyProviderHook("task-codex-y", {
					taskId: "task-codex-y",
					projectId: "project-1",
					event: "to_review",
					metadata: {
						source: "codex",
						hookEventName: "PermissionRequest",
						notificationType: "permission.asked",
						activityText: "Waiting for approval",
						toolName: "Bash",
						turnId: "turn-1",
						sessionInstanceId,
					},
				});

				manager.writeInput("task-codex-y", Buffer.from(approvalChoice));

				expect(spawnedSessions[0]?.write).toHaveBeenCalledWith(Buffer.from(approvalChoice));
				expect(manager.store.getSummary("task-codex-y")).toMatchObject({
					state: "awaiting_review",
					reviewReason: "hook",
					outstandingInteraction: {
						provider: "codex",
						kind: "permission",
						status: "response_submitted",
						responseKind: "submit",
					},
				});

				manager.applyProviderHook("task-codex-y", {
					taskId: "task-codex-y",
					projectId: "project-1",
					event: "to_in_progress",
					delivery: {
						id: "00000000-0000-4000-8000-000000000105",
						occurredAt: Date.now() + 1,
					},
					metadata: {
						source: "codex",
						hookEventName: "PostToolUse",
						sessionInstanceId,
						turnId: "turn-1",
						toolName: "Bash",
						toolUseId: "tool-1",
					},
				});

				expect(manager.store.getSummary("task-codex-y")).toMatchObject({
					state: "running",
					reviewReason: null,
					outstandingInteraction: null,
				});
			},
		);

		it("does not treat y as an immediate submission for Claude permissions", async () => {
			setupMockPtySpawn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
			await manager.startTaskSession({
				taskId: "task-claude-y",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-claude-y",
				prompt: "Fix the bug",
			});
			const sessionInstanceId = manager.store.getSummary("task-claude-y")?.sessionInstanceId as string;
			manager.applyProviderHook("task-claude-y", {
				taskId: "task-claude-y",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					source: "claude",
					hookEventName: "PermissionRequest",
					toolName: "Bash",
					promptId: "prompt-1",
					sessionInstanceId,
				},
			});

			manager.writeInput("task-claude-y", Buffer.from("y"));

			expect(manager.store.getSummary("task-claude-y")?.outstandingInteraction?.status).toBe("waiting");
		});

		it("keeps explicit remote submit intent state-neutral until provider confirmation", async () => {
			const spawnedSessions = setupMockPtySpawn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

			await manager.startTaskSession({
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});
			const sessionInstanceId = manager.store.getSummary("task-1")?.sessionInstanceId as string;
			manager.applyProviderHook("task-1", {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: {
					hookEventName: "PermissionRequest",
					notificationType: "permission.asked",
					activityText: "Waiting for approval",
					toolName: "Bash",
					toolUseId: "tool-1",
					turnId: "turn-1",
					sessionInstanceId,
					source: "codex",
				},
			});

			manager.writeInput("task-1", Buffer.from("continue\n"), { explicitUserSubmission: true });

			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("PermissionRequest");
			expect(manager.store.getSummary("task-1")?.outstandingInteraction?.status).toBe("response_submitted");
			expect(spawnedSessions[0]?.write).toHaveBeenCalledWith(Buffer.from("continue\n"));

			manager.applyProviderHook("task-1", {
				taskId: "task-1",
				projectId: "project-1",
				event: "to_in_progress",
				delivery: {
					id: "00000000-0000-4000-8000-000000000104",
					occurredAt: Date.now(),
				},
				metadata: {
					source: "codex",
					hookEventName: "PostToolUse",
					sessionInstanceId,
					turnId: "turn-1",
					toolName: "Bash",
					toolUseId: "tool-1",
				},
			});
			expect(manager.store.getSummary("task-1")?.state).toBe("running");
		});

		it("keeps a Claude actionable wait until its provider hook confirms resumption", async () => {
			setupMockPtySpawn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

			await manager.startTaskSession({
				taskId: "task-claude-input",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-claude-input",
				prompt: "Fix the bug",
			});
			const sessionInstanceId = manager.store.getSummary("task-claude-input")?.sessionInstanceId as string;
			manager.applyProviderHook("task-claude-input", {
				taskId: "task-claude-input",
				projectId: "project-1",
				event: "activity",
				metadata: {
					hookEventName: "PreToolUse",
					activityText: "Choose an option",
					toolName: "AskUserQuestion",
					toolUseId: "tool-1",
					promptId: "prompt-1",
					sessionInstanceId,
					source: "claude",
				},
			});

			manager.writeInput("task-claude-input", Buffer.from([0x0d]));

			expect(manager.store.getSummary("task-claude-input")?.state).toBe("awaiting_review");
			expect(manager.store.getSummary("task-claude-input")?.latestHookActivity?.hookEventName).toBe("PreToolUse");
			expect(manager.store.getSummary("task-claude-input")?.outstandingInteraction?.status).toBe(
				"response_submitted",
			);

			manager.applyProviderHook("task-claude-input", {
				taskId: "task-claude-input",
				projectId: "project-1",
				event: "to_in_progress",
				delivery: {
					id: "00000000-0000-4000-8000-000000000103",
					occurredAt: Date.now(),
				},
				metadata: {
					source: "claude",
					hookEventName: "PostToolUse",
					sessionInstanceId,
					promptId: "prompt-1",
					toolName: "AskUserQuestion",
					toolUseId: "tool-1",
				},
			});

			expect(manager.store.getSummary("task-claude-input")?.state).toBe("running");
		});

		it("does not let an unrelated Codex Enter suppress a delayed permission observation", async () => {
			setupMockPtySpawn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

			await manager.startTaskSession({
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});
			const sessionInstanceId = prepareAgentLaunchMock.mock.calls[0]?.[0].hookSessionInstanceId as string;
			const preToolUse = {
				taskId: "task-1",
				projectId: "project-1",
				event: "activity" as const,
				metadata: {
					source: "codex",
					hookEventName: "PreToolUse",
					sessionInstanceId,
					turnId: "turn-1",
					toolName: "Bash",
				},
				delivery: {
					id: "00000000-0000-4000-8000-000000000001",
					occurredAt: 100,
				},
			};
			expect(manager.evaluateHookEventOrder("task-1", preToolUse)).toEqual({ accepted: true });
			manager.commitHookEventOrder("task-1", preToolUse, true);

			vi.setSystemTime(300);
			manager.writeInput("task-1", Buffer.from([0x0d]));

			expect(
				manager.evaluateHookEventOrder("task-1", {
					taskId: "task-1",
					projectId: "project-1",
					event: "to_review",
					metadata: {
						source: "codex",
						hookEventName: "PermissionRequest",
						sessionInstanceId,
						turnId: "turn-1",
						toolName: "Bash",
					},
					delivery: {
						id: "00000000-0000-4000-8000-000000000002",
						occurredAt: 200,
					},
				}),
			).toEqual({ accepted: true });
		});
	});
});
