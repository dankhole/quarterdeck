import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskSessions } from "@/hooks/board/use-task-sessions";
import type { BoardCard } from "@/types";

const startTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const resolveTaskStartGeometryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			startTaskSession: {
				mutate: startTaskSessionMutateMock,
			},
		},
	}),
}));

vi.mock("@/hooks/board/task-session-geometry", () => ({
	resolveTaskStartGeometry: resolveTaskStartGeometryMock,
}));

interface HookSnapshot {
	startTaskSession: ReturnType<typeof useTaskSessions>["startTaskSession"];
}

function createTask(): BoardCard {
	return {
		id: "task-1",
		title: null,
		prompt: "Resume me",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function HookHarness({ onSnapshot }: { onSnapshot: (snapshot: HookSnapshot) => void }): null {
	const sessions = useTaskSessions({
		currentProjectId: "project-1",
		setSessions: () => {},
	});

	useEffect(() => {
		onSnapshot({
			startTaskSession: sessions.startTaskSession,
		});
	}, [onSnapshot, sessions.startTaskSession]);

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
		resolveTaskStartGeometryMock.mockReset();
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

	it("forwards start-in-plan-mode from the task card when starting a task", async () => {
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
				startInPlanMode: true,
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
			prompt: "Resume me",
			startInPlanMode: true,
			resumeConversation: undefined,
			awaitReview: undefined,
			baseRef: "main",
			cols: 120,
			rows: 40,
		});
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
});
