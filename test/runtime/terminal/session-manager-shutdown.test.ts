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
import { createTestProviderHookRequest } from "../../utilities/task-session-factory";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: ((value: T) => void) | null = null;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) {
		throw new Error("Deferred promise resolver was not initialized.");
	}
	return { promise, resolve: resolvePromise };
}

function createMockPtySession(pid: number, request: MockSpawnRequest, options?: { exitOnStop?: boolean }) {
	let interrupted = false;
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn((stopOptions?: { interrupted?: boolean }) => {
			if (stopOptions?.interrupted) {
				interrupted = true;
			}
			if (options?.exitOnStop) {
				request.onExit?.({ exitCode: null });
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

function applyCurrentProviderHook(
	manager: TerminalSessionManager,
	event: "activity" | "to_review" | "to_in_progress",
	options: { hookEventName?: string; metadata?: Record<string, string> } = {},
): void {
	const summary = manager.store.getSummary("task-1");
	if (!summary) throw new Error("Expected task session summary.");
	manager.applyProviderHook(
		"task-1",
		createTestProviderHookRequest(summary, event, {
			hookEventName: options.hookEventName,
			metadata: options.metadata,
		}),
	);
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

		expect(summary1?.state).toBe("awaiting_review");
		expect(summary2?.state).toBe("awaiting_review");
		expect(summary1?.reviewReason).toBe("interrupted");
		expect(summary2?.reviewReason).toBe("interrupted");

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
		expect(results.every((summary) => summary.state === "awaiting_review")).toBe(true);
		expect(results.every((summary) => summary.reviewReason === "interrupted")).toBe(true);
	});

	it("preserves completed review semantics while making its chat recoverable", async () => {
		let spawned: ReturnType<typeof createMockPtySession> | null = null;
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			spawned = createMockPtySession(111, request);
			return spawned;
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
		applyCurrentProviderHook(manager, "to_review", {
			metadata: { finalMessage: "Implemented and verified." },
		});

		const [summary] = manager.markInterruptedAndStopAll();

		expect(spawned).not.toBeNull();
		expect(summary).toMatchObject({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			startupRecoveryRequired: true,
			latestHookActivity: {
				hookEventName: "Stop",
				finalMessage: "Implemented and verified.",
			},
		});
	});

	it("suppresses a synchronous shutdown exit before it can restart and erase the captured session id", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request, { exitOnStop: true });
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
		applyCurrentProviderHook(manager, "activity", {
			hookEventName: "SessionStart",
			metadata: { sessionId: "codex-session-1" },
		});

		expect(manager.store.getSummary("task-1")?.resumeSessionId).toBe("codex-session-1");

		const [interrupted] = manager.markInterruptedAndStopAll();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(spawnedSessions).toHaveLength(1);
		expect(interrupted).toMatchObject({
			taskId: "task-1",
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			resumeSessionId: "codex-session-1",
			startupRecoveryRequired: true,
		});
		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			resumeSessionId: "codex-session-1",
			startupRecoveryRequired: true,
		});
	});

	it("cancels an auto-restart awaiting launch preparation and waits for it before shutdown persistence", async () => {
		const delayedPreparation = createDeferred<{ binary: string; args: string[]; env: Record<string, string> }>();
		prepareAgentLaunchMock
			.mockResolvedValueOnce({ binary: "codex", args: [], env: {} })
			.mockImplementationOnce(async () => await delayedPreparation.promise);
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
			prompt: "Fix the bug",
		});
		applyCurrentProviderHook(manager, "activity", {
			hookEventName: "SessionStart",
			metadata: { sessionId: "codex-session-1" },
		});
		applyCurrentProviderHook(manager, "to_in_progress", {
			hookEventName: "UserPromptSubmit",
			metadata: { sessionId: "codex-session-1" },
		});

		spawnedSessions[0]?.triggerExit(1);
		await vi.waitFor(() => expect(prepareAgentLaunchMock).toHaveBeenCalledTimes(2));

		const [interrupted] = manager.markInterruptedAndStopAll();
		const quiescence = manager.waitForShutdownQuiescence();
		delayedPreparation.resolve({ binary: "codex", args: ["resume", "codex-session-1"], env: {} });
		await quiescence;

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(spawnedSessions).toHaveLength(1);
		expect(interrupted).toMatchObject({
			taskId: "task-1",
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			resumeSessionId: "codex-session-1",
			startupRecoveryRequired: true,
		});
		expect(manager.store.getSummary("task-1")).toMatchObject(interrupted ?? {});
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
		expect(results[0]?.state).toBe("awaiting_review");
		expect(results[0]?.reviewReason).toBe("interrupted");
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

	it("sets Review/Error when PtySession.spawn throws", async () => {
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
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.pid).toBeNull();
	});

	it("does not mislabel an unclassified ENOENT as a missing agent command", async () => {
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
		).rejects.toThrow("Error: spawn ENOENT");
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
