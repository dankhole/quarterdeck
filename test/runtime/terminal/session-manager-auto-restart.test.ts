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
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
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
		expect(manager.store.getSummary("task-1")?.pid).toBeNull();
		expect(manager.store.getSummary("task-1")?.resumeSessionId).toBe("codex-session-1");
	});

	it("sends deferred Codex startup input when the prompt marker appears", async () => {
		const deferredStartupInput = "\u001b[200~/plan Validate rollout\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("Booting Codex\n");
		expect(session.write).not.toHaveBeenCalledWith(deferredStartupInput);

		session.triggerData("› ");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it("sends deferred Codex startup input when the startup UI header appears", async () => {
		const deferredStartupInput = "\u001b[200~/plan Validate startup UI detect\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData(">_ OpenAI Codex (v0.117.0)\n");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
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
