import { describe, expect, it } from "vitest";
import {
	createEmptyTaskEditDraft,
	createResetTaskCreateDraft,
	createTaskEditDraft,
	createTaskOnBoard,
	createTasksOnBoard,
	saveEditedTaskToBoard,
} from "@/hooks/board/task-editor-drafts";
import type { BoardCard, BoardData } from "@/types";

function createTask(id: string, prompt: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title: null,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createBoard(tasks: BoardCard[] = []): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: tasks },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

describe("task-editor-drafts", () => {
	it("returns stable reset drafts for create and edit flows", () => {
		expect(createResetTaskCreateDraft("main")).toMatchObject({
			prompt: "",
			images: [],
			useWorktree: true,
			createFeatureBranch: false,
			branchName: "",
			branchRef: "main",
		});
		expect(createEmptyTaskEditDraft()).toMatchObject({
			editingTaskId: null,
			prompt: "",
			autoReviewMode: "commit",
			branchRef: "",
		});
	});

	it("builds edit drafts and applies edited task changes to the board", () => {
		const task = createTask("task-1", "Original prompt", {
			startInPlanMode: true,
			autoReviewEnabled: true,
			autoReviewMode: "move_to_trash",
			images: [{ id: "img-1", data: "abc", mimeType: "image/png" }],
		});
		const draft = createTaskEditDraft(task, "main");
		expect(draft).toMatchObject({
			editingTaskId: "task-1",
			prompt: "Original prompt",
			startInPlanMode: true,
			autoReviewEnabled: true,
			autoReviewMode: "move_to_trash",
			branchRef: "main",
		});

		const result = saveEditedTaskToBoard({
			board: createBoard([task]),
			editingTaskId: draft.editingTaskId,
			prompt: "Updated prompt",
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			images: draft.images,
			branchRef: draft.branchRef,
			defaultBranchRef: "main",
		});

		expect(result.savedTaskId).toBe("task-1");
		expect(result.board.columns[0]?.cards[0]).toMatchObject({
			prompt: "Updated prompt",
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
		});
	});

	it("creates single and multiple backlog tasks from the draft inputs", () => {
		const single = createTaskOnBoard({
			board: createBoard(),
			prompt: "Ship release",
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			images: [],
			branchRef: "main",
			defaultBranchRef: "main",
			useWorktree: true,
			branchName: "feature/ship-release",
			createFeatureBranch: true,
		});
		expect(single.createdTaskId).toBeTruthy();
		expect(single.baseRef).toBe("main");
		expect(single.board.columns[0]?.cards[0]?.prompt).toBe("Ship release");

		const multi = createTasksOnBoard({
			board: createBoard(),
			prompts: ["One", "  ", "Two"],
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			images: [],
			branchRef: "develop",
			defaultBranchRef: "main",
			useWorktree: true,
		});
		expect(multi.createdTaskIds).toHaveLength(2);
		expect(multi.baseRef).toBe("develop");
		expect(multi.board.columns[0]?.cards.map((card) => card.prompt)).toEqual(["Two", "One"]);
	});
});
