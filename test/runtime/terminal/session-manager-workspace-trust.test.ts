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

describe("TerminalSessionManager workspace trust auto-confirm", () => {
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

	it("auto-confirms Claude workspace trust prompt after delay", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/workspace",
			projectPath: "/tmp/workspace",
			prompt: "Fix the bug",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();

		// Simulate Claude trust prompt output
		session?.triggerData("Do you want to trust this folder? Yes, I trust this folder");

		// Confirm has not been sent yet (delayed by 100ms)
		expect(session?.write).not.toHaveBeenCalled();

		// Advance past the trust confirm delay
		await vi.advanceTimersByTimeAsync(100);

		expect(session?.write).toHaveBeenCalledWith("\r");
	});

	it("auto-confirms Codex workspace trust prompt after delay", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/workspace",
			prompt: "Fix the bug",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();

		// Simulate Codex trust prompt output
		session?.triggerData("Do you trust the contents of this directory?");

		expect(session?.write).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100);

		expect(session?.write).toHaveBeenCalledWith("\r");
	});

	it("does not auto-confirm when willAutoTrust is false", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(333, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		// Use a non-claude/non-codex agent so willAutoTrust is false
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/some/random/path",
			prompt: "Fix the bug",
			// No projectPath, and cwd is not under worktrees home
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();

		session?.triggerData("Do you want to trust this folder? Yes, I trust this folder");

		await vi.advanceTimersByTimeAsync(100);

		// Trust buffer was null (disabled), so no auto-confirm should happen
		expect(session?.write).not.toHaveBeenCalled();
	});

	it("re-arms between trust prompts for --add-dir", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(444, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/workspace",
			projectPath: "/tmp/workspace",
			prompt: "Fix the bug",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();

		// First trust prompt
		session?.triggerData("Do you want to trust this folder? Yes, I trust this folder");
		await vi.advanceTimersByTimeAsync(100);
		expect(session?.write).toHaveBeenCalledWith("\r");
		expect(session?.write).toHaveBeenCalledTimes(1);

		// Second trust prompt (e.g. from --add-dir)
		session?.triggerData("Do you want to trust this folder? Yes, I trust this folder");
		await vi.advanceTimersByTimeAsync(100);
		expect(session?.write).toHaveBeenCalledTimes(2);
		expect(session?.write).toHaveBeenNthCalledWith(2, "\r");
	});

	it("stops auto-confirming after MAX_AUTO_TRUST_CONFIRMS (5)", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(555, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/workspace",
			projectPath: "/tmp/workspace",
			prompt: "Fix the bug",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();

		// Trigger 5 trust prompts — all should be auto-confirmed
		for (let i = 0; i < 5; i++) {
			session?.triggerData("Do you want to trust this folder? Yes, I trust this folder");
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(session?.write).toHaveBeenCalledTimes(5);

		// 6th trust prompt — should NOT be auto-confirmed (cap reached)
		session?.triggerData("Do you want to trust this folder? Yes, I trust this folder");
		await vi.advanceTimersByTimeAsync(100);
		expect(session?.write).toHaveBeenCalledTimes(5);

		// Verify warning message was set on the store
		const summary = manager.store.getSummary("task-1");
		expect(summary?.warningMessage).toBeTruthy();
		expect(summary?.warningMessage).toContain("Auto-confirmed 5 workspace trust prompts");
	});

	it("truncates trust buffer at MAX_WORKSPACE_TRUST_BUFFER_CHARS", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(666, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/workspace",
			projectPath: "/tmp/workspace",
			prompt: "Fix the bug",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();

		// Fill the buffer with junk data exceeding the 16,384 char limit
		const junkData = "x".repeat(20_000);
		session?.triggerData(junkData);

		// Now send a trust prompt — it should still be detected because the
		// buffer was truncated (keeping the tail) and the trust prompt is new data
		session?.triggerData("Do you want to trust this folder? Yes, I trust this folder");

		await vi.advanceTimersByTimeAsync(100);

		expect(session?.write).toHaveBeenCalledWith("\r");
	});
});
