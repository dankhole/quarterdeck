import { describe, expect, it } from "vitest";
import { buildTrashWarningViewModel } from "@/hooks/board/task-trash-actions";
import type { BoardCard } from "@/types";

describe("buildTrashWarningViewModel", () => {
	function card(overrides: Partial<BoardCard> = {}): BoardCard {
		return {
			id: "task-1",
			title: "My Task",
			prompt: "do it",
			baseRef: "main",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides,
		};
	}

	it("builds view model with task title", () => {
		const vm = buildTrashWarningViewModel(card({ title: "Build feature" }), 5, null);
		expect(vm.taskTitle).toBe("Build feature");
		expect(vm.fileCount).toBe(5);
		expect(vm.worktreeInfo).toBeNull();
		expect(vm.isNonIsolated).toBe(false);
	});

	it("uses 'Untitled task' when title is null", () => {
		const vm = buildTrashWarningViewModel(card({ title: null }), 0, null);
		expect(vm.taskTitle).toBe("Untitled task");
	});

	it("marks non-isolated when useWorktree is false", () => {
		const vm = buildTrashWarningViewModel(card({ useWorktree: false }), 0, null);
		expect(vm.isNonIsolated).toBe(true);
	});

	it("marks isolated when useWorktree is undefined", () => {
		const vm = buildTrashWarningViewModel(card(), 0, null);
		expect(vm.isNonIsolated).toBe(false);
	});
});
