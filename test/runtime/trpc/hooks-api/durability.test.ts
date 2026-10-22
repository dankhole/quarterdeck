import { describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest, RuntimeProjectStateResponse } from "../../../../src/core";
import { RuntimeSessionPersistence } from "../../../../src/server/runtime-session-persistence";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../../src/terminal";
import { createHooksApi } from "../../../../src/trpc";
import { createBoard } from "../../../utilities/board-factory";
import { createTestTaskSessionSummary } from "../../../utilities/task-session-factory";

type BoardCommandResult = {
	state: RuntimeProjectStateResponse;
	changed: boolean;
	acceptedChange: boolean;
	replayed: boolean;
};

function createBoardCommandResult(): BoardCommandResult {
	return {
		state: {
			repoPath: "/repo",
			statePath: "/state",
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			board: createBoard("Task"),
			sessions: {},
			revision: 1,
		},
		changed: false,
		acceptedChange: false,
		replayed: false,
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function createHarness() {
	const taskId = "task-1";
	const sessionInstanceId = "codex-process-1";
	const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
	manager.hydrateFromRecord({
		[taskId]: createTestTaskSessionSummary({
			taskId,
			agentId: "codex",
			sessionInstanceId,
			state: "running",
			pid: 4321,
			startedAt: 100,
			lastProviderHookOccurredAt: 100,
			sessionLaunchPath: "/repo",
		}),
	});
	const reconcileRuntimeSessions = vi.fn(async () => createBoardCommandResult());
	const persistence = new RuntimeSessionPersistence({
		projectRegistry: { getProjectPathById: () => "/repo" },
		boardCommands: { reconcileRuntimeSessions },
	});
	persistence.trackTerminalManager("project-1", manager);
	// Settle the hydration write so each test counts only hook-driven writes.
	await persistence.persistRuntimeSessions("project-1");
	reconcileRuntimeSessions.mockClear();
	const api = createHooksApi({
		runProjectOperation: async (_scope, operation) => await operation(),
		projects: { getProjectPathById: () => "/repo" },
		terminals: {
			getTerminalManagerForProject: () => manager,
			ensureTerminalManagerForProject: async () => manager,
		},
		persistSessionState: persistence.persistRuntimeSessions,
		awaitSessionStateDurable: persistence.awaitRuntimeSessionsDurable,
	});
	const stopHook: RuntimeHookIngestRequest = {
		taskId,
		projectId: "project-1",
		event: "to_review",
		metadata: { source: "codex", hookEventName: "Stop", sessionInstanceId, turnId: "turn-1" },
		delivery: { id: "00000000-0000-4000-8000-000000000001", occurredAt: 200 },
	};
	return { api, manager, persistence, reconcileRuntimeSessions, stopHook, taskId };
}

describe("createHooksApi — acknowledgement durability", () => {
	it("acknowledges a duplicate delivery after the first attempt's write, without forcing another", async () => {
		const { api, manager, persistence, reconcileRuntimeSessions, stopHook, taskId } = await createHarness();
		const firstWrite = createDeferred<BoardCommandResult>();
		reconcileRuntimeSessions.mockImplementationOnce(async () => await firstWrite.promise);
		try {
			const settled: string[] = [];
			const firstAttempt = api.ingest(stopHook).then((result) => {
				settled.push("first");
				return result;
			});
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledOnce());
			expect(manager.store.getSummary(taskId)?.state).toBe("awaiting_review");

			// A client retry or outbox replay of the same delivery while the first
			// attempt's state is still being written.
			const retry = api.ingest(stopHook).then((result) => {
				settled.push("retry");
				return result;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toEqual([]);

			firstWrite.resolve(createBoardCommandResult());
			await expect(firstAttempt).resolves.toEqual({ ok: true });
			await expect(retry).resolves.toEqual({ ok: true });
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();

			// A late replay after durability is acknowledged without any write.
			await expect(api.ingest(stopHook)).resolves.toEqual({ ok: true });
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			firstWrite.resolve(createBoardCommandResult());
			await persistence.close();
		}
	});

	it("does not acknowledge a duplicate while the first attempt's state is not durable", async () => {
		const { api, persistence, reconcileRuntimeSessions, stopHook } = await createHarness();
		try {
			reconcileRuntimeSessions.mockRejectedValue(new Error("disk full"));
			await expect(api.ingest(stopHook)).resolves.toEqual({ ok: false, error: "disk full" });
			await expect(api.ingest(stopHook)).resolves.toEqual({ ok: false, error: "disk full" });

			reconcileRuntimeSessions.mockResolvedValue(createBoardCommandResult());
			await expect(api.ingest(stopHook)).resolves.toEqual({ ok: true });
		} finally {
			reconcileRuntimeSessions.mockResolvedValue(createBoardCommandResult());
			await persistence.close();
		}
	});

	it("acknowledges a hook that changes no session state without writing", async () => {
		const { api, persistence, reconcileRuntimeSessions, stopHook } = await createHarness();
		try {
			await expect(
				api.ingest({
					...stopHook,
					metadata: { ...stopHook.metadata, sessionInstanceId: "superseded-process" },
					delivery: { id: "00000000-0000-4000-8000-000000000002", occurredAt: 300 },
				}),
			).resolves.toEqual({ ok: true });
			expect(reconcileRuntimeSessions).not.toHaveBeenCalled();

			await expect(api.ingest(stopHook)).resolves.toEqual({ ok: true });
			expect(reconcileRuntimeSessions).toHaveBeenCalledOnce();
		} finally {
			await persistence.close();
		}
	});
});
