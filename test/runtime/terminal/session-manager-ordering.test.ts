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

import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { InMemorySessionSummaryStore } from "../../../src/terminal/session-summary-store";

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

	// ── Gap 2: writeInput CR optimistic transition ──────────────────────

	describe("writeInput CR optimistic transition", () => {
		it("CR triggers immediate transition from awaiting_review to running for non-Codex agent", async () => {
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

			// State must have transitioned synchronously before the PTY write
			expect(manager.store.getSummary("task-1")?.state).toBe("running");
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(1);
		});

		it("LF (Shift+Enter newline) does NOT trigger optimistic transition for non-Codex agent", async () => {
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

			manager.writeInput("task-1", Buffer.from([0x0a]));

			// LF is sent by Shift+Enter for multi-line input — should NOT move to running
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			// Input is still forwarded to the PTY
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(1);
		});

		it("Codex agent is excluded from CR optimistic transition", async () => {
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
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			manager.writeInput("task-1", Buffer.from([0x0d]));

			// Codex stays in awaiting_review — it uses its own prompt-ready flow
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			// The PTY write still happens
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(1);
		});

		it("non-Enter input does not trigger optimistic transition", async () => {
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

			manager.writeInput("task-1", Buffer.from("hello"));

			// No CR/LF means no transition
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
			expect(spawnedSessions[0]?.write).toHaveBeenCalledTimes(1);
		});
	});

	// ── Gap 3: writeInput Codex flag ordering ───────────────────────────

	describe("writeInput Codex awaitingCodexPromptAfterEnter flag ordering", () => {
		it("agent.prompt-ready is blocked when awaitingCodexPromptAfterEnter flag is not set", async () => {
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
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});

			manager.store.transitionToReview("task-1", "hook");
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			// Without pressing Enter first, PROMPT_READY should NOT trigger transition
			// because awaitingCodexPromptAfterEnter defaults to false
			spawnedSessions[0]?.triggerData("PROMPT_READY");

			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");
		});

		it("agent.prompt-ready is allowed after Enter sets awaitingCodexPromptAfterEnter flag", async () => {
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
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});

			manager.store.transitionToReview("task-1", "hook");
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			// Press Enter to set the flag
			manager.writeInput("task-1", Buffer.from([0x0d]));
			// Codex stays in awaiting_review (no optimistic transition for Codex)
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			// Now PROMPT_READY should trigger the transition because the flag is set
			spawnedSessions[0]?.triggerData("PROMPT_READY");

			expect(manager.store.getSummary("task-1")?.state).toBe("running");
		});

		it("flag is set BEFORE the PTY write so synchronous PTY responses see it", async () => {
			// This test verifies ordering: awaitingCodexPromptAfterEnter must be set
			// BEFORE session.write() is called. We simulate a PTY that responds
			// synchronously to an Enter keypress by firing onData("PROMPT_READY")
			// inside the write mock. If the flag was set before the write, the onData
			// handler will see the flag as true and allow the agent.prompt-ready
			// transition. If the flag was set after, the transition would be blocked.
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

			let capturedOnData: ((chunk: Buffer) => void) | undefined;
			ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
				capturedOnData = request.onData;
				const session = createMockPtySession(333, request);
				// When Enter is written to the PTY, the Codex TUI "responds" immediately
				// by redrawing the prompt. This simulates a synchronous PTY response.
				session.write.mockImplementation((data: Buffer | string) => {
					const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
					if (buf.includes(0x0d) || buf.includes(0x0a)) {
						capturedOnData?.(Buffer.from("PROMPT_READY", "utf8"));
					}
				});
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
			});

			manager.store.transitionToReview("task-1", "hook");
			expect(manager.store.getSummary("task-1")?.state).toBe("awaiting_review");

			// This single call must:
			// 1. Set awaitingCodexPromptAfterEnter = true
			// 2. Call session.write(Enter)
			// 3. The write mock fires onData("PROMPT_READY") synchronously
			// 4. The onData handler checks the flag — if true, applies transition
			// If step 1 happened after step 2, the flag would be false during
			// the onData handler and the transition would be blocked.
			manager.writeInput("task-1", Buffer.from([0x0d]));

			expect(manager.store.getSummary("task-1")?.state).toBe("running");
		});
	});
});
