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
	it("terminally fences late barriers while draining an already-admitted automatic writer", async () => {
		vi.useFakeTimers();
		const writing = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		dependencies.boardCommands.reconcileRuntimeSessions.mockImplementationOnce(async () => await writing.promise);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));
		try {
			await vi.advanceTimersByTimeAsync(1);
			let settled = false;
			const closing = persistence.stopForShutdown().then(() => {
				settled = true;
			});
			await expect(persistence.persistRuntimeSessions("project-1")).rejects.toThrow("persistence is closed");
			await expect(persistence.awaitRuntimeSessionsDurable("project-1")).rejects.toThrow("persistence is closed");
			store.update("task-1", { warningMessage: "late producer" });
			expect(settled).toBe(false);
			writing.resolve(createBoardCommandResult());
			await closing;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(dependencies.boardCommands.reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			writing.resolve(createBoardCommandResult());
			await persistence.close({ skipPersistence: true });
			vi.useRealTimers();
		}
	});

	it("discards dirty queued projections after ownership loss while draining a started write", async () => {
		vi.useFakeTimers();
		const writing = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		dependencies.boardCommands.reconcileRuntimeSessions.mockImplementationOnce(async () => await writing.promise);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));
		try {
			await vi.advanceTimersByTimeAsync(1);
			store.update("task-1", { warningMessage: "pending projection" });
			let settled = false;
			const closing = persistence.close({ skipPersistence: true }).then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			await expect(persistence.persistRuntimeSessions("project-1")).rejects.toThrow("persistence is closed");
			writing.resolve(createBoardCommandResult());
			await closing;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(dependencies.boardCommands.reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			writing.resolve(createBoardCommandResult());
			await persistence.close({ skipPersistence: true });
			vi.useRealTimers();
		}
	});

	it("does not schedule a write for presentation-only progress updates", async () => {
		vi.useFakeTimers();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running" }) });
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));
		try {
			await vi.advanceTimersByTimeAsync(1_000);
			reconcileRuntimeSessions.mockClear();
			for (let tick = 0; tick < 5; tick += 1) {
				store.updatePresentation("task-1", { progressMessage: `step ${tick}` });
				await vi.advanceTimersByTimeAsync(1_000);
			}
			expect(reconcileRuntimeSessions).not.toHaveBeenCalled();

			store.update("task-1", { warningMessage: "durable change" });
			await vi.advanceTimersByTimeAsync(1_000);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			await persistence.close({ skipPersistence: true });
			vi.useRealTimers();
		}
	});

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

	it("re-arms the automatic writer for a change made during a barrier-driven write", async () => {
		const write = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions.mockImplementationOnce(async () => await write.promise);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			const barrier = persistence.persistRuntimeSessions("project-1");
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledOnce());
			store.update("task-1", { warningMessage: "changed during barrier write" });
			write.resolve(createBoardCommandResult());
			await barrier;

			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2));
		} finally {
			write.resolve(createBoardCommandResult());
			await persistence.close();
		}
	});

	it("coalesces a burst of hook barriers into at most two writes", async () => {
		const firstWrite = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		reconcileRuntimeSessions.mockImplementationOnce(async () => await firstWrite.promise);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			const barriers = [persistence.persistRuntimeSessions("project-1")];
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledOnce());
			for (let index = 0; index < 20; index += 1) {
				store.update("task-1", { warningMessage: `burst ${index}` });
				barriers.push(persistence.persistRuntimeSessions("project-1"));
			}
			firstWrite.resolve(createBoardCommandResult());
			await Promise.all(barriers);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
		} finally {
			firstWrite.resolve(createBoardCommandResult());
			await persistence.close();
		}
	});

	it("forces a fresh generation for a barrier after the store listener is detached", async () => {
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));

		try {
			await persistence.persistRuntimeSessions("project-1");
			await persistence.disposeProject("project-1");
			store.update("task-1", { warningMessage: "unobserved change" });
			await persistence.persistRuntimeSessions("project-1");
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
		} finally {
			await persistence.close();
		}
	});

	it("follows a replacement terminal manager for the same project", async () => {
		vi.useFakeTimers();
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const retiredStore = new InMemorySessionSummaryStore();
		retiredStore.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });
		const currentStore = new InMemorySessionSummaryStore();
		currentStore.hydrateFromRecord({ "task-1": createTestTaskSessionSummary({ taskId: "task-1" }) });
		const retiredManager = new TerminalSessionManager(retiredStore);

		try {
			persistence.trackTerminalManager("project-1", retiredManager);
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
			persistence.trackTerminalManager("project-1", retiredManager);
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();

			persistence.trackTerminalManager("project-1", new TerminalSessionManager(currentStore));
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);

			retiredStore.update("task-1", { warningMessage: "retired manager" });
			await vi.advanceTimersByTimeAsync(200);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);

			currentStore.update("task-1", { warningMessage: "current manager" });
			const barrier = persistence.persistRuntimeSessions("project-1");
			await vi.advanceTimersByTimeAsync(1);
			await barrier;
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(3);
		} finally {
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

describe("RuntimeSessionPersistence durability barrier without a new change", () => {
	function createTrackedPersistence() {
		const dependencies = createDependencies();
		const reconcileRuntimeSessions = vi.mocked(dependencies.boardCommands.reconcileRuntimeSessions);
		const persistence = new RuntimeSessionPersistence(dependencies);
		const store = new InMemorySessionSummaryStore();
		store.hydrateFromRecord({
			"task-1": createTestTaskSessionSummary({ taskId: "task-1", state: "running", sessionLaunchPath: "/repo" }),
		});
		persistence.trackTerminalManager("project-1", new TerminalSessionManager(store));
		return { persistence, store, reconcileRuntimeSessions };
	}

	it("acknowledges without writing when every store change is already durable", async () => {
		const { persistence, reconcileRuntimeSessions } = createTrackedPersistence();
		try {
			await persistence.persistRuntimeSessions("project-1");
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();

			await expect(persistence.awaitRuntimeSessionsDurable("project-1")).resolves.toBeUndefined();
			await expect(persistence.awaitRuntimeSessionsDurable("project-1")).resolves.toBeUndefined();
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			await persistence.close();
		}
	});

	it("waits for an in-flight write that covers earlier changes without starting another", async () => {
		const { persistence, store, reconcileRuntimeSessions } = createTrackedPersistence();
		const write = createDeferred<ReturnType<typeof createBoardCommandResult>>();
		try {
			await persistence.persistRuntimeSessions("project-1");
			reconcileRuntimeSessions.mockImplementationOnce(async () => await write.promise);
			store.update("task-1", { warningMessage: "first delivery" });
			const firstDelivery = persistence.persistRuntimeSessions("project-1");
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2));

			let duplicateSettled = false;
			const duplicateDelivery = persistence.awaitRuntimeSessionsDurable("project-1").finally(() => {
				duplicateSettled = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(duplicateSettled).toBe(false);

			write.resolve(createBoardCommandResult());
			await expect(firstDelivery).resolves.toBeUndefined();
			await expect(duplicateDelivery).resolves.toBeUndefined();
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
		} finally {
			write.resolve(createBoardCommandResult());
			await persistence.close();
		}
	});

	it("flushes a debounced store change immediately instead of acknowledging it early", async () => {
		vi.useFakeTimers();
		const { persistence, store, reconcileRuntimeSessions } = createTrackedPersistence();
		try {
			await vi.advanceTimersByTimeAsync(1);
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
			store.update("task-1", { warningMessage: "debounced change" });

			await persistence.awaitRuntimeSessionsDurable("project-1");
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(2);
		} finally {
			await persistence.close();
			vi.useRealTimers();
		}
	});

	it("keeps rejecting until a failed earlier generation becomes durable", async () => {
		const { persistence, store, reconcileRuntimeSessions } = createTrackedPersistence();
		try {
			await persistence.persistRuntimeSessions("project-1");
			reconcileRuntimeSessions
				.mockRejectedValueOnce(new Error("disk full"))
				.mockRejectedValueOnce(new Error("disk full"));
			store.update("task-1", { warningMessage: "first delivery" });
			await expect(persistence.persistRuntimeSessions("project-1")).rejects.toThrow("disk full");

			reconcileRuntimeSessions
				.mockRejectedValueOnce(new Error("disk full"))
				.mockRejectedValueOnce(new Error("disk full"));
			await expect(persistence.awaitRuntimeSessionsDurable("project-1")).rejects.toThrow("disk full");

			await expect(persistence.awaitRuntimeSessionsDurable("project-1")).resolves.toBeUndefined();
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(6);
		} finally {
			await persistence.close();
		}
	});

	it("falls back to a forced write when the project has no live writer", async () => {
		const dependencies = createDependencies();
		const persistence = new RuntimeSessionPersistence(dependencies);
		try {
			await persistence.awaitRuntimeSessionsDurable("project-1");
			expect(dependencies.boardCommands.reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			await persistence.close();
		}
		await expect(persistence.awaitRuntimeSessionsDurable("project-1")).rejects.toThrow("persistence is closed");
	});
});
