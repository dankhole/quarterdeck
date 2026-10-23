import { describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest, RuntimeProjectStateResponse } from "../../../../src/core";
import { RuntimeSessionPersistence } from "../../../../src/server/runtime-session-persistence";
import { InMemorySessionSummaryStore, TerminalSessionManager } from "../../../../src/terminal";
import { createHooksApi } from "../../../../src/trpc";
import { createBoard } from "../../../utilities/board-factory";
import { createTestTaskSessionSummary } from "../../../utilities/task-session-factory";

const TASK_ID = "task-1";
const SESSION_INSTANCE_ID = "codex-process-1";

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

/** Many-delivery harness with gated and failing writes, matching the registry's tracking on acquisition. */
function createGatedHarness() {
	const manager = new TerminalSessionManager(new InMemorySessionSummaryStore());
	manager.hydrateFromRecord({
		[TASK_ID]: createTestTaskSessionSummary({
			taskId: TASK_ID,
			agentId: "codex",
			sessionInstanceId: SESSION_INSTANCE_ID,
			state: "running",
			reviewReason: null,
			pid: 4321,
			lastProviderHookOccurredAt: 100,
		}),
	});
	const writeGates: Array<ReturnType<typeof createDeferred<void>>> = [];
	const writeFailures = { remaining: 0 };
	const reconcileRuntimeSessions = vi.fn(async () => {
		const gate = writeGates.shift();
		if (gate) await gate.promise;
		if (writeFailures.remaining > 0) {
			writeFailures.remaining -= 1;
			throw new Error("synthetic session write failure");
		}
		return createBoardCommandResult();
	});
	const persistence = new RuntimeSessionPersistence({
		projectRegistry: { getProjectPathById: () => "/tmp/repo" },
		boardCommands: { reconcileRuntimeSessions },
	});
	const api = createHooksApi({
		projects: { getProjectPathById: () => "/tmp/repo" },
		terminals: {
			getTerminalManagerForProject: () => manager,
			ensureTerminalManagerForProject: async () => {
				// Mirrors the registry's ready notification on every acquisition.
				persistence.trackTerminalManager("project-1", manager);
				return manager;
			},
		},
		persistSessionState: persistence.persistRuntimeSessions,
		awaitSessionStateDurable: persistence.awaitRuntimeSessionsDurable,
	});
	const request = (index: number, hookEventName = "PreToolUse"): RuntimeHookIngestRequest => ({
		taskId: TASK_ID,
		projectId: "project-1",
		event: "activity",
		metadata: {
			source: "codex",
			hookEventName,
			sessionInstanceId: SESSION_INSTANCE_ID,
			turnId: "turn-1",
			toolUseId: `tool-${index}`,
			toolName: "Bash",
		},
		delivery: {
			id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			occurredAt: 200 + index,
		},
	});
	const holdNextWrite = () => {
		const gate = createDeferred<void>();
		writeGates.push(gate);
		return gate;
	};
	return { manager, persistence, api, request, reconcileRuntimeSessions, holdNextWrite, writeFailures };
}

describe("createHooksApi — durability barrier under load", () => {
	it("acknowledges a duplicate delivery without another session write", async () => {
		const { persistence, api, request, reconcileRuntimeSessions } = createGatedHarness();
		try {
			await expect(api.ingest(request(1))).resolves.toEqual({ ok: true });
			const writesAfterOriginal = reconcileRuntimeSessions.mock.calls.length;
			expect(writesAfterOriginal).toBeGreaterThan(0);

			await expect(api.ingest(request(1))).resolves.toEqual({ ok: true });
			await expect(api.ingest(request(1))).resolves.toEqual({ ok: true });
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(writesAfterOriginal);
		} finally {
			await persistence.close();
		}
	});

	it("holds a duplicate acknowledgement until the original delivery is durable", async () => {
		const { persistence, api, request, reconcileRuntimeSessions, holdNextWrite } = createGatedHarness();
		try {
			// Let the tracking write triggered by hydration settle first.
			await persistence.persistRuntimeSessions("project-1");
			const writesBefore = reconcileRuntimeSessions.mock.calls.length;
			const gate = holdNextWrite();
			const original = api.ingest(request(1));
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(writesBefore + 1));

			let duplicateSettled = false;
			const duplicate = api.ingest(request(1)).then((response) => {
				duplicateSettled = true;
				return response;
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(duplicateSettled).toBe(false);

			gate.resolve();
			await expect(original).resolves.toEqual({ ok: true });
			await expect(duplicate).resolves.toEqual({ ok: true });
			expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(writesBefore + 1);
		} finally {
			await persistence.close();
		}
	});

	it("does not acknowledge a duplicate while the original delivery's write has failed", async () => {
		const { persistence, api, request, reconcileRuntimeSessions, writeFailures } = createGatedHarness();
		try {
			await persistence.persistRuntimeSessions("project-1");
			const writesBefore = reconcileRuntimeSessions.mock.calls.length;
			// The original is processed in memory (its delivery ID is now known) but
			// neither the barrier write nor its bounded retry becomes durable.
			writeFailures.remaining = 4;
			const original = await api.ingest(request(1));
			expect(original).toMatchObject({ ok: false });

			const failedDuplicate = await api.ingest(request(1));
			expect(failedDuplicate).toMatchObject({ ok: false });
			expect(reconcileRuntimeSessions.mock.calls.length - writesBefore).toBe(4);

			await expect(api.ingest(request(1))).resolves.toEqual({ ok: true });
			expect(reconcileRuntimeSessions.mock.calls.length - writesBefore).toBe(5);
			await expect(api.ingest(request(1))).resolves.toEqual({ ok: true });
			expect(reconcileRuntimeSessions.mock.calls.length - writesBefore).toBe(5);
		} finally {
			await persistence.close();
		}
	});

	it("waits for its own write when an ordering-rejected delivery still records a receipt", async () => {
		const { manager, persistence, api, request, reconcileRuntimeSessions, holdNextWrite } = createGatedHarness();
		try {
			await persistence.persistRuntimeSessions("project-1");
			const writesBefore = reconcileRuntimeSessions.mock.calls.length;
			vi.spyOn(manager, "evaluateHookEventOrder").mockReturnValueOnce({
				accepted: false,
				reason: "unrelated_tool_completion",
			});
			const gate = holdNextWrite();
			let settled = false;
			const response = api.ingest(request(1, "PostToolUse")).then((result) => {
				settled = true;
				return result;
			});
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(writesBefore + 1));
			expect(manager.store.getSummary(TASK_ID)?.recentProviderHookDeliveryIds).toHaveLength(1);
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(settled).toBe(false);

			gate.resolve();
			await expect(response).resolves.toEqual({ ok: true });
		} finally {
			await persistence.close();
		}
	});

	it("coalesces a concurrent burst of distinct hooks into at most two writes", async () => {
		const { manager, persistence, api, request, reconcileRuntimeSessions, holdNextWrite } = createGatedHarness();
		try {
			await persistence.persistRuntimeSessions("project-1");
			const writesBefore = reconcileRuntimeSessions.mock.calls.length;
			const gate = holdNextWrite();
			const first = api.ingest(request(1));
			await vi.waitFor(() => expect(reconcileRuntimeSessions).toHaveBeenCalledTimes(writesBefore + 1));
			const burst = Array.from({ length: 12 }, (_, index) => api.ingest(request(index + 2)));
			gate.resolve();

			await expect(Promise.all([first, ...burst])).resolves.toEqual(
				Array.from({ length: 13 }, () => ({ ok: true })),
			);
			expect(reconcileRuntimeSessions.mock.calls.length - writesBefore).toBeLessThanOrEqual(2);
			expect(manager.store.getSummary(TASK_ID)?.recentProviderHookDeliveryIds).toHaveLength(13);
		} finally {
			await persistence.close();
		}
	});
});
