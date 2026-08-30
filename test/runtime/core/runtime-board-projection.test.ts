import { describe, expect, it } from "vitest";

import {
	projectRuntimeSessionsOntoBoard,
	projectRuntimeTaskMetadataOntoBoard,
} from "../../../src/core/runtime-board-projection";
import { createReviewBoard } from "../../utilities/board-factory";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

function createWindowsSharedBoard() {
	const board = createReviewBoard("task-1", "Windows shared checkout");
	const review = board.columns.find((column) => column.id === "review");
	const card = review?.cards[0];
	if (!card) throw new Error("Expected review card.");
	card.workingDirectory = "C:\\Repo";
	card.useWorktree = false;
	return board;
}

describe("runtime board projection path identity", () => {
	it("does not convert a Windows shared checkout casing alias into a worktree", () => {
		const result = projectRuntimeSessionsOntoBoard(
			createWindowsSharedBoard(),
			[
				createTestTaskSessionSummary({
					taskId: "task-1",
					state: "awaiting_review",
					reviewReason: "hook",
					sessionLaunchPath: "c:/repo/",
				}),
			],
			"C:\\REPO",
			"win32",
		);

		expect(result.changed).toBe(false);
	});

	it("does not rewrite metadata for a Windows path casing alias", () => {
		const result = projectRuntimeTaskMetadataOntoBoard(
			createWindowsSharedBoard(),
			[
				{
					taskId: "task-1",
					path: "c:/repo/",
					exists: true,
					baseRef: "main",
					branch: null,
					isDetached: false,
					headCommit: null,
					changedFiles: null,
					additions: null,
					deletions: null,
					hasUnmergedChanges: null,
					behindBaseCount: null,
					conflictState: null,
					stateVersion: 1,
				},
			],
			"C:\\REPO",
			"win32",
		);

		expect(result.changed).toBe(false);
	});
});
