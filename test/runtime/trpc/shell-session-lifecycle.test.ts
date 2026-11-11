import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getRuntimeDetailTerminalTaskId,
	RUNTIME_HOME_TERMINAL_TASK_ID,
	type RuntimeBoardData,
	type RuntimeTaskSessionSummary,
	TaskResourceOperationCoordinator,
} from "../../../src/core";
import { handleStartShellSession } from "../../../src/trpc/handlers/start-shell-session";
import { handleStopTaskSession } from "../../../src/trpc/handlers/stop-task-session";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const mocks = vi.hoisted(() => ({
	loadProjectState: vi.fn(),
	resolveTaskWorkingDirectory: vi.fn(),
}));
vi.mock("../../../src/state/project-state.js", () => ({ loadProjectState: mocks.loadProjectState }));
vi.mock("../../../src/workdir/task-worktree.js", () => ({
	resolveTaskWorkingDirectory: mocks.resolveTaskWorkingDirectory,
}));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

const scope = { projectId: "project-1", projectPath: "/tmp/project-1" };
const shellTaskId = getRuntimeDetailTerminalTaskId("task-1");
const detailRequest = { taskId: shellTaskId, projectTaskId: "task-1", baseRef: "main" };
const homeRequest = { taskId: RUNTIME_HOME_TERMINAL_TASK_ID, baseRef: "main" };

function board(columnId: "review" | "trash" | null = "review"): RuntimeBoardData {
	return {
		columns: columnId
			? [
					{
						id: columnId,
						title: columnId,
						cards: [{ id: "task-1", title: "Task", prompt: "", baseRef: "main", createdAt: 1, updatedAt: 1 }],
					},
				]
			: [],
	};
}

function dependencies(taskResourceOperations = new TaskResourceOperationCoordinator()) {
	const manager = {
		store: { getSummary: vi.fn((): RuntimeTaskSessionSummary | null => null) },
		startShellSession: vi.fn(async ({ taskId }: { taskId: string }) =>
			createTestTaskSessionSummary({ taskId, agentId: null, state: "running", pid: 123 }),
		),
		stopTaskSessionAndWaitForExit: vi.fn(async () => ({
			summary: null,
			requestedSessionInstanceId: null,
			didExit: true,
			outcome: "exited" as const,
		})),
	};
	return {
		manager,
		taskResourceOperations,
		getScopedTerminalManager: vi.fn(async () => manager as never),
		resolveInteractiveShellCommand: () => ({ binary: "/bin/sh", args: [] }),
	};
}

beforeEach(() => {
	mocks.loadProjectState.mockReset().mockResolvedValue({ board: board() });
	mocks.resolveTaskWorkingDirectory.mockReset().mockResolvedValue("/tmp/task-workspace");
});

describe("manual shell resource admission", () => {
	it.each([
		{ taskId: "task-1", projectTaskId: "task-1", baseRef: "main" },
		{ taskId: shellTaskId, baseRef: "main" },
		{ taskId: getRuntimeDetailTerminalTaskId("other"), projectTaskId: "task-1", baseRef: "main" },
		{ ...homeRequest, projectTaskId: "task-1" },
	])("rejects mismatched shell/workspace identity: %j", async (input) => {
		const deps = dependencies();
		await expect(handleStartShellSession(scope, input, deps)).resolves.toMatchObject({ ok: false });
		expect(deps.getScopedTerminalManager).not.toHaveBeenCalled();
		expect(mocks.resolveTaskWorkingDirectory).not.toHaveBeenCalled();
	});

	it("reports a new shell, then an existing shell to a caller with no browser session history", async () => {
		const deps = dependencies();
		const retained = createTestTaskSessionSummary({
			taskId: RUNTIME_HOME_TERMINAL_TASK_ID,
			agentId: null,
			state: "running",
			pid: 123,
			sessionInstanceId: "retained-shell-instance",
		});
		deps.manager.startShellSession.mockImplementation(async () => {
			deps.manager.store.getSummary.mockReturnValue(retained);
			return retained;
		});
		await expect(handleStartShellSession(scope, homeRequest, deps)).resolves.toMatchObject({
			ok: true,
			hadExistingSession: false,
			summary: retained,
		});
		// A new viewer sends the same request without any browser-local session map.
		await expect(handleStartShellSession(scope, homeRequest, deps)).resolves.toMatchObject({
			ok: true,
			hadExistingSession: true,
			summary: retained,
		});
	});

	it("does not report an existing shell when the launch replaces the prior instance", async () => {
		const deps = dependencies();
		deps.manager.store.getSummary.mockReturnValue(
			createTestTaskSessionSummary({
				taskId: RUNTIME_HOME_TERMINAL_TASK_ID,
				agentId: null,
				state: "running",
				pid: 123,
				sessionInstanceId: "previous-instance",
			}),
		);
		deps.manager.startShellSession.mockResolvedValue(
			createTestTaskSessionSummary({
				taskId: RUNTIME_HOME_TERMINAL_TASK_ID,
				agentId: null,
				state: "running",
				pid: 456,
				sessionInstanceId: "replacement-instance",
			}),
		);
		await expect(handleStartShellSession(scope, homeRequest, deps)).resolves.toMatchObject({
			ok: true,
			hadExistingSession: false,
		});
	});

	it.each([null, undefined])(
		"does not infer a reused instance from a legacy summary without identity: %s",
		async (sessionInstanceId) => {
			const deps = dependencies();
			const legacy = createTestTaskSessionSummary({
				taskId: RUNTIME_HOME_TERMINAL_TASK_ID,
				agentId: null,
				state: "running",
				pid: 123,
				sessionInstanceId,
			});
			deps.manager.store.getSummary.mockReturnValue(legacy);
			deps.manager.startShellSession.mockResolvedValue(legacy);
			await expect(handleStartShellSession(scope, homeRequest, deps)).resolves.toMatchObject({
				ok: true,
				hadExistingSession: false,
			});
		},
	);

	it("does not report an existing shell for an unchanged stopped conditional result", async () => {
		const deps = dependencies();
		const stopped = createTestTaskSessionSummary({
			taskId: RUNTIME_HOME_TERMINAL_TASK_ID,
			agentId: null,
			state: "awaiting_review",
			pid: null,
			reviewReason: "interrupted",
			sessionInstanceId: "stopped-instance",
		});
		deps.manager.store.getSummary.mockReturnValue(stopped);
		deps.manager.startShellSession.mockResolvedValue(stopped);
		await expect(
			handleStartShellSession(
				scope,
				{
					...homeRequest,
					expectedExitedSessionInstanceId: "stopped-instance",
				},
				deps,
			),
		).resolves.toMatchObject({ ok: true, hadExistingSession: false, summary: stopped });
	});

	it("serializes home starts from independent clients", async () => {
		const deps = dependencies();
		const starting = deferred();
		const release = deferred();
		deps.manager.startShellSession.mockImplementationOnce(async ({ taskId }) => {
			starting.resolve();
			await release.promise;
			return createTestTaskSessionSummary({ taskId, agentId: null, pid: 123 });
		});
		const first = handleStartShellSession(scope, homeRequest, deps);
		await starting.promise;
		const second = handleStartShellSession(scope, homeRequest, deps);
		await Promise.resolve();
		expect(deps.manager.startShellSession).toHaveBeenCalledTimes(1);
		release.resolve();
		await expect(first).resolves.toMatchObject({ ok: true });
		await expect(second).resolves.toMatchObject({ ok: true });
	});

	it("does not serialize shells belonging to different projects", async () => {
		const deps = dependencies();
		const starting = deferred();
		const release = deferred();
		deps.manager.startShellSession.mockImplementationOnce(async ({ taskId }) => {
			starting.resolve();
			await release.promise;
			return createTestTaskSessionSummary({ taskId, agentId: null, pid: 123 });
		});
		const first = handleStartShellSession(scope, homeRequest, deps);
		await starting.promise;
		await expect(
			handleStartShellSession({ projectId: "project-2", projectPath: "/tmp/project-2" }, homeRequest, deps),
		).resolves.toMatchObject({ ok: true });
		release.resolve();
		await first;
	});

	it("serializes detail-shell stop with its owning task's complete start", async () => {
		const deps = dependencies();
		const preparing = deferred();
		const release = deferred();
		mocks.resolveTaskWorkingDirectory.mockImplementationOnce(async () => {
			preparing.resolve();
			await release.promise;
			return "/tmp/task-workspace";
		});
		const starting = handleStartShellSession(scope, detailRequest, deps);
		await preparing.promise;
		const stopping = handleStopTaskSession(scope, { taskId: shellTaskId, waitForExit: true }, deps);
		await Promise.resolve();
		expect(deps.manager.stopTaskSessionAndWaitForExit).not.toHaveBeenCalled();
		release.resolve();
		await expect(starting).resolves.toMatchObject({ ok: true });
		await expect(stopping).resolves.toMatchObject({ ok: true, didExit: true });
		expect(deps.manager.stopTaskSessionAndWaitForExit).toHaveBeenCalledWith(shellTaskId, 3_000, undefined);
	});

	it.each(["trash", null] as const)("rejects a queued start after task cleanup: %s", async (columnId) => {
		const deps = dependencies();
		const admitted = deferred();
		const release = deferred();
		const cleanup = deps.taskResourceOperations.run(scope.projectId, "task-1", async () => {
			admitted.resolve();
			await release.promise;
			mocks.loadProjectState.mockResolvedValue({ board: board(columnId) });
		});
		await admitted.promise;
		const starting = handleStartShellSession(scope, detailRequest, deps);
		await Promise.resolve();
		expect(mocks.loadProjectState).not.toHaveBeenCalled();
		release.resolve();
		await cleanup;
		await expect(starting).resolves.toMatchObject({
			ok: false,
			error: columnId === "trash" ? expect.stringContaining("Trash") : expect.stringContaining("no longer exists"),
		});
		expect(mocks.resolveTaskWorkingDirectory).not.toHaveBeenCalled();
		expect(deps.manager.startShellSession).not.toHaveBeenCalled();
	});

	it("preserves the exact exited-instance condition through API parsing and launch", async () => {
		const deps = dependencies();
		await expect(
			handleStartShellSession(
				scope,
				{
					...detailRequest,
					expectedExitedSessionInstanceId: "exited-shell-instance",
				},
				deps,
			),
		).resolves.toMatchObject({ ok: true });
		expect(deps.manager.startShellSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: shellTaskId,
				expectedExitedSessionInstanceId: "exited-shell-instance",
			}),
		);
	});

	it("does not launch when project admission rejects the scoped manager", async () => {
		const deps = dependencies();
		deps.getScopedTerminalManager.mockRejectedValueOnce(new Error("Project no longer exists."));
		await expect(handleStartShellSession(scope, homeRequest, deps)).resolves.toMatchObject({ ok: false });
		expect(deps.manager.startShellSession).not.toHaveBeenCalled();
	});
});
