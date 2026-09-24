import { areFileSystemPathsEqual } from "../core/path-comparison.js";
import { getCommitsBehindBase, runGit, validateGitRef } from "../workdir";
import type { CachedPathWorktreeMetadata } from "./project-metadata-path-loader";
import type { ResolvedTaskWorktreePath } from "./project-metadata-paths";
import type { CachedTaskWorktreeMetadata } from "./project-metadata-task-cache";

export interface BaseRefWorktreeMetadata {
	baseRefCommit: string | null;
	originBaseRefCommit: string | null;
	hasUnmergedChanges: boolean | null;
	behindBaseCount: number | null;
	behindRemoteBaseCount: number | null;
}

/** Remote selections compare with their matching local branch; local branches use origin. */
function resolveComparisonRefs(baseRef: string): { local: string; remote: string | null } {
	const remoteRef = baseRef.startsWith("refs/remotes/")
		? baseRef.slice("refs/remotes/".length)
		: baseRef.startsWith("origin/")
			? baseRef
			: null;
	if (remoteRef) {
		return {
			local: `refs/heads/${remoteRef.slice(remoteRef.indexOf("/") + 1)}`,
			remote: `refs/remotes/${remoteRef}`,
		};
	}
	const branch = baseRef.startsWith("refs/heads/") ? baseRef.slice("refs/heads/".length) : baseRef;
	return {
		local: baseRef.startsWith("refs/") ? baseRef : `refs/heads/${baseRef}`,
		remote: branch.startsWith("refs/") ? null : `refs/remotes/origin/${branch}`,
	};
}

export async function loadBaseRefWorktreeMetadata(
	pathInfo: ResolvedTaskWorktreePath,
	pathMetadata: CachedPathWorktreeMetadata,
	current: CachedTaskWorktreeMetadata | null,
): Promise<BaseRefWorktreeMetadata> {
	if (!pathMetadata.exists || !validateGitRef(pathInfo.baseRef)) {
		return {
			baseRefCommit: null,
			originBaseRefCommit: null,
			hasUnmergedChanges: null,
			behindBaseCount: null,
			behindRemoteBaseCount: null,
		};
	}

	const refs = resolveComparisonRefs(pathInfo.baseRef);
	const [baseRefResult, originBaseRefResult] = await Promise.all([
		runGit(pathInfo.path, ["--no-optional-locks", "rev-parse", "--verify", `${refs.local}^{commit}`], {
			timeoutClass: "metadata",
		}),
		refs.remote
			? runGit(pathInfo.path, ["--no-optional-locks", "rev-parse", "--verify", `${refs.remote}^{commit}`], {
					timeoutClass: "metadata",
				})
			: null,
	]);
	const baseRefCommit = baseRefResult.ok ? baseRefResult.stdout : null;
	const originBaseRefCommit = originBaseRefResult?.ok ? originBaseRefResult.stdout : null;
	if (
		current &&
		current.stateToken === pathMetadata.stateToken &&
		current.baseRefCommit === baseRefCommit &&
		current.originBaseRefCommit === originBaseRefCommit &&
		areFileSystemPathsEqual(current.data.path, pathInfo.path) &&
		current.data.baseRef === pathInfo.baseRef
	) {
		return {
			baseRefCommit,
			originBaseRefCommit,
			hasUnmergedChanges: current.data.hasUnmergedChanges,
			behindBaseCount: current.data.behindBaseCount,
			behindRemoteBaseCount: current.data.behindRemoteBaseCount,
		};
	}

	const [unmergedResult, treeDiffResult, behindBase, behindRemoteBase] = await Promise.all([
		runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", `${pathInfo.baseRef}...HEAD`], {
			timeoutClass: "metadata",
		}),
		runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", pathInfo.baseRef, "HEAD"], {
			timeoutClass: "metadata",
		}),
		baseRefCommit ? getCommitsBehindBase(pathInfo.path, baseRefCommit) : null,
		originBaseRefCommit ? getCommitsBehindBase(pathInfo.path, originBaseRefCommit) : null,
	]);
	return {
		baseRefCommit,
		originBaseRefCommit,
		hasUnmergedChanges:
			unmergedResult.exitCode === 0
				? false
				: unmergedResult.exitCode === 1
					? treeDiffResult.exitCode !== 0 // suppress when trees are identical (already landed)
					: null,
		behindBaseCount: behindBase?.behindCount ?? null,
		behindRemoteBaseCount: behindRemoteBase?.behindCount ?? null,
	};
}
