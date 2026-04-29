import type { RuntimeTaskRepositoryInfoResponse, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, ReviewTaskWorktreeSnapshot } from "@/types";

/**
 * Normalizes Quarterdeck's task identity vocabulary for UI consumers.
 *
 * Important distinction:
 * - `assigned*` values describe where the task is meant to live.
 * - `sessionLaunchPath` describes where the current agent session was started.
 *
 * Quarterdeck does not currently stream a continuously updated live cwd for task
 * agents, so UI code should avoid treating `sessionLaunchPath` as if it were a
 * real-time execution location.
 */
export interface TaskIdentity {
	projectRootPath: string | null;
	assignedPath: string | null;
	assignedBranch: string | null;
	assignedHeadCommit: string | null;
	assignedIsDetached: boolean;
	displayBranchLabel: string | null;
	isAssignedShared: boolean;
	sessionLaunchPath: string | null;
	isSessionLaunchShared: boolean;
	isSessionLaunchDiverged: boolean;
}

interface ResolveTaskIdentityInput {
	projectRootPath?: string | null;
	card?: Pick<BoardCard, "branch" | "useWorktree" | "workingDirectory"> | null;
	repositoryInfo?: RuntimeTaskRepositoryInfoResponse | null;
	worktreeSnapshot?: ReviewTaskWorktreeSnapshot | null;
	sessionSummary?: Pick<RuntimeTaskSessionSummary, "sessionLaunchPath"> | null;
}

function normalizeIdentityPath(path: string | null | undefined): string | null {
	const trimmed = path?.trim();
	if (!trimmed) {
		return null;
	}
	const normalized =
		/^[A-Za-z]:\\/u.test(trimmed) || trimmed.startsWith("\\\\") ? trimmed.replaceAll("\\", "/") : trimmed;
	return normalized.replace(/\/+$/u, "") || "/";
}

function areIdentityPathsEqual(left: string | null, right: string | null): boolean {
	return left !== null && right !== null && left === right;
}

export function resolveTaskIdentity(input: ResolveTaskIdentityInput): TaskIdentity {
	const projectRootPath = normalizeIdentityPath(input.projectRootPath ?? null);
	const cardWorkingDirectory = normalizeIdentityPath(input.card?.workingDirectory);
	const isExplicitlyShared = input.card?.useWorktree === false;
	const repositoryInfoPath = normalizeIdentityPath(input.repositoryInfo?.path);
	const worktreeSnapshotPath = normalizeIdentityPath(input.worktreeSnapshot?.path);
	const sharedMetadataPath = isExplicitlyShared
		? ([repositoryInfoPath, worktreeSnapshotPath].find(
				(path) => areIdentityPathsEqual(path, projectRootPath) || areIdentityPathsEqual(path, cardWorkingDirectory),
			) ?? null)
		: null;
	const metadataAssignedPath = isExplicitlyShared
		? (sharedMetadataPath ?? repositoryInfoPath ?? worktreeSnapshotPath)
		: (repositoryInfoPath ?? worktreeSnapshotPath);
	const hasSharedMetadata = sharedMetadataPath !== null;
	const shouldUseMetadata = !isExplicitlyShared || hasSharedMetadata;
	const assignedPath = isExplicitlyShared
		? (projectRootPath ?? cardWorkingDirectory ?? (hasSharedMetadata ? metadataAssignedPath : null))
		: (metadataAssignedPath ?? cardWorkingDirectory);
	const assignedHeadCommit = isExplicitlyShared
		? hasSharedMetadata
			? (input.repositoryInfo?.headCommit ?? input.worktreeSnapshot?.headCommit ?? null)
			: null
		: (input.repositoryInfo?.headCommit ?? input.worktreeSnapshot?.headCommit ?? null);
	const assignedIsDetached = isExplicitlyShared
		? hasSharedMetadata
			? (input.repositoryInfo?.isDetached ?? input.worktreeSnapshot?.isDetached ?? false)
			: false
		: (input.repositoryInfo?.isDetached ?? input.worktreeSnapshot?.isDetached ?? false);
	const persistedBranch = input.card?.branch ?? null;
	// Until worktree metadata arrives, the card's persisted branch is only a
	// provisional display hint. It is useful for continuity on just-created or
	// not-yet-probed tasks, but it is not authoritative git identity.
	const assignedBranch =
		!shouldUseMetadata || assignedIsDetached
			? null
			: (input.repositoryInfo?.branch ?? input.worktreeSnapshot?.branch ?? persistedBranch);
	const shortHeadCommit = assignedHeadCommit?.slice(0, 8) ?? null;
	const displayBranchLabel =
		isExplicitlyShared && !hasSharedMetadata
			? persistedBranch
			: (input.repositoryInfo?.branch ??
				input.worktreeSnapshot?.branch ??
				(assignedIsDetached ? shortHeadCommit : (assignedBranch ?? persistedBranch ?? shortHeadCommit)));
	// `sessionSummary.sessionLaunchPath` is the path the agent session was launched in.
	// Quarterdeck does not currently stream a continuously updated live cwd.
	const sessionLaunchPath = normalizeIdentityPath(input.sessionSummary?.sessionLaunchPath ?? null);
	const isAssignedShared =
		areIdentityPathsEqual(assignedPath, projectRootPath) ||
		(assignedPath === null && input.card?.useWorktree === false);
	const isSessionLaunchShared = areIdentityPathsEqual(sessionLaunchPath, projectRootPath);

	return {
		projectRootPath,
		assignedPath,
		assignedBranch,
		assignedHeadCommit,
		assignedIsDetached,
		displayBranchLabel,
		isAssignedShared,
		sessionLaunchPath,
		isSessionLaunchShared,
		isSessionLaunchDiverged:
			sessionLaunchPath !== null && assignedPath !== null && !areIdentityPathsEqual(sessionLaunchPath, assignedPath),
	};
}
