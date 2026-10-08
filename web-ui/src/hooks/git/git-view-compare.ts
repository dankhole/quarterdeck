import type { RuntimeGitSyncSummary, RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import type { CardSelection, ReviewTaskWorktreeSnapshot } from "@/types";
import { resolveTaskGitState } from "@/utils/task-git-state";

export function resolveDefaultCompareSourceRef(input: {
	selectedCard: CardSelection | null;
	projectPath?: string | null;
	homeGitSummary: RuntimeGitSyncSummary | null;
	repositoryInfo: RuntimeTaskRepositoryInfoResponse | null;
	worktreeSnapshot: ReviewTaskWorktreeSnapshot | null;
}): string | null {
	if (!input.selectedCard) {
		return input.homeGitSummary?.currentBranch ?? null;
	}
	return resolveTaskGitState({
		projectRootPath: input.projectPath,
		card: input.selectedCard.card,
		repositoryInfo: input.repositoryInfo,
		worktreeSnapshot: input.worktreeSnapshot,
		homeGitSummary: input.homeGitSummary,
	}).branchLabel;
}
