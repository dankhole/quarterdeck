import { describe, expect, it } from "vitest";
import { buildTrashWarningViewModel, getDependencyAddErrorMessage } from "@/hooks/board/linked-backlog-task-actions";
import type { BoardCard } from "@/types";

describe("getDependencyAddErrorMessage", () => {
	it("returns message for same_task", () => {
		expect(getDependencyAddErrorMessage("same_task")).toBe("A task cannot be linked to itself.");
	});

	it("returns message for duplicate", () => {
		expect(getDependencyAddErrorMessage("duplicate")).toBe("Link already exists.");
	});

	it("returns message for trash_task", () => {
		expect(getDependencyAddErrorMessage("trash_task")).toBe("Links cannot include trashed tasks.");
	});

	it("returns message for non_backlog", () => {
		expect(getDependencyAddErrorMessage("non_backlog")).toBe("Links must include at least one Backlog task.");
	});

	it("returns fallback for unknown reason", () => {
		expect(getDependencyAddErrorMessage("something_else")).toBe("Could not create link.");
	});

	it("returns fallback for undefined", () => {
		expect(getDependencyAddErrorMessage(undefined)).toBe("Could not create link.");
	});
});

describe("buildTrashWarningViewModel", () => {
	function card(overrides: Partial<BoardCard> = {}): BoardCard {
		return {
			id: "task-1",
			title: "My Task",
			prompt: "do it",
			startInPlanMode: false,
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
