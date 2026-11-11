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

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		forceRedraw: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		registerManagedProcessOwnership: vi.fn(async () => undefined),
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
		expect(spawnedSessions[0]?.registerManagedProcessOwnership).toHaveBeenCalledWith(expect.any(String));
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
		expect(summary?.state).toBe("awaiting_review");
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
		expect(summary?.state).toBe("awaiting_review");
		expect(summary?.reviewReason).toBe("error");
		expect(summary?.agentId).toBeNull();
	});

	it("stops and fails closed when managed shell ownership cannot be registered", async () => {
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			session.registerManagedProcessOwnership.mockRejectedValue(new Error("ownership unavailable"));
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());

		await expect(
			manager.startShellSession({
				taskId: "shell-ownership-failure",
				cwd: "/tmp/project",
				binary: "/bin/zsh",
			}),
		).rejects.toThrow("Failed to launch");

		expect(spawnedSessions[0]?.stop).toHaveBeenCalledWith({ interrupted: true });
		expect(manager.store.getSummary("shell-ownership-failure")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "error",
			pid: null,
		});
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

	it("coalesces starts while process ownership registration is pending", async () => {
		const registration = deferred();
		const spawned = deferred();
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			session.registerManagedProcessOwnership.mockImplementation(async () => {
				spawned.resolve();
				await registration.promise;
			});
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const request = { taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" };
		const first = manager.startShellSession(request);
		await spawned.promise;
		const second = manager.startShellSession(request);
		expect(manager.hasPendingOwnedProcessLaunches()).toBe(true);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		registration.resolve();
		const [one, two] = await Promise.all([first, second]);
		expect(two.sessionInstanceId).toBe(one.sessionInstanceId);
		expect(two.pid).toBe(one.pid);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.hasPendingOwnedProcessLaunches()).toBe(false);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
	});

	it("retains viewerless output and restores the same process after all viewers detach", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const request = { taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" };
		const initial = await manager.startShellSession(request);
		const onOutput = vi.fn();
		const detach = manager.attach("shell-1", { onOutput });
		spawnedSessions[0]?.triggerData("before-hide\r\n");
		detach?.();
		spawnedSessions[0]?.triggerData("while-hidden\r\n");
		const restored = await manager.getRestoreSnapshot("shell-1");
		expect(restored?.snapshot).toContain("before-hide");
		expect(restored?.snapshot).toContain("while-hidden");
		const reopened = await manager.startShellSession(request);
		expect(reopened).toMatchObject({
			pid: initial.pid,
			sessionInstanceId: initial.sessionInstanceId,
			startedAt: initial.startedAt,
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
		const nextOutput = vi.fn();
		const detachAgain = manager.attach("shell-1", { onOutput: nextOutput });
		expect(nextOutput).not.toHaveBeenCalled();
		spawnedSessions[0]?.triggerData("after-reattach");
		expect(nextOutput).toHaveBeenCalledOnce();
		expect(onOutput).toHaveBeenCalledOnce();
		detachAgain?.();
	});

	it("rejects reopen while stopping and ignores the old PTY's delayed exit after explicit restart", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const request = { taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" };
		const first = await manager.startShellSession(request);
		manager.stopTaskSession("shell-1");
		await expect(manager.startShellSession(request)).rejects.toThrow("still shutting down");
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		spawnedSessions[0]?.triggerExit(null);
		const second = await manager.startShellSession(request);
		expect(second.sessionInstanceId).not.toBe(first.sessionInstanceId);
		spawnedSessions[0]?.triggerExit(1);
		expect(manager.store.getSummary("shell-1")).toMatchObject({
			pid: second.pid,
			sessionInstanceId: second.sessionInstanceId,
		});
		expect(spawnedSessions[1]?.stop).not.toHaveBeenCalled();
	});

	it("keeps the manual shell reusable after Ctrl+C interrupts a foreground command", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const request = { taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" };
		const first = await manager.startShellSession(request);
		manager.writeInput("shell-1", Buffer.from("\u0003"));
		expect(spawnedSessions[0]?.write).toHaveBeenCalledWith(Buffer.from("\u0003"));
		expect(manager.store.getSummary("shell-1")).toMatchObject({ state: "running", reviewReason: null });
		await expect(manager.startShellSession(request)).resolves.toMatchObject({
			sessionInstanceId: first.sessionInstanceId,
			pid: first.pid,
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
	});

	it("fences and drains a pending shell handoff during shutdown", async () => {
		const registration = deferred();
		const spawned = deferred();
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			session.registerManagedProcessOwnership.mockImplementation(async () => {
				spawned.resolve();
				await registration.promise;
			});
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const starting = manager.startShellSession({ taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" });
		const rejected = expect(starting).rejects.toThrow("cancelled");
		await spawned.promise;
		manager.markInterruptedAndStopAll();
		let drained = false;
		const draining = manager.waitForShutdownQuiescence().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		registration.resolve();
		await rejected;
		await draining;
		expect(spawnedSessions[0]?.stop).toHaveBeenCalledWith({ interrupted: true });
		expect(manager.store.getSummary("shell-1")?.state).not.toBe("running");
		expect(manager.getOwnedProcessRootPids()).toEqual([]);
	});

	it("waits for an admitted shell start before confirming its exact stop", async () => {
		const registration = deferred();
		const spawned = deferred();
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			session.stop.mockImplementation(() => session.triggerExit(null));
			session.wasInterrupted.mockReturnValue(true);
			session.registerManagedProcessOwnership.mockImplementation(async () => {
				spawned.resolve();
				await registration.promise;
			});
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const starting = manager.startShellSession({ taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" });
		await spawned.promise;
		const stopping = manager.stopTaskSessionAndWaitForExit("shell-1");
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
		registration.resolve();
		await starting;
		await expect(stopping).resolves.toMatchObject({ didExit: true, outcome: "exited", summary: { pid: null } });
	});

	it("conditionally restarts only the exact unexpected exit and never stops a replacement", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const request = { taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" };
		const first = await manager.startShellSession(request);
		spawnedSessions[0]?.triggerExit(1);
		const second = await manager.startShellSession({
			...request,
			expectedExitedSessionInstanceId: first.sessionInstanceId ?? undefined,
		});
		expect(second.sessionInstanceId).not.toBe(first.sessionInstanceId);
		const stale = await manager.startShellSession({
			...request,
			expectedExitedSessionInstanceId: first.sessionInstanceId ?? undefined,
		});
		expect(stale.sessionInstanceId).toBe(second.sessionInstanceId);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(spawnedSessions[1]?.stop).not.toHaveBeenCalled();
	});

	it.each([0, 1])(
		"does not automatically restart an explicitly terminated exited shell (exit %s)",
		async (exitCode) => {
			const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
			const request = { taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" };
			const first = await manager.startShellSession(request);
			spawnedSessions[0]?.triggerExit(exitCode);
			await expect(manager.stopTaskSessionAndWaitForExit("shell-1")).resolves.toMatchObject({
				didExit: true,
				outcome: "not_running",
				summary: { reviewReason: "interrupted" },
			});
			await manager.startShellSession({
				...request,
				expectedExitedSessionInstanceId: first.sessionInstanceId ?? undefined,
			});
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
			await manager.startShellSession(request);
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		},
	);

	it("retains explicit-stop suppression even when the stopped PTY reports a nonzero exit", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const request = { taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" };
		const first = await manager.startShellSession(request);
		manager.stopTaskSession("shell-1");
		spawnedSessions[0]?.triggerExit(1);
		await manager.startShellSession({
			...request,
			expectedExitedSessionInstanceId: first.sessionInstanceId ?? undefined,
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});

	it("does not let an agent launch replace a retained manual shell", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const first = await manager.startShellSession({ taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" });
		await expect(
			manager.startTaskSession({
				taskId: "shell-1",
				cwd: "/tmp/project",
				agentId: "claude",
				binary: "claude",
				args: [],
				prompt: "",
			}),
		).rejects.toThrow("shell session already owns");
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(manager.store.getSummary("shell-1")?.sessionInstanceId).toBe(first.sessionInstanceId);
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
	});

	it("stops all retained project shells on manager disposal regardless of listeners", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		await manager.startShellSession({ taskId: "home-shell", cwd: "/tmp/project", binary: "/bin/sh" });
		await manager.startShellSession({ taskId: "detail-shell", cwd: "/tmp/worktree", binary: "/bin/sh" });
		manager.markInterruptedAndStopAll();
		await manager.waitForShutdownQuiescence();
		for (const session of spawnedSessions) expect(session.stop).toHaveBeenCalledWith({ interrupted: true });
		await expect(
			manager.startShellSession({ taskId: "home-shell", cwd: "/tmp/project", binary: "/bin/sh" }),
		).rejects.toThrow("cancelled");
	});

	it("does not automatically restart a clean natural exit", async () => {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
		const request = { taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" };
		const first = await manager.startShellSession(request);
		spawnedSessions[0]?.triggerExit(0);
		await manager.startShellSession({
			...request,
			expectedExitedSessionInstanceId: first.sessionInstanceId ?? undefined,
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});
});
