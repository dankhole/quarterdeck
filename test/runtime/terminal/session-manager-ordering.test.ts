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

	// ── Gap 2: writeInput does NOT optimistically transition state ──────
	// State transitions are driven exclusively by hooks (to_in_progress,
	// to_review). writeInput just forwards data to the PTY.

	describe("writeInput does not transition state on Enter", () => {
		it("CR on non-Codex agent stays in awaiting_review", async () => {
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

			// State stays in awaiting_review — only hooks move to running
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			// Input is still forwarded to the PTY
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(1);
		});
	});
});
