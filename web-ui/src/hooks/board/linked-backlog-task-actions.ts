import type { TaskTrashWarningViewModel } from "@/components/task";
import type { RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";

/**
 * Map a dependency-add failure reason to a user-facing message.
 */
export function getDependencyAddErrorMessage(
	reason: "same_task" | "duplicate" | "trash_task" | "non_backlog" | string | undefined,
): string {
	switch (reason) {
		case "same_task":
			return "A task cannot be linked to itself.";
		case "duplicate":
			return "Link already exists.";
		case "trash_task":
			return "Links cannot include trashed tasks.";
		case "non_backlog":
			return "Links must include at least one Backlog task.";
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
	workspaceInfo: RuntimeTaskWorkspaceInfoResponse | null,
): TaskTrashWarningViewModel {
	return {
		taskTitle: card.title ?? "Untitled task",
		fileCount: changedFiles,
		workspaceInfo,
		isNonIsolated: card.useWorktree === false,
	};
}
