// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { deriveWorktreeBranches } from "./worktree-branches";

const card: BoardCard = {
	id: "task",
	title: "Task work",
	prompt: "Task",
	baseRef: "main",
	branch: "saved-branch",
	useWorktree: true,
	workingDirectory: "/worktrees/task",
	createdAt: 1,
	updatedAt: 1,
};

function boardWith(task: BoardCard, columnId: BoardColumnId = "review"): BoardData {
	return { columns: [{ id: columnId, title: columnId, cards: [task] }] };
}

const attached: RuntimeTaskRepositoryInfoResponse = {
	taskId: card.id,
	path: "/worktrees/task",
	exists: true,
	baseRef: card.baseRef,
	branch: "actual-branch",
	isDetached: false,
	headCommit: "abc123",
};

describe("deriveWorktreeBranches", () => {
	it("reserves the observed attachment with the task label instead of its persisted branch hint", () => {
		expect([...deriveWorktreeBranches(boardWith(card), { task: attached })]).toEqual([
			["actual-branch", "Task work"],
		]);
		expect([...deriveWorktreeBranches(boardWith({ ...card, title: null }), { task: attached })]).toEqual([
			["actual-branch", "task"],
		]);
	});

	it.each([
		{ name: "unknown checkout", info: null },
		{ name: "missing checkout", info: { ...attached, exists: false } },
		{ name: "detached restore", info: { ...attached, isDetached: true } },
		{ name: "no current branch", info: { ...attached, branch: null } },
		{ name: "stale base ref", info: { ...attached, baseRef: "other-base" } },
		{ name: "replaced workspace", info: { ...attached, path: "/worktrees/other" } },
	])("does not reserve a persisted branch for $name", ({ info }) => {
		expect(deriveWorktreeBranches(boardWith(card), { task: info }).size).toBe(0);
	});

	it("excludes Trash and shared-checkout tasks while preserving path aliases", () => {
		expect(deriveWorktreeBranches(boardWith(card, "trash"), { task: attached }).size).toBe(0);
		expect(deriveWorktreeBranches(boardWith({ ...card, useWorktree: false }), { task: attached }).size).toBe(0);
		expect(
			deriveWorktreeBranches(boardWith({ ...card, workingDirectory: "C:\\Worktrees\\Task" }), {
				task: { ...attached, path: "c:/worktrees/task/" },
			}).get("actual-branch"),
		).toBe("Task work");
	});
});
