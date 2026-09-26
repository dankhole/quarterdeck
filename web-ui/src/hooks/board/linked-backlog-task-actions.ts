import type { TaskTrashWarningViewModel } from "@/components/task";
import type { RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";

/**
 * Map a dependency-add failure reason to a user-facing message.
 */
export function getDependencyAddErrorMessage(
	reason: "same_task" | "duplicate" | "trash_task" | "non_unstarted" | string | undefined,
): string {
	switch (reason) {
		case "same_task":
			return "A task cannot be linked to itself.";
		case "duplicate":
			return "Link already exists.";
		case "trash_task":
			return "Links cannot include trashed tasks.";
		case "non_unstarted":
			return "Links must include at least one unstarted task.";
		default:
			return "Could not create link.";
	}
}

/**
 * Build a trash warning view model for a task.
 */
export function buildTrashWarningViewModel(
	card: BoardCard,
	changedFiles: number,
	worktreeInfo: RuntimeTaskRepositoryInfoResponse | null,
): TaskTrashWarningViewModel {
	return {
		taskTitle: card.title ?? "Untitled task",
		fileCount: changedFiles,
		worktreeInfo,
		isNonIsolated: card.useWorktree === false,
	};
}
