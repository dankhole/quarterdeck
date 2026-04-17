import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { getDetailTerminalTaskId } from "@/hooks/terminal/use-terminal-panels";
import type { BoardCard } from "@/types";

import {
	createBoard,
	createDeferred,
	HookHarness,
	type HookSnapshot,
	useTestEnvironment,
} from "./linked-backlog-actions-test-harness";

describe("useLinkedBacklogTaskActions", () => {
	const ctx = useTestEnvironment();

	it("creates a dependency link between tasks", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			ctx.root.render(
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
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			initialSnapshot.handleCreateDependency("task-1", "task-2");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const snapshot = latestSnapshot as HookSnapshot;

		expect(snapshot.board.dependencies).toHaveLength(1);
		expect(snapshot.board.dependencies[0]).toMatchObject({
			fromTaskId: "task-1",
			toTaskId: "task-2",
		});
	});

	it("auto-starts linked backlog tasks when a parent task is trashed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const kickoffTaskInProgress = vi.fn(async () => true);
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					kickoffTaskInProgress={kickoffTaskInProgress}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(kickoffTaskInProgress).toHaveBeenCalledTimes(2);
	});

	it("uses animated backlog starts for dependency-unblocked tasks when available", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const kickoffTaskInProgress = vi.fn(async () => true);
		const startBacklogTaskWithAnimation = vi.fn(async (task: BoardCard) => task.id === "task-1");
		const waitForBacklogStartAnimationAvailability = vi.fn(async () => {});
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					kickoffTaskInProgress={kickoffTaskInProgress}
					startBacklogTaskWithAnimation={startBacklogTaskWithAnimation}
					waitForBacklogStartAnimationAvailability={waitForBacklogStartAnimationAvailability}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(startBacklogTaskWithAnimation).toHaveBeenCalledTimes(2);
		expect(startBacklogTaskWithAnimation.mock.calls[0]?.[0]).toMatchObject({ id: "task-1" });
		expect(startBacklogTaskWithAnimation.mock.calls[1]?.[0]).toMatchObject({ id: "task-3" });
		expect(waitForBacklogStartAnimationAvailability).toHaveBeenCalledTimes(1);
		expect(kickoffTaskInProgress).not.toHaveBeenCalled();
	});

	it("stops the main task session and its detail terminal shell when a task is trashed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const stopTaskSession = vi.fn(async (_taskId: string) => {});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					stopTaskSession={stopTaskSession}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(stopTaskSession).toHaveBeenCalledTimes(2);
		expect(stopTaskSession).toHaveBeenNthCalledWith(1, reviewTask.id, { waitForExit: true });
		expect(stopTaskSession).toHaveBeenNthCalledWith(2, getDetailTerminalTaskId(reviewTask.id));
	});

	it("trashes tasks directly through the request handler", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorktree = vi.fn(async (_taskId: string) => null);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					cleanupTaskWorktree={cleanupTaskWorktree}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const nextSnapshot = latestSnapshot as HookSnapshot;
		expect(nextSnapshot.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(0);
		expect(nextSnapshot.board.columns.find((column) => column.id === "trash")?.cards[0]?.id).toBe("task-2");
		expect(cleanupTaskWorktree).toHaveBeenCalledWith("task-2");
	});

	it("can queue the next dependency-unblocked animation before the previous start resolves", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const firstKickoff = createDeferred<boolean>();
		const secondKickoff = createDeferred<boolean>();
		const waitForSecondAnimation = createDeferred<void>();
		const startBacklogTaskWithAnimation = vi.fn((task: BoardCard) => {
			if (task.id === "task-1") {
				return firstKickoff.promise;
			}
			return secondKickoff.promise;
		});
		const waitForBacklogStartAnimationAvailability = vi.fn(async () => {
			await waitForSecondAnimation.promise;
		});
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					startBacklogTaskWithAnimation={startBacklogTaskWithAnimation}
					waitForBacklogStartAnimationAvailability={waitForBacklogStartAnimationAvailability}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		let movePromise: Promise<void> | null = null;
		await act(async () => {
			movePromise = initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
			await Promise.resolve();
		});

		expect(startBacklogTaskWithAnimation).toHaveBeenCalledTimes(1);
		expect(startBacklogTaskWithAnimation.mock.calls[0]?.[0]).toMatchObject({ id: "task-1" });

		await act(async () => {
			waitForSecondAnimation.resolve();
			await Promise.resolve();
		});

		expect(startBacklogTaskWithAnimation).toHaveBeenCalledTimes(2);
		expect(startBacklogTaskWithAnimation.mock.calls[1]?.[0]).toMatchObject({ id: "task-3" });

		await act(async () => {
			firstKickoff.resolve(true);
			secondKickoff.resolve(true);
			await movePromise;
		});
	});
});
