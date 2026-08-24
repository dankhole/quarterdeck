import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
	type PendingTaskLifecycleOperation,
	useTaskLifecycleOperations,
} from "@/hooks/board/use-task-lifecycle-operations";
import type { RuntimeTaskLifecycleResult } from "@/runtime/types";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";

const executeTaskLifecycleMutateMock = vi.hoisted(() => vi.fn());
const getTaskLifecycleOperationQueryMock = vi.hoisted(() => vi.fn());
const getRuntimeTrpcClientProjectMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());
const resolveTaskStartGeometryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (projectId: string) => {
		getRuntimeTrpcClientProjectMock(projectId);
		return {
			runtime: {
				executeTaskLifecycle: { mutate: executeTaskLifecycleMutateMock },
				getTaskLifecycleOperation: { query: getTaskLifecycleOperationQueryMock },
			},
		};
	},
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
}));

vi.mock("@/hooks/board/task-session-geometry", () => ({
	resolveTaskStartGeometry: resolveTaskStartGeometryMock,
}));

interface HookSnapshot {
	executeTaskLifecycle: ReturnType<typeof useTaskLifecycleOperations>["executeTaskLifecycle"];
	pendingTaskLifecycleById: Record<string, PendingTaskLifecycleOperation>;
}

function HookHarness({
	currentProjectId = "project-1",
	flushBoardCommands,
	getAuthoritativeRevision,
	applyLifecycleProjectState,
	refreshProjectState,
	onSnapshot,
}: {
	currentProjectId?: string | null;
	flushBoardCommands: () => Promise<{ ok: boolean; message?: string }>;
	getAuthoritativeRevision: () => number | null;
	applyLifecycleProjectState: (state: ReturnType<typeof createTestProjectStateResponse>) => void;
	refreshProjectState: () => Promise<void>;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const result = useTaskLifecycleOperations({
		currentProjectId,
		flushBoardCommands,
		getAuthoritativeRevision,
		applyLifecycleProjectState,
		refreshProjectState,
	});
	useEffect(() => onSnapshot(result), [onSnapshot, result]);
	return null;
}

function createResult(overrides: Partial<RuntimeTaskLifecycleResult> = {}): RuntimeTaskLifecycleResult {
	const state = createTestProjectStateResponse({ revision: 8 });
	return {
		ok: true,
		operation: {
			operationId: "server-operation",
			projectId: "project-1",
			taskId: "task-1",
			taskCreatedAt: 1,
			kind: "start",
			status: "completed",
			phase: "finished",
			sourceColumnId: "backlog",
			targetColumnId: "in_progress",
			acceptedBoardRevision: 8,
			launchOperationId: "server-operation",
			childOperationIds: [],
			outcomeCode: "completed",
			requestedAt: 10,
			updatedAt: 11,
			completedAt: 11,
		},
		state,
		summary: null,
		...overrides,
	};
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	let rejectPromise: ((error: unknown) => void) | undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	if (!resolvePromise || !rejectPromise) {
		throw new Error("Deferred promise was not initialized.");
	}
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("useTaskLifecycleOperations", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let latestSnapshot: HookSnapshot | null;
	let flushBoardCommands: Mock<() => Promise<{ ok: boolean; message?: string }>>;
	let getAuthoritativeRevision: Mock<() => number | null>;
	let applyLifecycleProjectState: Mock<(state: ReturnType<typeof createTestProjectStateResponse>) => void>;
	let refreshProjectState: Mock<() => Promise<void>>;

	beforeEach(async () => {
		executeTaskLifecycleMutateMock.mockReset();
		getTaskLifecycleOperationQueryMock.mockReset();
		getRuntimeTrpcClientProjectMock.mockReset();
		notifyErrorMock.mockReset();
		showAppToastMock.mockReset();
		resolveTaskStartGeometryMock.mockReset();
		resolveTaskStartGeometryMock.mockResolvedValue({ cols: 132, rows: 38 });
		flushBoardCommands = vi.fn(async () => ({ ok: true }));
		getAuthoritativeRevision = vi.fn(() => 7);
		applyLifecycleProjectState = vi.fn();
		refreshProjectState = vi.fn(async () => {});
		latestSnapshot = null;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				<HookHarness
					flushBoardCommands={flushBoardCommands}
					getAuthoritativeRevision={getAuthoritativeRevision}
					applyLifecycleProjectState={applyLifecycleProjectState}
					refreshProjectState={refreshProjectState}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("flushes first, sends one revisioned command, and applies the authoritative result", async () => {
		const deferred = createDeferred<RuntimeTaskLifecycleResult>();
		executeTaskLifecycleMutateMock.mockReturnValue(deferred.promise);
		let resultPromise: Promise<RuntimeTaskLifecycleResult | null> | null = null;
		await act(async () => {
			resultPromise = requireSnapshot(latestSnapshot).executeTaskLifecycle({
				kind: "start",
				taskId: "task-1",
				taskCreatedAt: 1,
			});
			await Promise.resolve();
		});

		expect(flushBoardCommands).toHaveBeenCalledOnce();
		expect(executeTaskLifecycleMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "start",
				taskId: "task-1",
				taskCreatedAt: 1,
				expectedRevision: 7,
				cols: 132,
				rows: 38,
				operationId: expect.stringMatching(/^lifecycle:start:/),
			}),
		);
		expect(requireSnapshot(latestSnapshot).pendingTaskLifecycleById["task-1"]?.label).toBe("Starting agent");

		const response = createResult();
		await act(async () => {
			deferred.resolve(response);
			await resultPromise;
		});
		expect(applyLifecycleProjectState).toHaveBeenCalledWith(response.state);
		expect(requireSnapshot(latestSnapshot).pendingTaskLifecycleById).toEqual({});
		expect(notifyErrorMock).not.toHaveBeenCalled();
	});

	it("does not send a lifecycle operation when pending board commands fail to flush", async () => {
		flushBoardCommands.mockResolvedValue({ ok: false, message: "revision conflict" });
		await act(async () => {
			await requireSnapshot(latestSnapshot).executeTaskLifecycle({
				kind: "trash",
				taskId: "task-1",
				taskCreatedAt: 1,
				sourceColumnId: "review",
			});
		});

		expect(executeTaskLifecycleMutateMock).not.toHaveBeenCalled();
		expect(notifyErrorMock).toHaveBeenCalledWith("revision conflict");
	});

	it("retries an ambiguous response with the same operation ID then recovers by status", async () => {
		const recovered = createResult();
		executeTaskLifecycleMutateMock
			.mockRejectedValueOnce(new Error("connection closed"))
			.mockRejectedValueOnce(new Error("still disconnected"));
		getTaskLifecycleOperationQueryMock.mockResolvedValue(recovered);

		await act(async () => {
			await requireSnapshot(latestSnapshot).executeTaskLifecycle({
				kind: "restore",
				taskId: "task-1",
				taskCreatedAt: 1,
			});
		});

		expect(executeTaskLifecycleMutateMock).toHaveBeenCalledTimes(2);
		expect(executeTaskLifecycleMutateMock.mock.calls[0]?.[0]).toEqual(
			executeTaskLifecycleMutateMock.mock.calls[1]?.[0],
		);
		const operationId = executeTaskLifecycleMutateMock.mock.calls[0]?.[0].operationId;
		expect(getTaskLifecycleOperationQueryMock).toHaveBeenCalledWith({ operationId });
		expect(applyLifecycleProjectState).toHaveBeenCalledWith(recovered.state);
		expect(notifyErrorMock).not.toHaveBeenCalled();
	});

	it("hydrates authoritative failure state and shows one typed error", async () => {
		const failed = createResult({
			ok: false,
			error: "Task session did not exit before the timeout.",
			operation: {
				...createResult().operation,
				status: "failed",
				outcomeCode: "stop_timed_out",
			},
		});
		executeTaskLifecycleMutateMock.mockResolvedValue(failed);

		await act(async () => {
			await requireSnapshot(latestSnapshot).executeTaskLifecycle({
				kind: "delete",
				taskId: "task-1",
				taskCreatedAt: 1,
			});
		});

		expect(applyLifecycleProjectState).toHaveBeenCalledWith(failed.state);
		expect(notifyErrorMock).toHaveBeenCalledOnce();
		expect(notifyErrorMock).toHaveBeenCalledWith(
			"The agent did not stop in time. No workspace cleanup was performed.",
		);
	});

	it("refreshes authoritative state when neither the response nor operation status can be recovered", async () => {
		executeTaskLifecycleMutateMock.mockRejectedValue(new Error("connection closed"));
		getTaskLifecycleOperationQueryMock.mockResolvedValue(null);

		await act(async () => {
			await requireSnapshot(latestSnapshot).executeTaskLifecycle({
				kind: "restore",
				taskId: "task-1",
				taskCreatedAt: 1,
			});
		});

		expect(refreshProjectState).toHaveBeenCalledOnce();
		expect(applyLifecycleProjectState).not.toHaveBeenCalled();
		expect(notifyErrorMock).toHaveBeenCalledWith("Could not confirm the task action: connection closed");
	});

	it("coalesces duplicate gestures for one task while the first operation is pending", async () => {
		const deferred = createDeferred<RuntimeTaskLifecycleResult>();
		executeTaskLifecycleMutateMock.mockReturnValue(deferred.promise);
		const draft = { kind: "start" as const, taskId: "task-1", taskCreatedAt: 1 };
		let first: Promise<RuntimeTaskLifecycleResult | null> | null = null;
		let duplicate: Promise<RuntimeTaskLifecycleResult | null> | null = null;
		await act(async () => {
			first = requireSnapshot(latestSnapshot).executeTaskLifecycle(draft);
			duplicate = requireSnapshot(latestSnapshot).executeTaskLifecycle(draft);
			await Promise.resolve();
		});
		deferred.resolve(createResult());
		let results: Array<RuntimeTaskLifecycleResult | null> = [];
		await act(async () => {
			results = await Promise.all([first, duplicate]);
		});

		expect(results[0]).toEqual(results[1]);
		expect(flushBoardCommands).toHaveBeenCalledOnce();
		expect(executeTaskLifecycleMutateMock).toHaveBeenCalledOnce();
	});

	it("keeps same-id lifecycle operations isolated across project switches", async () => {
		const firstDeferred = createDeferred<RuntimeTaskLifecycleResult>();
		const secondDeferred = createDeferred<RuntimeTaskLifecycleResult>();
		executeTaskLifecycleMutateMock
			.mockReturnValueOnce(firstDeferred.promise)
			.mockReturnValueOnce(secondDeferred.promise);
		const draft = { kind: "start" as const, taskId: "shared-task", taskCreatedAt: 1 };
		let first: Promise<RuntimeTaskLifecycleResult | null> | null = null;
		let second: Promise<RuntimeTaskLifecycleResult | null> | null = null;

		await act(async () => {
			first = requireSnapshot(latestSnapshot).executeTaskLifecycle(draft);
			await Promise.resolve();
		});
		expect(requireSnapshot(latestSnapshot).pendingTaskLifecycleById["shared-task"]).toBeDefined();

		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId="project-2"
					flushBoardCommands={flushBoardCommands}
					getAuthoritativeRevision={getAuthoritativeRevision}
					applyLifecycleProjectState={applyLifecycleProjectState}
					refreshProjectState={refreshProjectState}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		expect(requireSnapshot(latestSnapshot).pendingTaskLifecycleById).toEqual({});

		await act(async () => {
			second = requireSnapshot(latestSnapshot).executeTaskLifecycle(draft);
			await Promise.resolve();
		});
		expect(getRuntimeTrpcClientProjectMock.mock.calls.map(([projectId]) => projectId)).toEqual([
			"project-1",
			"project-2",
		]);
		expect(executeTaskLifecycleMutateMock).toHaveBeenCalledTimes(2);
		expect(requireSnapshot(latestSnapshot).pendingTaskLifecycleById["shared-task"]).toBeDefined();

		await act(async () => {
			firstDeferred.resolve(createResult());
			await first;
		});
		expect(requireSnapshot(latestSnapshot).pendingTaskLifecycleById["shared-task"]).toBeDefined();

		await act(async () => {
			secondDeferred.resolve(
				createResult({
					operation: { ...createResult().operation, projectId: "project-2", taskId: "shared-task" },
				}),
			);
			await second;
		});
		expect(requireSnapshot(latestSnapshot).pendingTaskLifecycleById).toEqual({});
	});
});

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}
