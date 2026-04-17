import { act, type Dispatch, type SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardData } from "@/types";

import {
	createTask,
	HookHarness,
	type HookSnapshot,
	requireSnapshot,
	useTestEnvironment,
} from "./linked-backlog-actions-test-harness";

const toastMock = vi.hoisted(() => vi.fn());
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock needs flexible return type
const getTaskProjectSnapshotMock = vi.hoisted(() => vi.fn((): any => null));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock needs flexible return type
const getTaskWorktreeInfoMock = vi.hoisted(() => vi.fn((): any => null));

vi.mock("sonner", () => ({
	toast: toastMock,
}));

vi.mock("@/stores/project-metadata-store", () => ({
	getTaskProjectSnapshot: getTaskProjectSnapshotMock,
	getTaskWorktreeInfo: getTaskWorktreeInfoMock,
}));

describe("useLinkedBacklogTaskActions — trash confirmation dialog", () => {
	const ctx = useTestEnvironment();

	beforeEach(() => {
		toastMock.mockReset();
		getTaskProjectSnapshotMock.mockReset();
		getTaskWorktreeInfoMock.mockReset();
	});

	it("calls onRequestTrashConfirmation when task has uncommitted changes", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onRequestTrashConfirmation = vi.fn();
		getTaskProjectSnapshotMock.mockReturnValue({
			taskId: "task-2",
			path: "/tmp/task-2",
			branch: "task-2-branch",
			isDetached: false,
			headCommit: "abc123",
			changedFiles: 3,
		});
		getTaskWorktreeInfoMock.mockReturnValue({
			taskId: "task-2",
			path: "/tmp/task-2",
			exists: true,
			baseRef: "main",
			branch: "task-2-branch",
			isDetached: false,
			headCommit: "abc123",
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					onRequestTrashConfirmation={onRequestTrashConfirmation}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		expect(onRequestTrashConfirmation).toHaveBeenCalledTimes(1);
		expect(onRequestTrashConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ fileCount: 3 }),
			expect.objectContaining({ id: "task-2" }),
			"review",
			false,
		);

		const nextSnapshot = requireSnapshot(latestSnapshot);
		expect(nextSnapshot.board.columns.find((c) => c.id === "review")?.cards).toHaveLength(1);
	});

	it("passes optimisticMoveApplied through to the confirmation callback", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onRequestTrashConfirmation = vi.fn();
		getTaskProjectSnapshotMock.mockReturnValue({
			taskId: "task-2",
			path: "/tmp/task-2",
			branch: null,
			isDetached: false,
			headCommit: null,
			changedFiles: 1,
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					onRequestTrashConfirmation={onRequestTrashConfirmation}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review", { optimisticMoveApplied: true });
		});

		expect(onRequestTrashConfirmation).toHaveBeenCalledWith(expect.anything(), expect.anything(), "review", true);
	});

	it("skips confirmation dialog when skipWorkingChangeWarning is true", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onRequestTrashConfirmation = vi.fn();
		const cleanupTaskWorkspace = vi.fn(async () => null);
		getTaskProjectSnapshotMock.mockReturnValue({
			taskId: "task-2",
			path: "/tmp/task-2",
			branch: null,
			isDetached: false,
			headCommit: null,
			changedFiles: 5,
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					onRequestTrashConfirmation={onRequestTrashConfirmation}
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review", {
				skipWorkingChangeWarning: true,
			});
		});

		expect(onRequestTrashConfirmation).not.toHaveBeenCalled();
		const nextSnapshot = requireSnapshot(latestSnapshot);
		expect(nextSnapshot.board.columns.find((c) => c.id === "review")?.cards).toHaveLength(0);
		expect(nextSnapshot.board.columns.find((c) => c.id === "trash")?.cards[0]?.id).toBe("task-2");
	});

	it("shows confirmation when changedFiles is 0", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onRequestTrashConfirmation = vi.fn();
		getTaskProjectSnapshotMock.mockReturnValue({
			taskId: "task-2",
			path: "/tmp/task-2",
			branch: null,
			isDetached: false,
			headCommit: null,
			changedFiles: 0,
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					onRequestTrashConfirmation={onRequestTrashConfirmation}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		expect(onRequestTrashConfirmation).toHaveBeenCalledTimes(1);
		expect(onRequestTrashConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ fileCount: 0 }),
			expect.objectContaining({ id: "task-2" }),
			"review",
			false,
		);

		const nextSnapshot = requireSnapshot(latestSnapshot);
		expect(nextSnapshot.board.columns.find((c) => c.id === "review")?.cards).toHaveLength(1);
	});

	it("shows confirmation when snapshot is null", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onRequestTrashConfirmation = vi.fn();
		getTaskProjectSnapshotMock.mockReturnValue(null);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					onRequestTrashConfirmation={onRequestTrashConfirmation}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		expect(onRequestTrashConfirmation).toHaveBeenCalledTimes(1);
		expect(onRequestTrashConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ fileCount: 0 }),
			expect.objectContaining({ id: "task-2" }),
			"review",
			false,
		);

		const nextSnapshot = requireSnapshot(latestSnapshot);
		expect(nextSnapshot.board.columns.find((c) => c.id === "review")?.cards).toHaveLength(1);
	});

	it("shows confirmation when changedFiles is null", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onRequestTrashConfirmation = vi.fn();
		getTaskProjectSnapshotMock.mockReturnValue({
			taskId: "task-2",
			path: "/tmp/task-2",
			branch: null,
			isDetached: false,
			headCommit: null,
			changedFiles: null,
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					onRequestTrashConfirmation={onRequestTrashConfirmation}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		expect(onRequestTrashConfirmation).toHaveBeenCalledTimes(1);
		expect(onRequestTrashConfirmation).toHaveBeenCalledWith(
			expect.objectContaining({ fileCount: 0 }),
			expect.objectContaining({ id: "task-2" }),
			"review",
			false,
		);

		const nextSnapshot = requireSnapshot(latestSnapshot);
		expect(nextSnapshot.board.columns.find((c) => c.id === "review")?.cards).toHaveLength(1);
	});

	it("updates selection when trashing a task that is already in trash from optimistic move", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();
		const stopTaskSession = vi.fn(async () => {});
		const cleanupTaskWorkspace = vi.fn(async () => null);

		const boardFactory = (): BoardData => ({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [createTask("task-ip", "In progress task", 4)],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Trash", cards: [createTask("task-2", "Review task", 2)] },
			],
			dependencies: [],
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					stopTaskSession={stopTaskSession}
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					setSelectedTaskIdOverride={setSelectedTaskId}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const trashTask = initialSnapshot.board.columns.find((c) => c.id === "trash")?.cards[0];
		if (!trashTask) throw new Error("Expected a trash task.");

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(trashTask, initialSnapshot.board);
		});

		expect(setSelectedTaskId).toHaveBeenCalled();
		expect(stopTaskSession).toHaveBeenCalledTimes(2);
		expect(cleanupTaskWorkspace).toHaveBeenCalledWith("task-2");
	});
});
