import { act } from "react";
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
const getTaskWorkspaceSnapshotMock = vi.hoisted(() => vi.fn((): any => null));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock needs flexible return type
const getTaskWorkspaceInfoMock = vi.hoisted(() => vi.fn((): any => null));

vi.mock("sonner", () => ({
	toast: toastMock,
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	getTaskWorkspaceSnapshot: getTaskWorkspaceSnapshotMock,
	getTaskWorkspaceInfo: getTaskWorkspaceInfoMock,
}));

describe("useLinkedBacklogTaskActions — worktree notice toast", () => {
	const ctx = useTestEnvironment();

	beforeEach(() => {
		toastMock.mockReset();
		getTaskWorkspaceSnapshotMock.mockReset();
		getTaskWorkspaceInfoMock.mockReset();
	});

	it("shows toast when trashing from in_progress with showTrashWorktreeNotice enabled", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async () => null);

		const boardFactory = (): BoardData => ({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [createTask("task-ip", "In progress task", 1)],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={true}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-ip", "in_progress");
		});

		expect(toastMock).toHaveBeenCalledWith(
			"Task workspace removed",
			expect.objectContaining({
				description: expect.stringContaining("worktree was deleted"),
			}),
		);
	});

	it("shows toast when trashing from review column", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async () => null);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={true}
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

		expect(toastMock).toHaveBeenCalledWith("Task workspace removed", expect.anything());
	});

	it("does not show toast when trashing from backlog", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async () => null);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={true}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-1", "backlog");
		});

		expect(toastMock).not.toHaveBeenCalled();
	});

	it("does not show toast when showTrashWorktreeNotice is false", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async () => null);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={false}
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

		expect(toastMock).not.toHaveBeenCalled();
	});

	it("does not show toast when skipWorkingChangeWarning bypasses the normal path", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async () => null);

		await act(async () => {
			ctx.root.render(
				<HookHarness
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={true}
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

		expect(toastMock).not.toHaveBeenCalled();
	});

	it("toast action calls saveTrashWorktreeNoticeDismissed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async () => null);
		const saveTrashWorktreeNoticeDismissed = vi.fn();

		await act(async () => {
			ctx.root.render(
				<HookHarness
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={true}
					saveTrashWorktreeNoticeDismissed={saveTrashWorktreeNoticeDismissed}
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

		expect(toastMock).toHaveBeenCalledTimes(1);

		const toastOptions = toastMock.mock.calls[0]![1];
		toastOptions.cancel.onClick();

		expect(saveTrashWorktreeNoticeDismissed).toHaveBeenCalledTimes(1);
	});

	it("suppresses toast after showTrashWorktreeNotice prop transitions from true to false", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async () => null);

		const boardFactory = (): BoardData => ({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [createTask("task-ip", "In progress task", 1)],
				},
				{
					id: "review",
					title: "Review",
					cards: [createTask("task-rv", "Review task", 2)],
				},
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={true}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		let snapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await snapshot.requestMoveTaskToTrash("task-rv", "review");
		});
		expect(toastMock).toHaveBeenCalledTimes(1);
		toastMock.mockClear();

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={false}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		snapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await snapshot.requestMoveTaskToTrash("task-ip", "in_progress");
		});
		expect(toastMock).not.toHaveBeenCalled();
	});

	it("full dismiss lifecycle: 'Don't show again' followed by prop update suppresses future toasts", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async () => null);
		const saveTrashWorktreeNoticeDismissed = vi.fn();

		const boardFactory = (): BoardData => ({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [createTask("task-ip", "In progress task", 1)],
				},
				{
					id: "review",
					title: "Review",
					cards: [createTask("task-rv", "Review task", 2)],
				},
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={true}
					saveTrashWorktreeNoticeDismissed={saveTrashWorktreeNoticeDismissed}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		let snapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await snapshot.requestMoveTaskToTrash("task-rv", "review");
		});
		expect(toastMock).toHaveBeenCalledTimes(1);

		const toastOptions = toastMock.mock.calls[0]![1];
		toastOptions.cancel.onClick();
		expect(saveTrashWorktreeNoticeDismissed).toHaveBeenCalledTimes(1);
		toastMock.mockClear();

		await act(async () => {
			ctx.root.render(
				<HookHarness
					boardFactory={boardFactory}
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					showTrashWorktreeNotice={false}
					saveTrashWorktreeNoticeDismissed={saveTrashWorktreeNoticeDismissed}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		snapshot = requireSnapshot(latestSnapshot);

		await act(async () => {
			await snapshot.requestMoveTaskToTrash("task-ip", "in_progress");
		});
		expect(toastMock).not.toHaveBeenCalled();
	});

	it("does not show toast when confirmation dialog was triggered", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const onRequestTrashConfirmation = vi.fn();
		getTaskWorkspaceSnapshotMock.mockReturnValue({
			taskId: "task-2",
			path: "/tmp/task-2",
			branch: null,
			isDetached: false,
			headCommit: null,
			changedFiles: 3,
		});

		await act(async () => {
			ctx.root.render(
				<HookHarness
					onRequestTrashConfirmation={onRequestTrashConfirmation}
					showTrashWorktreeNotice={true}
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
		expect(toastMock).not.toHaveBeenCalled();
	});
});
