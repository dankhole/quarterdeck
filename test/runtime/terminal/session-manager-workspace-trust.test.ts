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

const DOWN = "\u001b[B";

function renderClaudeTrustDialog(focus: "confirm" | "cancel"): string {
	const pointer = (option: "confirm" | "cancel") => (focus === option ? "\u276f" : " ");
	return [
		"\u001b[2J\u001b[H Accessing workspace:",
		" /tmp/workspace",
		"",
		` ${pointer("cancel")} No, exit`,
		` ${pointer("confirm")} Yes, I trust this folder`,
		"",
		" Enter to confirm \u00b7 Esc to cancel",
	].join("\r\n");
}

const CLEARED_SCREEN = "\u001b[2J\u001b[H\u276f ";

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

	it("waits out Claude's input guard, selects confirm, and confirms only once it is rendered selected", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			// Claude re-renders the select after navigation and closes it on Enter.
			session.write.mockImplementation((data: string) => {
				if (data === DOWN) session.triggerData(renderClaudeTrustDialog("confirm"));
				if (data === "\r") session.triggerData(CLEARED_SCREEN);
			});
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

		// Claude >= 2.1.283 lists and focuses "No, exit" first.
		session?.triggerData(renderClaudeTrustDialog("cancel"));

		// Claude refuses input shortly after the dialog opens; nothing is sent yet.
		await vi.advanceTimersByTimeAsync(200);
		expect(session?.write).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1_000);
		expect(session?.write.mock.calls).toEqual([[DOWN], ["\r"]]);
		expect(manager.store.getSummary("task-1")?.warningMessage ?? null).toBeNull();

		// A cleared dialog stays confirmed.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(session?.write).toHaveBeenCalledTimes(2);
	});

	it("confirms the legacy Claude trust dialog that focuses confirm first", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(112, request);
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
		session?.triggerData("\u001b[2J\u001b[H \u276f 1. Yes, I trust this folder\r\n   2. No, exit");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(session?.write.mock.calls).toEqual([["\r"]]);
	});

	it("never confirms Claude trust while decline stays selected", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(113, request);
			// Navigation keys are swallowed; the dialog keeps focusing decline.
			session.write.mockImplementation((data: string) => {
				if (data === DOWN) session.triggerData(renderClaudeTrustDialog("cancel"));
			});
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
		session?.triggerData(renderClaudeTrustDialog("cancel"));
		await vi.advanceTimersByTimeAsync(10_000);

		expect(session?.write.mock.calls).toEqual([[DOWN], [DOWN]]);
		expect(manager.store.getSummary("task-1")?.warningMessage).toContain("Yes, I trust this folder");
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

		session?.triggerData(renderClaudeTrustDialog("confirm"));

		await vi.advanceTimersByTimeAsync(1_000);

		// Trust auto-confirm is disabled, so no key should be sent
		expect(session?.write).not.toHaveBeenCalled();
	});

	it("re-arms between repeated trust prompts", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(444, request);
			session.write.mockImplementation((data: string) => {
				if (data === "\r") session.triggerData(CLEARED_SCREEN);
			});
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
		session?.triggerData(renderClaudeTrustDialog("confirm"));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(session?.write.mock.calls).toEqual([["\r"]]);

		// Second trust prompt from the same launch
		session?.triggerData(renderClaudeTrustDialog("confirm"));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(session?.write.mock.calls).toEqual([["\r"], ["\r"]]);
	});

	it("stops auto-confirming after MAX_AUTO_TRUST_CONFIRMS (5)", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(555, request);
			session.write.mockImplementation((data: string) => {
				if (data === "\r") session.triggerData(CLEARED_SCREEN);
			});
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
			session?.triggerData(renderClaudeTrustDialog("confirm"));
			await vi.advanceTimersByTimeAsync(1_000);
		}
		expect(session?.write).toHaveBeenCalledTimes(5);

		// 6th trust prompt — should NOT be auto-confirmed (cap reached)
		session?.triggerData(renderClaudeTrustDialog("confirm"));
		await vi.advanceTimersByTimeAsync(1_000);
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
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/workspace",
			prompt: "Fix the bug",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();

		// Fill the buffer with junk data exceeding the 16,384 char limit
		const junkData = "x".repeat(20_000);
		session?.triggerData(junkData);

		// Now send a trust prompt — it should still be detected because the
		// buffer was truncated (keeping the tail) and the trust prompt is new data
		session?.triggerData("Do you trust the contents of this directory?");

		await vi.advanceTimersByTimeAsync(100);

		expect(session?.write).toHaveBeenCalledWith("\r");
	});
});
