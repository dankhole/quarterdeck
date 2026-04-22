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

describe("TerminalSessionManager shell sessions", () => {
	let spawnedSessions: Array<ReturnType<typeof createMockPtySession>>;

	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();

		spawnedSessions = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});
	});

	afterEach(() => {
		spawnedSessions = [];
	});

	it("starts a shell session and sets running state", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		const result = await manager.startShellSession({
			taskId: "shell-1",
			cwd: "/tmp/project",
			binary: "/bin/zsh",
		});

		expect(result.state).toBe("running");
		expect(result.agentId).toBeNull();
		expect(result.pid).toBe(111);
		expect(result.sessionLaunchPath).toBe("/tmp/project");
	});

	it("delivers output data to attached listeners", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const onOutput = vi.fn();

		await manager.startShellSession({
			taskId: "shell-1",
			cwd: "/tmp/project",
			binary: "/bin/zsh",
		});

		manager.attach("shell-1", { onOutput });

		spawnedSessions[0]?.triggerData("hello world");

		expect(onOutput).toHaveBeenCalledTimes(1);
		const receivedBuffer = onOutput.mock.calls[0][0] as Buffer;
		expect(receivedBuffer.toString("utf8")).toBe("hello world");
	});

	it("transitions to idle on clean exit (code 0)", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startShellSession({
			taskId: "shell-1",
			cwd: "/tmp/project",
			binary: "/bin/zsh",
		});

		spawnedSessions[0]?.triggerExit(0);

		const summary = manager.store.getSummary("shell-1");
		expect(summary?.state).toBe("idle");
		expect(summary?.reviewReason).toBeNull();
		expect(summary?.exitCode).toBe(0);
		expect(summary?.pid).toBeNull();
	});

	it("transitions to idle on non-zero exit", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startShellSession({
			taskId: "shell-1",
			cwd: "/tmp/project",
			binary: "/bin/zsh",
		});

		spawnedSessions[0]?.triggerExit(1);

		const summary = manager.store.getSummary("shell-1");
		expect(summary?.state).toBe("idle");
		expect(summary?.reviewReason).toBeNull();
		expect(summary?.exitCode).toBe(1);
	});

	it("transitions to interrupted when process was interrupted", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startShellSession({
			taskId: "shell-1",
			cwd: "/tmp/project",
			binary: "/bin/zsh",
		});

		spawnedSessions[0]?.wasInterrupted.mockReturnValue(true);
		spawnedSessions[0]?.triggerExit(null);

		const summary = manager.store.getSummary("shell-1");
		expect(summary?.state).toBe("interrupted");
		expect(summary?.reviewReason).toBe("interrupted");
	});

	it("notifies listeners on exit", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const onState = vi.fn();
		const onExit = vi.fn();

		await manager.startShellSession({
			taskId: "shell-1",
			cwd: "/tmp/project",
			binary: "/bin/zsh",
		});

		manager.attach("shell-1", { onState, onExit });
		spawnedSessions[0]?.triggerExit(0);

		expect(onExit).toHaveBeenCalledWith(0);
		expect(onState).toHaveBeenCalled();
		const lastStateCall = onState.mock.calls[onState.mock.calls.length - 1][0];
		expect(lastStateCall.state).toBe("idle");
	});

	it("handles spawn failure gracefully", async () => {
		ptySessionSpawnMock.mockImplementation(() => {
			throw new Error("posix_spawnp failed");
		});

		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await expect(
			manager.startShellSession({
				taskId: "shell-1",
				cwd: "/tmp/project",
				binary: "/bin/nonexistent",
			}),
		).rejects.toThrow("Failed to launch");

		const summary = manager.store.getSummary("shell-1");
		expect(summary?.state).toBe("failed");
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.agentId).toBeNull();
	});

	it("is idempotent when session is already running", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await manager.startShellSession({
			taskId: "shell-1",
			cwd: "/tmp/project",
			binary: "/bin/zsh",
		});

		await manager.startShellSession({
			taskId: "shell-1",
			cwd: "/tmp/project",
			binary: "/bin/zsh",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.store.getSummary("shell-1")?.state).toBe("running");
	});
});
