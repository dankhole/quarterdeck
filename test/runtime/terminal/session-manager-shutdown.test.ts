import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("markInterruptedAndStopAll", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("marks all active sessions as interrupted and stops them", async () => {
		let sessionCounter = 0;
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			sessionCounter++;
			const session = createMockPtySession(sessionCounter * 111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		await manager.startTaskSession({
			taskId: "task-2",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-2",
			prompt: "Add tests",
		});

		expect(spawnedSessions).toHaveLength(2);

		manager.markInterruptedAndStopAll();

		const summary1 = manager.store.getSummary("task-1");
		const summary2 = manager.store.getSummary("task-2");

		expect(summary1?.state).toBe("interrupted");
		expect(summary2?.state).toBe("interrupted");

		expect(spawnedSessions[0]?.stop).toHaveBeenCalledWith({ interrupted: true });
		expect(spawnedSessions[1]?.stop).toHaveBeenCalledWith({ interrupted: true });
	});

	it("returns array of interrupted summaries", async () => {
		let sessionCounter = 0;
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			sessionCounter++;
			const session = createMockPtySession(sessionCounter * 111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		await manager.startTaskSession({
			taskId: "task-2",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-2",
			prompt: "Add tests",
		});

		const results = manager.markInterruptedAndStopAll();

		expect(results).toHaveLength(2);
		expect(results.every((s) => s.state === "interrupted")).toBe(true);
	});

	it("skips entries with no active process", async () => {
		let sessionCounter = 0;
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			sessionCounter++;
			const session = createMockPtySession(sessionCounter * 111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		await manager.startTaskSession({
			taskId: "task-2",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-2",
			prompt: "Add tests",
		});

		// Let task-1 exit naturally before the shutdown call
		spawnedSessions[0]?.triggerExit(0);

		const results = manager.markInterruptedAndStopAll();

		// Only task-2 should have been stopped — task-1 already exited
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
		expect(spawnedSessions[1]?.stop).toHaveBeenCalledWith({ interrupted: true });

		// Only task-2 should be in the returned interrupted summaries
		expect(results).toHaveLength(1);
		expect(results[0]?.taskId).toBe("task-2");
		expect(results[0]?.state).toBe("interrupted");
	});

	it("returns empty array when no active sessions", () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		const results = manager.markInterruptedAndStopAll();

		expect(results).toEqual([]);
	});
});

describe("task session spawn failure", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("sets state to failed when PtySession.spawn throws", async () => {
		ptySessionSpawnMock.mockImplementation(() => {
			throw new Error("spawn ENOENT");
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await expect(
			manager.startTaskSession({
				taskId: "task-1",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			}),
		).rejects.toThrow("Failed to launch");

		const summary = manager.store.getSummary("task-1");
		expect(summary?.state).toBe("failed");
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.pid).toBeNull();
	});

	it("includes 'not found' in error message for ENOENT failures", async () => {
		ptySessionSpawnMock.mockImplementation(() => {
			throw new Error("spawn ENOENT");
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await expect(
			manager.startTaskSession({
				taskId: "task-1",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			}),
		).rejects.toThrow("not found");
	});

	it("calls launch cleanup on spawn failure", async () => {
		const cleanupMock = vi.fn(async () => {});
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "claude",
			args: [],
			env: {},
			cleanup: cleanupMock,
		});

		ptySessionSpawnMock.mockImplementation(() => {
			throw new Error("some error");
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await expect(
			manager.startTaskSession({
				taskId: "task-1",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			}),
		).rejects.toThrow("Failed to launch");

		// cleanup is fire-and-forget async — flush microtask queue
		await Promise.resolve();
		expect(cleanupMock).toHaveBeenCalled();
	});

	it("sets agentId in failed state", async () => {
		ptySessionSpawnMock.mockImplementation(() => {
			throw new Error("some error");
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await expect(
			manager.startTaskSession({
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			}),
		).rejects.toThrow("Failed to launch");

		const summary = manager.store.getSummary("task-1");
		expect(summary?.agentId).toBe("codex");
	});
});
