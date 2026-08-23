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
import { DETACHED_CLAUDE_TERMINAL_ROW_MULTIPLIER } from "../../../src/terminal/session-manager-types";

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
			state: "failed",
			pid: null,
			resumeSessionId: "missing-session",
		});
		const recoveryToken = "recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);

		const summary = manager.finalizeStartupRecoveryFailure("task-1", recoveryToken, {
			processStillRunning: false,
			clearResumeSessionId: true,
			warningMessage: "Recovery failed.",
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
		expect(manager.store.getSummary("task-1")?.state).toBe("running");
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

	describe("onData transition-before-broadcast ordering", () => {
		it("listeners see post-transition state when onData triggers a state machine transition", async () => {
			prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
				binary: input.binary,
				args: [...input.args],
				env: {},
				detectOutputTransition: (data: string) => {
					if (data.includes("PROMPT_READY")) {
						return { type: "agent.prompt-ready" as const };
					}
					return null;
				},
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

			// Move to awaiting_review so agent.prompt-ready can transition back to running
			manager.store.transitionToReview("task-1", "hook");
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			// Track the state observed inside the onOutput callback
			const statesSeenInOnOutput: Array<string | undefined> = [];

			manager.attach("task-1", {
				onOutput: () => {
					statesSeenInOnOutput.push(manager.store.getSummary("task-1")?.state);
				},
			});

			// Trigger data that includes the transition text
			spawnedSessions[0]?.triggerData("PROMPT_READY");

			// The listener's onOutput must have seen the post-transition state
			expect(statesSeenInOnOutput).toHaveLength(1);
			expect(statesSeenInOnOutput[0]).toBe("running");
		});

		it("listeners see awaiting_review when onData does not trigger a transition", async () => {
			prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
				binary: input.binary,
				args: [...input.args],
				env: {},
				detectOutputTransition: (data: string) => {
					if (data.includes("PROMPT_READY")) {
						return { type: "agent.prompt-ready" as const };
					}
					return null;
				},
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

			manager.store.transitionToReview("task-1", "hook");

			const statesSeenInOnOutput: Array<string | undefined> = [];
			manager.attach("task-1", {
				onOutput: () => {
					statesSeenInOnOutput.push(manager.store.getSummary("task-1")?.state);
				},
			});

			// Send data that does NOT contain the transition trigger
			spawnedSessions[0]?.triggerData("some ordinary output");

			expect(statesSeenInOnOutput).toHaveLength(1);
			expect(statesSeenInOnOutput[0]).toBe("awaiting_review");
		});
	});

	// ── Direct user-response ordering ───────────────────────────────────

	describe("writeInput resolves only actionable input waits", () => {
		it("keeps an ordinary review-ready task in review", async () => {
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

			manager.store.transitionToReview("task-1", "hook");
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			manager.writeInput("task-1", Buffer.from([0x0d]));

			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(1);
		});

		it("moves a Codex approval wait to running only when the response is submitted", async () => {
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

			manager.store.transitionToReview("task-1", "hook");
			manager.store.applyHookActivity("task-1", {
				hookEventName: "PermissionRequest",
				notificationType: "permission.asked",
				activityText: "Waiting for approval",
				toolName: "Bash",
				source: "codex",
			});

			manager.writeInput("task-1", Buffer.from([0x1b, 0x5b, 0x42]));
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(manager.store.getSummary("task-1")?.latestHookActivity?.hookEventName).toBe("PermissionRequest");

			manager.writeInput("task-1", Buffer.from("pasted\rtext"));
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			manager.writeInput("task-1", Buffer.from([0x0d]));

			expect(manager.store.getSummary("task-1")?.state).toBe("running");
			expect(manager.store.getSummary("task-1")?.latestHookActivity).toBeNull();
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(3);
		});

		it("rejects a delayed permission observation from before a Codex submission", async () => {
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
			).toEqual({ accepted: false, reason: "resolved_by_user_input" });
		});
	});
});
