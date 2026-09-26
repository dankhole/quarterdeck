import { describe, expect, it, vi } from "vitest";

import type { RuntimeProjectStateResponse } from "../../../src/core";
import { RuntimeSessionPersistence } from "../../../src/server/runtime-session-persistence";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../src/terminal";
import { createBoard } from "../../utilities/board-factory";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] | null = null;
	let reject: Deferred<T>["reject"] | null = null;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	if (!resolve || !reject) {
		throw new Error("Failed to create deferred promise.");
	}
	return { promise, resolve, reject };
}

function createProjectStateResponse(): RuntimeProjectStateResponse {
	return {
		repoPath: "/repo",
		statePath: "/state",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: createBoard("Task"),
		sessions: {},
		revision: 1,
	};
}

function createBoardCommandResult() {
	return {
		state: createProjectStateResponse(),
		changed: false,
		acceptedChange: false,
		replayed: false,
	};
}

function createDependencies() {
	return {
		projectRegistry: {
			getProjectPathById: (projectId: string) => (projectId === "project-1" ? "/repo" : null),
		},
		boardCommands: {
			reconcileRuntimeSessions: vi.fn(async () => createBoardCommandResult()),
		},
	};
}

describe("RuntimeSessionPersistence", () => {
	it("persists terminal-store changes through the runtime board authority without a browser client", async () => {
		vi.useFakeTimers();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({
				taskId: "task-1",
				state: "running",
				sessionLaunchPath: "/repo",
			}),
		});
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
			expect(reconcileRuntimeSessions).toHaveBeenLastCalledWith({
				projectId: "project-1",
				projectPath: "/repo",
			});

			store.update("task-1", { warningMessage: "Needs attention" });
			await vi.advanceTimersByTimeAsync(100);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);

			await persistence.disposeProject("project-1");
			store.update("task-1", { warningMessage: "No longer tracked" });
			await vi.advanceTimersByTimeAsync(200);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
		} finally {
			await persistence.close();
			vi.useRealTimers();
		}
	});

	it("retries failed session persistence and converges a generation dirtied during an in-flight write", async () => {
		vi.useFakeTimers();
		const firstAttempt = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions
			.mockImplementationOnce(async () => await firstAttempt.promise)
			.mockRejectedValueOnce(new Error("transient persistence failure"))
			.mockResolvedValue(createBoardCommandResult());
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(1);

			store.update("task-1", { warningMessage: "newest generation" });
			firstAttempt.resolve(createBoardCommandResult());
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(250);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(3);
		} finally {
			await persistence.close();
			vi.useRealTimers();
		}
	});

	it("waits for an in-flight session writer before project disposal completes", async () => {
		vi.useFakeTimers();
		const inFlightWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions.mockImplementationOnce(async () => await inFlightWrite.promise);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
			let disposed = false;
			const disposal = persistence.disposeProject("project-1").then(() => {
				disposed = true;
			});
			await Promise.resolve();
			expect(disposed).toBe(false);

			store.update("task-1", { warningMessage: "must not schedule after disposal" });
			inFlightWrite.resolve(createBoardCommandResult());
			await disposal;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			await persistence.close();
			vi.useRealTimers();
		}
	});

	it("serializes concurrent explicit flushes without rejecting a hook acknowledgement", async () => {
		vi.useFakeTimers();
		const firstWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const secondWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions
			.mockImplementationOnce(async () => await firstWrite.promise)
			.mockImplementationOnce(async () => await secondWrite.promise)
			.mockResolvedValue(createBoardCommandResult());
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			const firstFlush = persistence.persistRuntimeSessions("project-1");
			await Promise.resolve();
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();

			store.update("task-1", { warningMessage: "concurrent hook generation" });
			const secondFlush = persistence.persistRuntimeSessions("project-1");
			firstWrite.resolve(createBoardCommandResult());
			await firstFlush;
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2));

			let secondSettled = false;
			void secondFlush.finally(() => {
				secondSettled = true;
			});
			await Promise.resolve();
			expect(secondSettled).toBe(false);

			secondWrite.resolve(createBoardCommandResult());
			await expect(secondFlush).resolves.toBeUndefined();
		} finally {
			firstWrite.resolve(createBoardCommandResult());
			secondWrite.resolve(createBoardCommandResult());
			await persistence.close();
			vi.useRealTimers();
		}
	});

	it("keeps a late explicit persistence barrier durable while shutdown detaches store listeners", async () => {
		const firstWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const secondWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions
			.mockImplementationOnce(async () => await firstWrite.promise)
			.mockImplementationOnce(async () => await secondWrite.promise)
			.mockResolvedValue(createBoardCommandResult());
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		const firstFlush = persistence.persistRuntimeSessions("project-1");
		await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledOnce());
		const closing = persistence.close();
		store.update("task-1", { warningMessage: "late shutdown hook transition" });
		const lateFlush = persistence.persistRuntimeSessions("project-1");

		firstWrite.resolve(createBoardCommandResult());
		await firstFlush;
		await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2));
		let lateFlushSettled = false;
		void lateFlush.finally(() => {
			lateFlushSettled = true;
		});
		await Promise.resolve();
		expect(lateFlushSettled).toBe(false);

		secondWrite.resolve(createBoardCommandResult());
		await expect(lateFlush).resolves.toBeUndefined();
		await expect(closing).resolves.toBeUndefined();
		await expect(persistence.persistRuntimeSessions("project-1")).rejects.toThrow("persistence is closed");
		expect(() => persistence.trackTerminalManager("project-1", new TerminalSessionManager(store))).toThrow(
			"persistence is closed",
		);
	});

	it("gives a re-added project a fresh writer while its disposed writer drains", async () => {
		vi.useFakeTimers();
		const firstWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = dependencies.boardCommands.reconcileRuntimeSessions;
		reconcileRuntimeSessions.mockImplementationOnce(async () => await firstWrite.promise);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const oldStore = new InMemorySessionSummaryStore();
		oldStore.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });
		const newStore = new InMemorySessionSummaryStore();
		newStore.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });

		try {
			persistence.trackTerminalManager("project-1", new TerminalSessionManager(oldStore));
			await vi.advanceTimersByTimeAsync(1);
			const disposal = persistence.disposeProject("project-1");
			persistence.trackTerminalManager("project-1", new TerminalSessionManager(newStore));
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);

			firstWrite.resolve(createBoardCommandResult());
			await disposal;
			oldStore.update("task-1", { warningMessage: "retired manager" });
			await vi.advanceTimersByTimeAsync(100);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);

			newStore.update("task-1", { warningMessage: "current manager" });
			await vi.advanceTimersByTimeAsync(100);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(3);
		} finally {
			firstWrite.resolve(createBoardCommandResult());
			await persistence.close();
			vi.useRealTimers();
		}
	});

	it("retries a failed final session flush before completing shutdown", async () => {
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions
			.mockRejectedValueOnce(new Error("transient final persistence failure"))
			.mockResolvedValue(createBoardCommandResult());
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		await expect(persistence.close()).resolves.toBeUndefined();
		expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
	});

	it("finishes persistence cleanup but rejects shutdown when the newest session generation cannot persist", async () => {
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions.mockRejectedValue(new Error("persistent final persistence failure"));
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		await expect(persistence.close()).rejects.toThrow("Runtime session persistence did not finish during shutdown");
		expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
	});
});
