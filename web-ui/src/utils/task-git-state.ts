import type {
	RuntimeGitSyncSummary,
	RuntimeTaskRepositoryInfoResponse,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { BoardCard, ReviewTaskWorktreeSnapshot } from "@/types";
import { resolveTaskIdentity, type TaskIdentity } from "@/utils/task-identity";

export interface TaskGitState {
	identity: TaskIdentity;
	branch: string | null;
	branchLabel: string | null;
	changedFiles: number;
	additions: number;
	deletions: number;
	behindBaseCount: number | null;
	isDetached: boolean;
	hasRepositoryMetadata: boolean;
}

function hasAssignedGitMetadata(identity: TaskIdentity): boolean {
	return identity.assignedBranch !== null || identity.assignedHeadCommit !== null || identity.assignedIsDetached;
}

export function resolveTaskGitState(input: {
	projectRootPath?: string | null;
	card: Pick<BoardCard, "branch" | "useWorktree" | "workingDirectory">;
	repositoryInfo?: RuntimeTaskRepositoryInfoResponse | null;
	worktreeSnapshot?: ReviewTaskWorktreeSnapshot | null;
	homeGitSummary?: RuntimeGitSyncSummary | null;
	sessionSummary?: Pick<RuntimeTaskSessionSummary, "sessionLaunchPath"> | null;
}): TaskGitState {
	const identity = resolveTaskIdentity(input);
	if (identity.isAssignedShared) {
		const hasFreshAssignedMetadata = hasAssignedGitMetadata(identity);
		const sharedSnapshot = hasFreshAssignedMetadata ? input.worktreeSnapshot : null;
		return {
			identity,
			branch: hasFreshAssignedMetadata
				? identity.assignedBranch
				: (input.homeGitSummary?.currentBranch ?? identity.assignedBranch),
			branchLabel: hasFreshAssignedMetadata
				? identity.displayBranchLabel
				: input.homeGitSummary
					? (input.homeGitSummary.currentBranch ?? "detached HEAD")
					: identity.displayBranchLabel,
			changedFiles: sharedSnapshot?.changedFiles ?? input.homeGitSummary?.changedFiles ?? 0,
			additions: sharedSnapshot?.additions ?? input.homeGitSummary?.additions ?? 0,
			deletions: sharedSnapshot?.deletions ?? input.homeGitSummary?.deletions ?? 0,
			behindBaseCount: sharedSnapshot?.behindBaseCount ?? null,
			isDetached: hasFreshAssignedMetadata
				? identity.assignedIsDetached
				: input.homeGitSummary
					? input.homeGitSummary.currentBranch === null
					: identity.assignedIsDetached,
			hasRepositoryMetadata: Boolean(input.homeGitSummary || input.repositoryInfo || input.worktreeSnapshot),
		};
	}

	return {
		identity,
		branch: identity.assignedBranch,
		branchLabel: identity.displayBranchLabel,
		changedFiles: input.worktreeSnapshot?.changedFiles ?? 0,
		additions: input.worktreeSnapshot?.additions ?? 0,
		deletions: input.worktreeSnapshot?.deletions ?? 0,
		behindBaseCount: input.worktreeSnapshot?.behindBaseCount ?? null,
		isDetached: identity.assignedIsDetached,
		hasRepositoryMetadata: Boolean(input.repositoryInfo || input.worktreeSnapshot),
	};
}
