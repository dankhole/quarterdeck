import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskSessions } from "@/hooks/board/use-task-sessions";
import type { BoardCard } from "@/types";

const startTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const stopTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const deleteWorktreeMutateMock = vi.hoisted(() => vi.fn());
const resolveTaskStartGeometryMock = vi.hoisted(() => vi.fn());
const flushBoardCommandsMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			deleteWorktree: {
				mutate: deleteWorktreeMutateMock,
			},
		},
		runtime: {
			startTaskSession: {
				mutate: startTaskSessionMutateMock,
			},
			stopTaskSession: {
				mutate: stopTaskSessionMutateMock,
			},
		},
	}),
}));

vi.mock("@/hooks/board/task-session-geometry", () => ({
	resolveTaskStartGeometry: resolveTaskStartGeometryMock,
}));

interface HookSnapshot {
	startTaskSession: ReturnType<typeof useTaskSessions>["startTaskSession"];
	stopTaskSession: ReturnType<typeof useTaskSessions>["stopTaskSession"];
	cleanupTaskWorktree: ReturnType<typeof useTaskSessions>["cleanupTaskWorktree"];
}

function createTask(): BoardCard {
	return {
		id: "task-1",
		title: null,
		prompt: "Resume me",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function HookHarness({ onSnapshot }: { onSnapshot: (snapshot: HookSnapshot) => void }): null {
	const sessions = useTaskSessions({
		currentProjectId: "project-1",
		setSessions: () => {},
		flushBoardCommands: flushBoardCommandsMock,
	});

	useEffect(() => {
		onSnapshot({
			startTaskSession: sessions.startTaskSession,
			stopTaskSession: sessions.stopTaskSession,
			cleanupTaskWorktree: sessions.cleanupTaskWorktree,
		});
	}, [onSnapshot, sessions.cleanupTaskWorktree, sessions.startTaskSession, sessions.stopTaskSession]);

	return null;
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

describe("useTaskSessions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		startTaskSessionMutateMock.mockReset();
		stopTaskSessionMutateMock.mockReset();
		deleteWorktreeMutateMock.mockReset();
		resolveTaskStartGeometryMock.mockReset();
		flushBoardCommandsMock.mockReset();
		flushBoardCommandsMock.mockResolvedValue({ ok: true });
		resolveTaskStartGeometryMock.mockResolvedValue({ cols: 120, rows: 40 });
		startTaskSessionMutateMock.mockResolvedValue({
			ok: true,
			summary: {
				taskId: "task-1",
				state: "running",
				agentId: "codex",
				sessionLaunchPath: "/tmp/task-1",
				pid: 123,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
			},
		});
		deleteWorktreeMutateMock.mockResolvedValue({ ok: true, removed: true });
		stopTaskSessionMutateMock.mockResolvedValue({ ok: true, summary: null });
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("forwards the task prompt when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(createTask());
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
			prompt: "Resume me",
			agentId: undefined,
			resumeConversation: undefined,
			awaitReview: undefined,
			baseRef: "main",
			useWorktree: undefined,
			cols: 120,
			rows: 40,
		});
	});

	it("forwards the task agent when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({ ...createTask(), agentId: "codex" });
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: "codex" }));
	});

	it("forwards task images when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			}),
		);
	});

	it("waits for terminal geometry before starting the runtime session", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const geometry = createDeferred<{ cols: number; rows: number }>();
		resolveTaskStartGeometryMock.mockReturnValue(geometry.promise);

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const snapshot = latestSnapshot as HookSnapshot;

		const startPromise = snapshot.startTaskSession(createTask());
		await Promise.resolve();

		expect(resolveTaskStartGeometryMock).toHaveBeenCalledWith({
			taskId: "task-1",
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
		});
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();

		geometry.resolve({ cols: 132, rows: 38 });
		await act(async () => {
			await startPromise;
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(expect.objectContaining({ cols: 132, rows: 38 }));
	});

	it("flushes the runtime board command before preparing or starting a session", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const flush = createDeferred<{ ok: boolean }>();
		flushBoardCommandsMock.mockReturnValue(flush.promise);

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const snapshot = latestSnapshot as HookSnapshot | null;
		if (snapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const startPromise = snapshot.startTaskSession(createTask());
		expect(resolveTaskStartGeometryMock).not.toHaveBeenCalled();
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();

		flush.resolve({ ok: true });
		await act(async () => {
			await startPromise;
		});

		expect(resolveTaskStartGeometryMock).toHaveBeenCalledOnce();
		expect(startTaskSessionMutateMock).toHaveBeenCalledOnce();
	});

	it("does not start a session when the board command cannot be committed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		flushBoardCommandsMock.mockResolvedValue({ ok: false, message: "revision conflict" });

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const snapshot = latestSnapshot as HookSnapshot | null;
		if (snapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const result = await snapshot.startTaskSession(createTask());

		expect(result).toEqual({ ok: false, message: "revision conflict" });
		expect(resolveTaskStartGeometryMock).not.toHaveBeenCalled();
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("commits a pending board transition before stopping its session", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const flush = createDeferred<{ ok: boolean }>();
		flushBoardCommandsMock.mockReturnValue(flush.promise);

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const snapshot = latestSnapshot as HookSnapshot | null;
		if (snapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const stopPromise = snapshot.stopTaskSession("task-1", { waitForExit: true });
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();

		flush.resolve({ ok: true });
		await act(async () => {
			await stopPromise;
		});

		expect(stopTaskSessionMutateMock).toHaveBeenCalledWith({ taskId: "task-1", waitForExit: true });
	});

	it("does not stop a session when its preceding board transition failed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		flushBoardCommandsMock.mockResolvedValue({ ok: false, message: "revision conflict" });

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const snapshot = latestSnapshot as HookSnapshot | null;
		if (snapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		await snapshot.stopTaskSession("task-1", { waitForExit: true });
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("commits the task board command before deleting its worktree", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const flush = createDeferred<{ ok: boolean }>();
		flushBoardCommandsMock.mockReturnValue(flush.promise);

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const snapshot = latestSnapshot as HookSnapshot | null;
		if (snapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const cleanupPromise = snapshot.cleanupTaskWorktree("task-1");
		expect(deleteWorktreeMutateMock).not.toHaveBeenCalled();

		flush.resolve({ ok: true });
		await act(async () => {
			await cleanupPromise;
		});

		expect(deleteWorktreeMutateMock).toHaveBeenCalledWith({ taskId: "task-1" });
	});

	it("keeps the worktree when its preceding board command cannot be committed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		flushBoardCommandsMock.mockResolvedValue({ ok: false, message: "revision conflict" });

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const snapshot = latestSnapshot as HookSnapshot | null;
		if (snapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		await expect(snapshot.cleanupTaskWorktree("task-1")).resolves.toBeNull();
		expect(deleteWorktreeMutateMock).not.toHaveBeenCalled();
	});
});
