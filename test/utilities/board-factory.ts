import type { RuntimeBoardData } from "../../src/core";

export function createBoard(title: string): RuntimeBoardData {
	const now = Date.now();
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt: title,
						baseRef: "main",
						createdAt: now,
						updatedAt: now,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

export function createReviewBoard(taskId: string, title: string, existingTrashTaskId?: string): RuntimeBoardData {
	const now = Date.now();
	const trashCards = existingTrashTaskId
		? [
				{
					id: existingTrashTaskId,
					title: null,
					prompt: "Already trashed task",
					baseRef: "main",
					createdAt: now,
					updatedAt: now,
				},
			]
		: [];
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: taskId,
						title: null,
						prompt: title,
						baseRef: "main",
						createdAt: now,
						updatedAt: now,
					},
				],
			},
			{ id: "trash", title: "Trash", cards: trashCards },
		],
		dependencies: [],
	};
}
