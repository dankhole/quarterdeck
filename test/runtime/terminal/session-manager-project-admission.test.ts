import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskResourceOperationCoordinator } from "../../../src/core/task-resource-operation-coordinator";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));
vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: { spawn: ptySessionSpawnMock },
}));

import {
	InMemorySessionSummaryStore,
	type StartTaskSessionRequest,
	TerminalSessionManager,
} from "../../../src/terminal";
import { TaskSessionStartCancelledError } from "../../../src/terminal/session-manager-types";
import { createTestProviderHookRequest, createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

interface MockSpawnRequest {
	onExit?: (event: { exitCode: number | null }) => void;
}

function createMockPtySession(request: MockSpawnRequest, pid: number) {
	let interrupted = false;
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		registerManagedProcessOwnership: vi.fn(async () => undefined),
		stop: vi.fn((options?: { interrupted?: boolean }) => {
			interrupted = options?.interrupted ?? false;
			request.onExit?.({ exitCode: null });
		}),
		wasInterrupted: () => interrupted,
		triggerExit: (exitCode: number) => request.onExit?.({ exitCode }),
	};
}

const startRequest: StartTaskSessionRequest = {
	taskId: "task-1",
	agentId: "claude",
	binary: "claude",
	args: [],
	cwd: "/tmp/project",
	projectId: "project-1",
	projectPath: "/tmp/project",
	prompt: "Do the task",
};

describe("TerminalSessionManager project launch admission", () => {
	const managers: TerminalSessionManager[] = [];
	let spawned: Array<ReturnType<typeof createMockPtySession>>;

	function createManager() {
		const manager = new TerminalSessionManager(new InMemorySessionSummaryStore(), { projectId: "project-1" });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (request: { binary: string; args: string[] }) => ({
			binary: request.binary,
			args: request.args,
			env: {},
		}));
		spawned = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(request, 101 + spawned.length);
			spawned.push(session);
			return session;
		});
	});

	afterEach(() => {
		for (const manager of managers.splice(0)) manager.markInterruptedAndStopAll();
	});

	it("revalidates task and shell launch admission after a location change without mutating saved sessions", async () => {
		const gate = new TaskResourceOperationCoordinator();
		const manager = createManager();
		manager.store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ startupRecoveryRequired: true }),
		});
		let locationIsCurrent = true;
		manager.setLaunchOperationRunner((operation) =>
			gate.runProject("project-1", async () => {
				if (!locationIsCurrent) throw new Error("Project location changed. Select the project again.");
				return operation();
			}),
		);
		const relocationStarted = createDeferred<void>();
		const finishRelocation = createDeferred<void>();
		const relocation = gate.runProjectExclusive("project-1", async () => {
			relocationStarted.resolve();
			await finishRelocation.promise;
			locationIsCurrent = false;
		});
		await relocationStarted.promise;

		const taskStart = manager.startTaskSession(startRequest);
		const shellStart = manager.startShellSession({ taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" });
		const startsRejected = Promise.all([
			expect(taskStart).rejects.toThrow("Project location changed"),
			expect(shellStart).rejects.toThrow("Project location changed"),
		]);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(manager.store.getSummary("task-1")?.startupRecoveryRequired).toBe(true);
		finishRelocation.resolve();
		await Promise.all([relocation, startsRejected]);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(manager.store.getSummary("task-1")?.startupRecoveryRequired).toBe(true);
		expect(manager.store.getSummary("shell-1")).toBeNull();
	});

	it("keeps the project admitted until a pending native launch has handed off its process", async () => {
		const gate = new TaskResourceOperationCoordinator();
		const manager = createManager();
		manager.setLaunchOperationRunner((operation) => gate.runProject("project-1", operation));
		const preparing = createDeferred<void>();
		const prepared = createDeferred<void>();
		prepareAgentLaunchMock.mockImplementation(async () => {
			preparing.resolve();
			await prepared.promise;
			return { binary: "claude", args: [], env: {} };
		});
		const launch = manager.startTaskSession(startRequest);
		await preparing.promise;
		const observeRelocation = vi.fn(() => manager.getTaskSessionProcessIdentity("task-1"));
		const relocation = gate.runProjectExclusive("project-1", async () => observeRelocation());
		await Promise.resolve();
		expect(observeRelocation).not.toHaveBeenCalled();
		prepared.resolve();
		await launch;
		await expect(relocation).resolves.toMatchObject({ pid: 101 });
	});

	it("cancels a crash restart queued behind relocation before waiting for shutdown quiescence", async () => {
		const gate = new TaskResourceOperationCoordinator();
		const manager = createManager();
		manager.attach("task-1", { onOutput: vi.fn() });
		await manager.startTaskSession(startRequest);
		const initial = manager.store.getSummary("task-1");
		if (!initial) throw new Error("Expected a task session.");
		manager.applyProviderHook(
			"task-1",
			createTestProviderHookRequest(initial, "to_in_progress", {
				hookEventName: "UserPromptSubmit",
				metadata: { sessionId: "provider-session-1" },
			}),
		);
		const restartQueued = createDeferred<void>();
		manager.setLaunchOperationRunner((operation) => {
			const launch = gate.runProject("project-1", operation);
			restartQueued.resolve();
			return launch;
		});
		const releaseAdmittedWork = createDeferred<void>();
		const admittedWork = gate.runProject("project-1", () => releaseAdmittedWork.promise);
		let relocationFinished = false;
		const relocation = gate.runProjectExclusive("project-1", async () => {
			manager.markInterruptedAndStopAll();
			await manager.waitForShutdownQuiescence();
			relocationFinished = true;
		});
		spawned[0]?.triggerExit(1);
		await restartQueued.promise;
		releaseAdmittedWork.resolve();
		await admittedWork;

		await vi.waitFor(() => expect(relocationFinished).toBe(true));
		await relocation;
		// Let the abandoned gate callback run after relocation releases its lock.
		await gate.runProject("project-1", async () => undefined);
		expect(prepareAgentLaunchMock).toHaveBeenCalledOnce();
		expect(ptySessionSpawnMock).toHaveBeenCalledOnce();
		expect(manager.hasTaskSessionLifecycleActivity("task-1")).toBe(false);
		expect(manager.store.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			resumeSessionId: "provider-session-1",
		});
	});

	it("rejects queued task and shell launches during shutdown before their admission lock is released", async () => {
		const gate = new TaskResourceOperationCoordinator();
		const manager = createManager();
		manager.setLaunchOperationRunner((operation) => gate.runProject("project-1", operation));
		const exclusiveEntered = createDeferred<void>();
		const releaseExclusive = createDeferred<void>();
		const exclusive = gate.runProjectExclusive("project-1", async () => {
			exclusiveEntered.resolve();
			await releaseExclusive.promise;
		});
		await exclusiveEntered.promise;
		const starts = Promise.allSettled([
			manager.startTaskSession(startRequest),
			manager.startShellSession({ taskId: "shell-1", cwd: "/tmp/project", binary: "/bin/sh" }),
		]);
		let settled = false;
		void starts.then(() => {
			settled = true;
		});
		try {
			manager.markInterruptedAndStopAll();
			await manager.waitForShutdownQuiescence();
			await vi.waitFor(() => expect(settled).toBe(true));
			for (const result of await starts) {
				expect(result).toMatchObject({ status: "rejected", reason: expect.any(TaskSessionStartCancelledError) });
			}
		} finally {
			releaseExclusive.resolve();
			await exclusive;
		}
		await gate.runProject("project-1", async () => undefined);
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(manager.store.listSummaries()).toEqual([]);
	});

	it.each(["automatic crash restart", "terminal restore"])(
		"rechecks project availability for %s instead of bypassing launch admission",
		async (source) => {
			const manager = createManager();
			manager.attach("task-1", { onOutput: vi.fn() });
			await manager.startTaskSession(startRequest);
			const initial = manager.store.getSummary("task-1");
			if (!initial) throw new Error("Expected a task session.");
			manager.applyProviderHook(
				"task-1",
				createTestProviderHookRequest(initial, "to_in_progress", {
					hookEventName: "UserPromptSubmit",
					metadata: { sessionId: "provider-session-1" },
				}),
			);
			if (source === "terminal restore") {
				manager.stopTaskSession("task-1");
				manager.store.update("task-1", { state: "awaiting_review", reviewReason: "error" });
			}
			const rejectedLaunch = vi.fn(async () => {
				throw new Error("Folder unavailable. Locate the project folder to continue.");
			});
			manager.setLaunchOperationRunner(rejectedLaunch);
			if (source === "automatic crash restart") spawned[0]?.triggerExit(1);
			else manager.recoverStaleSession("task-1");

			await vi.waitFor(() => {
				expect(rejectedLaunch).toHaveBeenCalledOnce();
				expect(manager.store.getSummary("task-1")?.warningMessage).toContain("Folder unavailable");
			});
			expect(prepareAgentLaunchMock).toHaveBeenCalledOnce();
			expect(ptySessionSpawnMock).toHaveBeenCalledOnce();
			expect(manager.store.getSummary("task-1")).toMatchObject({ pid: null, resumeSessionId: "provider-session-1" });
		},
	);
});
