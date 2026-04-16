import { describe, expect, it } from "vitest";

import { applyDragResult, getTaskColumnId, moveTaskToColumn } from "@/state/board-state";
import { createBacklogBoard, requireTaskId } from "@/state/board-state-test-helpers";
import type { ProgrammaticCardMoveInFlight } from "@/state/drag-rules";

describe("applyDragResult", () => {
	it("keeps manual in-progress to review drags disabled", () => {
		const fixture = createBacklogBoard(["Task A"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const movedToInProgress = moveTaskToColumn(fixture.board, taskA, "in_progress");
		expect(movedToInProgress.moved).toBe(true);

		const attemptedReviewMove = applyDragResult(movedToInProgress.board, {
			draggableId: taskA,
			type: "CARD",
			source: { droppableId: "in_progress", index: 0 },
			destination: { droppableId: "review", index: 0 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(attemptedReviewMove.moveEvent).toBeUndefined();
		expect(getTaskColumnId(attemptedReviewMove.board, taskA)).toBe("in_progress");
	});

	it("preserves manual backlog to in-progress drop positions", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedB = moveTaskToColumn(fixture.board, taskB, "in_progress");
		expect(movedB.moved).toBe(true);
		const movedC = moveTaskToColumn(movedB.board, taskC, "in_progress");
		expect(movedC.moved).toBe(true);

		const movedA = applyDragResult(movedC.board, {
			draggableId: taskA,
			type: "CARD",
			source: { droppableId: "backlog", index: 0 },
			destination: { droppableId: "in_progress", index: 2 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(movedA.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "backlog",
			toColumnId: "in_progress",
		});
		const inProgressColumn = movedA.board.columns.find((column) => column.id === "in_progress");
		expect(inProgressColumn?.cards.map((card) => card.id)).toEqual([taskB, taskC, taskA]);
	});

	it("inserts programmatic backlog to in-progress moves at the top", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedB = moveTaskToColumn(fixture.board, taskB, "in_progress");
		expect(movedB.moved).toBe(true);
		const movedC = moveTaskToColumn(movedB.board, taskC, "in_progress");
		expect(movedC.moved).toBe(true);

		const movedA = applyDragResult(
			movedC.board,
			{
				draggableId: taskA,
				type: "CARD",
				source: { droppableId: "backlog", index: 0 },
				destination: { droppableId: "in_progress", index: 2 },
				mode: "SNAP",
				reason: "DROP",
				combine: null,
			},
			{
				programmaticCardMoveInFlight: {
					taskId: taskA,
					fromColumnId: "backlog",
					toColumnId: "in_progress",
					insertAtTop: true,
				},
			},
		);
		expect(movedA.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "backlog",
			toColumnId: "in_progress",
		});
		const inProgressColumn = movedA.board.columns.find((column) => column.id === "in_progress");
		expect(inProgressColumn?.cards.map((card) => card.id)).toEqual([taskA, taskB, taskC]);
	});

	it("supports programmatic drag transitions between in-progress and review", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");
		const movedToInProgress = moveTaskToColumn(fixture.board, taskA, "in_progress");
		expect(movedToInProgress.moved).toBe(true);
		const movedBToReview = moveTaskToColumn(movedToInProgress.board, taskB, "review");
		expect(movedBToReview.moved).toBe(true);
		const movedCToInProgress = moveTaskToColumn(movedBToReview.board, taskC, "in_progress");
		expect(movedCToInProgress.moved).toBe(true);
		const moveToReview: ProgrammaticCardMoveInFlight = {
			taskId: taskA,
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};

		const movedToReview = applyDragResult(
			movedCToInProgress.board,
			{
				draggableId: taskA,
				type: "CARD",
				source: { droppableId: "in_progress", index: 0 },
				destination: { droppableId: "review", index: 1 },
				mode: "SNAP",
				reason: "DROP",
				combine: null,
			},
			{
				programmaticCardMoveInFlight: moveToReview,
			},
		);
		expect(movedToReview.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "in_progress",
			toColumnId: "review",
		});
		expect(getTaskColumnId(movedToReview.board, taskA)).toBe("review");
		const reviewColumn = movedToReview.board.columns.find((column) => column.id === "review");
		expect(reviewColumn?.cards.map((card) => card.id)).toEqual([taskA, taskB]);
		const moveBackToInProgress: ProgrammaticCardMoveInFlight = {
			taskId: taskA,
			fromColumnId: "review",
			toColumnId: "in_progress",
			insertAtTop: true,
		};

		const movedBackToInProgress = applyDragResult(
			movedToReview.board,
			{
				draggableId: taskA,
				type: "CARD",
				source: { droppableId: "review", index: 0 },
				destination: { droppableId: "in_progress", index: 2 },
				mode: "SNAP",
				reason: "DROP",
				combine: null,
			},
			{
				programmaticCardMoveInFlight: moveBackToInProgress,
			},
		);
		expect(movedBackToInProgress.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "review",
			toColumnId: "in_progress",
		});
		expect(getTaskColumnId(movedBackToInProgress.board, taskA)).toBe("in_progress");
		const inProgressColumn = movedBackToInProgress.board.columns.find((column) => column.id === "in_progress");
		expect(inProgressColumn?.cards.map((card) => card.id)).toEqual([taskA, taskC]);
	});

	it("preserves manual cross-column trash drop positions", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedAToTrash = moveTaskToColumn(fixture.board, taskA, "trash");
		expect(movedAToTrash.moved).toBe(true);
		const movedBToTrash = moveTaskToColumn(movedAToTrash.board, taskB, "trash");
		expect(movedBToTrash.moved).toBe(true);
		const movedCToReview = moveTaskToColumn(movedBToTrash.board, taskC, "review");
		expect(movedCToReview.moved).toBe(true);

		const movedToTrash = applyDragResult(movedCToReview.board, {
			draggableId: taskC,
			type: "CARD",
			source: { droppableId: "review", index: 0 },
			destination: { droppableId: "trash", index: 2 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(movedToTrash.moveEvent).toMatchObject({
			taskId: taskC,
			fromColumnId: "review",
			toColumnId: "trash",
		});
		const trashColumn = movedToTrash.board.columns.find((column) => column.id === "trash");
		expect(trashColumn?.cards.map((card) => card.id)).toEqual([taskB, taskA, taskC]);
	});

	it("allows manual trash to review drags", () => {
		const fixture = createBacklogBoard(["Task A", "Task B"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");

		const movedAToTrash = moveTaskToColumn(fixture.board, taskA, "trash");
		expect(movedAToTrash.moved).toBe(true);
		const movedBToReview = moveTaskToColumn(movedAToTrash.board, taskB, "review");
		expect(movedBToReview.moved).toBe(true);

		const movedToReview = applyDragResult(movedBToReview.board, {
			draggableId: taskA,
			type: "CARD",
			source: { droppableId: "trash", index: 0 },
			destination: { droppableId: "review", index: 1 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(movedToReview.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "trash",
			toColumnId: "review",
		});
		expect(getTaskColumnId(movedToReview.board, taskA)).toBe("review");
		const reviewColumn = movedToReview.board.columns.find((column) => column.id === "review");
		expect(reviewColumn?.cards.map((card) => card.id)).toEqual([taskB, taskA]);
	});

	it("restores the correct card when source index diverges from state order", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedAToTrash = moveTaskToColumn(fixture.board, taskA, "trash");
		expect(movedAToTrash.moved).toBe(true);
		const movedBToTrash = moveTaskToColumn(movedAToTrash.board, taskB, "trash");
		expect(movedBToTrash.moved).toBe(true);
		const movedCToTrash = moveTaskToColumn(movedBToTrash.board, taskC, "trash");
		expect(movedCToTrash.moved).toBe(true);

		const restored = applyDragResult(movedCToTrash.board, {
			draggableId: taskC,
			type: "CARD",
			source: { droppableId: "trash", index: 0 },
			destination: { droppableId: "review", index: 0 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(restored.moveEvent).toMatchObject({
			taskId: taskC,
			fromColumnId: "trash",
			toColumnId: "review",
		});
		expect(getTaskColumnId(restored.board, taskC)).toBe("review");
		expect(getTaskColumnId(restored.board, taskA)).toBe("trash");
		expect(getTaskColumnId(restored.board, taskB)).toBe("trash");
	});

	it("inserts programmatic trash drags at the top of trash", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedAToTrash = moveTaskToColumn(fixture.board, taskA, "trash");
		expect(movedAToTrash.moved).toBe(true);
		const movedBToTrash = moveTaskToColumn(movedAToTrash.board, taskB, "trash");
		expect(movedBToTrash.moved).toBe(true);
		const movedCToReview = moveTaskToColumn(movedBToTrash.board, taskC, "review");
		expect(movedCToReview.moved).toBe(true);

		const movedToTrash = applyDragResult(
			movedCToReview.board,
			{
				draggableId: taskC,
				type: "CARD",
				source: { droppableId: "review", index: 0 },
				destination: { droppableId: "trash", index: 2 },
				mode: "SNAP",
				reason: "DROP",
				combine: null,
			},
			{
				programmaticCardMoveInFlight: {
					taskId: taskC,
					fromColumnId: "review",
					toColumnId: "trash",
					insertAtTop: true,
				},
			},
		);
		expect(movedToTrash.moveEvent).toMatchObject({
			taskId: taskC,
			fromColumnId: "review",
			toColumnId: "trash",
		});
		const trashColumn = movedToTrash.board.columns.find((column) => column.id === "trash");
		expect(trashColumn?.cards.map((card) => card.id)).toEqual([taskC, taskB, taskA]);
	});
});
