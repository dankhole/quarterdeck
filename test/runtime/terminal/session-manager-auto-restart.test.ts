import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	STORED_CLAUDE_RESUME_FAILED_WARNING,
	STORED_CODEX_RESUME_FAILED_WARNING,
} from "../../../src/terminal/codex-resume-failure";

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
	InMemorySessionSummaryStore,
	LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
	TerminalSessionManager,
} from "../../../src/terminal";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	let interrupted = false;
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn((options?: { interrupted?: boolean }) => {
			if (options?.interrupted) {
				interrupted = true;
			}
		}),
		wasInterrupted: vi.fn(() => interrupted),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

describe("TerminalSessionManager auto-restart", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("restarts an attached agent session after it exits", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

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
			claudeFullscreenEnabled: true,
			env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "0" },
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		// Auto-restart uses awaitReview=true — the agent is at its prompt, not
		// actively working, so it lands in review for the user to re-engage.
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.pid).toBe(222);
		expect(prepareAgentLaunchMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ claudeFullscreenEnabled: true }),
		);
	});

	it("does not restore a cleared legacy uncertainty warning during a later automatic restart", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		const recoveryToken = "legacy-recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);
		await manager.startTaskSessionWithReadiness({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			awaitReview: true,
			startupRecoveryToken: recoveryToken,
			startupRecoveryReviewState: {
				reviewReason: "interrupted",
				lastHookAt: null,
				latestHookActivity: null,
			},
			startupRecoveryWarningMessage: LEGACY_STARTUP_SEMANTIC_STATE_WARNING,
		});
		manager.completeStartupRecovery("task-1", recoveryToken);

		manager.store.applySessionEvent("task-1", { type: "hook.to_in_progress" });
		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "running",
			startupRecoverySemanticStateUncertain: false,
			warningMessage: null,
		});

		spawnedSessions[0]?.triggerExit(1);
		await vi.waitFor(() => expect(spawnedSessions).toHaveLength(2));
		expect(manager.store.getSummary("task-1")?.warningMessage).toBeNull();
	});

	it("does not restart when the agent already transitioned to review before exit", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

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

		// Agent sends to_review hook — transitions to awaiting_review before exit.
		// This is the normal lifecycle: agent finishes work, sends hook, then exits.
		manager.store.applySessionEvent("task-1", { type: "hook.to_review" });
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

		// Process exits (code 1 — typical Claude Code shutdown noise)
		spawnedSessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();

		// Should NOT restart — the agent was done, not crashing
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
	});

	it("does not restart when the agent exits cleanly from review (exit code 0)", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

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

		// Agent sends to_review hook, then exits cleanly
		manager.store.applySessionEvent("task-1", { type: "hook.to_review" });
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
	});

	it("does not restart an attached agent session after an explicit stop", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");
		expect(manager.store.getSummary("task-1")?.pid).toBeNull();
	});

	it("does not run resume-failure fallback after explicitly stopping a resumed review session", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "codex-session-1",
			awaitReview: true,
		});

		expect(manager.store.getSummary("task-1")?.resumeSessionId).toBe("codex-session-1");

		manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("interrupted");
		expect(manager.store.getSummary("task-1")?.pid).toBeNull();
		expect(manager.store.getSummary("task-1")?.resumeSessionId).toBe("codex-session-1");
	});

	it("clears a bad stored Codex session id after a non-zero startup resume failure", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		const onOutput = vi.fn();
		const onState = vi.fn();
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState,
			onOutput,
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "codex-session-1",
			awaitReview: true,
		});

		spawnedSessions[0]?.triggerData("No session found\n");
		spawnedSessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.pid).toBeNull();
		expect(summary?.exitCode).toBe(1);
		expect(summary?.resumeSessionId).toBeNull();
		expect(summary?.warningMessage).toBe(STORED_CODEX_RESUME_FAILED_WARNING);

		const outputText = Buffer.concat(onOutput.mock.calls.map(([chunk]) => chunk as Buffer)).toString("utf8");
		expect(outputText).toContain("No session found");
		expect(outputText).toContain("Could not resume the stored Codex session");
		expect(onState).toHaveBeenCalledWith(
			expect.objectContaining({
				reviewReason: "error",
				resumeSessionId: null,
				warningMessage: STORED_CODEX_RESUME_FAILED_WARNING,
			}),
		);
		const restore = await manager.getRestoreSnapshot("task-1");
		expect(restore?.snapshot).toContain("No session found");
		expect(restore?.snapshot).toContain("Could not resume the stored Codex session");
	});

	it("clears a bad stored Claude session id after a non-zero startup resume failure", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		const onOutput = vi.fn();
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput,
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "claude-session-1",
			awaitReview: true,
		});

		spawnedSessions[0]?.triggerData("No Claude session found\n");
		spawnedSessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();

		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.resumeSessionId).toBeNull();
		expect(summary?.warningMessage).toBe(STORED_CLAUDE_RESUME_FAILED_WARNING);

		const outputText = Buffer.concat(onOutput.mock.calls.map(([chunk]) => chunk as Buffer)).toString("utf8");
		expect(outputText).toContain("No Claude session found");
		expect(outputText).toContain("Could not resume the stored Claude session");
	});

	it("does not reconnect-auto-restart a failed Codex stored-id resume", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "codex-session-1",
			awaitReview: true,
		});

		spawnedSessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();

		expect(manager.store.getSummary("task-1")?.warningMessage).toBe(STORED_CODEX_RESUME_FAILED_WARNING);

		manager.recoverStaleSession("task-1");
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.reviewReason).toBe("error");
	});

	it("does not reconnect-auto-restart after bounded startup recovery is exhausted", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});
		const recoveryToken = "recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);
		await manager.startTaskSessionWithReadiness({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "codex-session-1",
			awaitReview: true,
			startupRecoveryToken: recoveryToken,
		});

		manager.finalizeStartupRecoveryFailure("task-1", recoveryToken, {
			processStillRunning: true,
			clearResumeSessionId: false,
			warningMessage: "Recovery remains unconfirmed.",
			fallbackReviewState: null,
		});
		spawnedSessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();

		manager.recoverStaleSession("task-1");
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.isStartupRecoveryCurrent("task-1", recoveryToken)).toBe(false);
		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			pid: null,
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			awaitReview: true,
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
	});

	it("does not reconnect-auto-restart between bounded startup recovery attempts", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});
		const recoveryToken = "recovery-token";
		manager.beginStartupRecovery("task-1", recoveryToken);
		await manager.startTaskSessionWithReadiness({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "codex-session-1",
			awaitReview: true,
			startupRecoveryToken: recoveryToken,
		});
		spawnedSessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();

		manager.recoverStaleSession("task-1");
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.isStartupRecoveryCurrent("task-1", recoveryToken)).toBe(true);
	});

	it("keeps the fresh prompt fallback for clean startup resume exits", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "",
			resumeConversation: true,
			resumeSessionId: "codex-session-1",
			awaitReview: true,
		});

		spawnedSessions[0]?.triggerExit(0);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.store.getSummary("task-1")?.pid).toBe(112);
		expect(manager.store.getSummary("task-1")?.resumeSessionId).toBeNull();
	});

	it("lets bounded startup recovery own a clean resume exit without a fresh-prompt fallback", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

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
			resumeSessionId: "codex-session-1",
			awaitReview: true,
			startupRecoveryToken: recoveryToken,
		});
		const readiness = manager.waitForTaskSessionLaunch("task-1", started.sessionInstanceId ?? "", 1_000);

		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		await expect(readiness).resolves.toEqual({
			status: "exited",
			sessionInstanceId: started.sessionInstanceId,
			exitCode: 0,
		});
	});

	it("does not race generic crash restart during startup readiness stabilization", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});
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
			resumeSessionId: "codex-session-1",
			awaitReview: true,
			startupRecoveryToken: recoveryToken,
		});
		manager.recordHookReceived("task-1");
		manager.observeTaskSessionLaunchHook("task-1", {
			sessionInstanceId: started.sessionInstanceId,
			sessionId: "codex-session-1",
		});
		manager.store.update("task-1", { state: "running", reviewReason: null });

		spawnedSessions[0]?.triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});

	describe("auto-restart error handling and rate limiting", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("broadcasts error output to listeners when auto-restart spawn fails", async () => {
			let launchCount = 0;
			prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => {
				launchCount++;
				if (launchCount > 1) {
					throw new Error("Agent binary not found");
				}
				return {
					binary: input.binary,
					args: [...input.args],
					env: {},
				};
			});

			const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
			ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
				const session = createMockPtySession(111, request);
				spawnedSessions.push(session);
				return session;
			});

			const onOutput = vi.fn();
			const onState = vi.fn();
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
			manager.attach("task-1", { onState, onOutput, onExit: vi.fn() });

			await manager.startTaskSession({
				taskId: "task-1",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});

			// Exit triggers auto-restart, which will fail on prepareAgentLaunch
			spawnedSessions[0]?.triggerExit(130);

			await vi.waitFor(() => {
				const outputCalls = onOutput.mock.calls;
				const errorOutput = outputCalls.find((call) => {
					const buf = call[0] as Buffer;
					return buf.toString().includes("[quarterdeck]");
				});
				expect(errorOutput).toBeDefined();
			});

			// Verify the error message content
			const outputCalls = onOutput.mock.calls;
			const errorOutput = outputCalls.find((call) => {
				const buf = call[0] as Buffer;
				return buf.toString().includes("Agent binary not found");
			});
			expect(errorOutput).toBeDefined();

			// Verify store has warning message
			const summary = manager.store.getSummary("task-1");
			expect(summary?.warningMessage).toContain("Agent binary not found");

			// Verify state was broadcast to listener
			expect(onState).toHaveBeenCalledWith(
				expect.objectContaining({
					warningMessage: expect.stringContaining("Agent binary not found"),
				}),
			);
		});

		it("stops auto-restarting after 3 rapid exits within the rate window", async () => {
			const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
			ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
				const session = createMockPtySession(100 + spawnedSessions.length, request);
				spawnedSessions.push(session);
				return session;
			});

			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
			manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

			await manager.startTaskSession({
				taskId: "task-1",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});

			// Each restarted session starts in awaiting_review (awaitReview=true).
			// Transition back to running via hook before each exit so auto-restart
			// recognizes it as a crash (pre-exit state must be "running").
			// 1st exit -> auto-restart #1
			spawnedSessions[0]?.triggerExit(1);
			await vi.waitFor(() => expect(spawnedSessions).toHaveLength(2));

			// 2nd exit -> auto-restart #2
			manager.store.applySessionEvent("task-1", { type: "hook.to_in_progress" });
			spawnedSessions[1]?.triggerExit(1);
			await vi.waitFor(() => expect(spawnedSessions).toHaveLength(3));

			// 3rd exit -> auto-restart #3
			manager.store.applySessionEvent("task-1", { type: "hook.to_in_progress" });
			spawnedSessions[2]?.triggerExit(1);
			await vi.waitFor(() => expect(spawnedSessions).toHaveLength(4));

			// 4th exit -> rate limited, no more restarts
			manager.store.applySessionEvent("task-1", { type: "hook.to_in_progress" });
			spawnedSessions[3]?.triggerExit(1);
			await vi.advanceTimersByTimeAsync(100);
			expect(spawnedSessions).toHaveLength(4); // No 5th spawn
		});
	});
});
