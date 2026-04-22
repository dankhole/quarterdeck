import type { RuntimeTaskSessionSummary, RuntimeTaskWorktreeInfoResponse } from "@/runtime/types";
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
	worktreeInfo?: RuntimeTaskWorktreeInfoResponse | null;
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
	const assignedPath =
		normalizeIdentityPath(input.worktreeInfo?.path) ??
		normalizeIdentityPath(input.worktreeSnapshot?.path) ??
		normalizeIdentityPath(input.card?.workingDirectory) ??
		(input.card?.useWorktree === false ? projectRootPath : null);
	const assignedHeadCommit = input.worktreeInfo?.headCommit ?? input.worktreeSnapshot?.headCommit ?? null;
	const assignedIsDetached = input.worktreeInfo?.isDetached ?? input.worktreeSnapshot?.isDetached ?? false;
	const persistedBranch = input.card?.branch ?? null;
	// Until worktree metadata arrives, the card's persisted branch is only a
	// provisional display hint. It is useful for continuity on just-created or
	// not-yet-probed tasks, but it is not authoritative git identity.
	const assignedBranch =
		input.worktreeInfo?.branch ?? input.worktreeSnapshot?.branch ?? (assignedIsDetached ? null : persistedBranch);
	const shortHeadCommit = assignedHeadCommit?.slice(0, 8) ?? null;
	const displayBranchLabel =
		input.worktreeInfo?.branch ??
		input.worktreeSnapshot?.branch ??
		(assignedIsDetached ? shortHeadCommit : (assignedBranch ?? persistedBranch ?? shortHeadCommit));
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
