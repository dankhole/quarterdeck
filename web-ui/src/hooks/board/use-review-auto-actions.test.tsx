import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewAutoActions } from "@/hooks/board/use-review-auto-actions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { resetProjectMetadataStore, setTaskWorktreeSnapshot } from "@/stores/project-metadata-store";
import type { BoardColumnId, BoardData, ReviewTaskWorktreeSnapshot } from "@/types";

function createBoard(autoReviewEnabled: boolean): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt: "Test task",
						startInPlanMode: false,
						autoReviewEnabled,
						autoReviewMode: "move_to_trash",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

const worktreeSnapshots: Record<string, ReviewTaskWorktreeSnapshot> = {
	"task-1": {
		taskId: "task-1",
		path: "/tmp/task-1",
		branch: "task-1",
		isDetached: false,
		headCommit: "abc123",
		changedFiles: 3,
		additions: 10,
		deletions: 2,
		hasUnmergedChanges: true,
		behindBaseCount: null,
		conflictState: null,
	},
};

function HookHarness({
	board,
	sessions = {},
	requestMoveTaskToTrash,
}: {
	board: BoardData;
	sessions?: Record<string, import("@/runtime/types").RuntimeTaskSessionSummary>;
	requestMoveTaskToTrash: (taskId: string, fromColumnId: BoardColumnId) => Promise<void>;
}): null {
	setTaskWorktreeSnapshot(worktreeSnapshots["task-1"] ?? null);
	useReviewAutoActions({
		board,
		sessions,
		requestMoveTaskToTrash,
	});
	return null;
}

describe("useReviewAutoActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
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
		resetProjectMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("cancels a scheduled auto review action when autoReviewEnabled is turned off", async () => {
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(<HookHarness board={createBoard(true)} requestMoveTaskToTrash={requestMoveTaskToTrash} />);
		});

		await act(async () => {
			root.render(<HookHarness board={createBoard(false)} requestMoveTaskToTrash={requestMoveTaskToTrash} />);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("does not trash card in approval state", async () => {
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const approvalSession: RuntimeTaskSessionSummary = {
			taskId: "task-1",
			state: "awaiting_review",
			agentId: "claude",
			projectPath: "/tmp/worktree",
			pid: 1234,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			reviewReason: "hook",
			exitCode: null,
			lastHookAt: Date.now(),
			latestHookActivity: {
				hookEventName: "PermissionRequest",
				notificationType: null,
				activityText: "Waiting for approval",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				source: "claude",
				conversationSummaryText: null,
			},
			stalledSince: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
			conversationSummaries: [],
			displaySummary: null,
			displaySummaryGeneratedAt: null,
		};

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessions={{ "task-1": approvalSession }}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("trashes card in completed state with autoReviewEnabled", async () => {
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const completedSession: RuntimeTaskSessionSummary = {
			taskId: "task-1",
			state: "awaiting_review",
			agentId: "claude",
			projectPath: "/tmp/worktree",
			pid: null,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			reviewReason: "exit",
			exitCode: 0,
			lastHookAt: Date.now(),
			latestHookActivity: null,
			stalledSince: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
			conversationSummaries: [],
			displaySummary: null,
			displaySummaryGeneratedAt: null,
		};

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessions={{ "task-1": completedSession }}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-1", "review", { skipWorkingChangeWarning: true });
	});

	it("handles null session summary gracefully", async () => {
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness board={createBoard(true)} sessions={{}} requestMoveTaskToTrash={requestMoveTaskToTrash} />,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		// No crash. isApprovalState(null) returns false, so auto-review proceeds.
		expect(requestMoveTaskToTrash).toHaveBeenCalled();
	});

	it("re-evaluates when session transitions out of approval state", async () => {
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const approvalSession: RuntimeTaskSessionSummary = {
			taskId: "task-1",
			state: "awaiting_review",
			agentId: "claude",
			projectPath: "/tmp/worktree",
			pid: 1234,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			reviewReason: "hook",
			exitCode: null,
			lastHookAt: Date.now(),
			latestHookActivity: {
				hookEventName: "PermissionRequest",
				notificationType: null,
				activityText: "Waiting for approval",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				source: "claude",
				conversationSummaryText: null,
			},
			stalledSince: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
			conversationSummaries: [],
			displaySummary: null,
			displaySummaryGeneratedAt: null,
		};

		// First render: approval state — should NOT trash
		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessions={{ "task-1": approvalSession }}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();

		// Second render: approval cleared — should now trash
		const clearedSession: RuntimeTaskSessionSummary = {
			...approvalSession,
			latestHookActivity: null,
			updatedAt: Date.now() + 1,
		};

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessions={{ "task-1": clearedSession }}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-1", "review", { skipWorkingChangeWarning: true });
	});
});
