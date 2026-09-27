import type { TaskTrashWarningViewModel } from "@/components/task";
import type { RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";

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
