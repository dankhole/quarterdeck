import { getCommitsBehindBase, runGit } from "../workdir";
import type { CachedPathWorktreeMetadata } from "./project-metadata-path-loader";
import type { ResolvedTaskWorktreePath } from "./project-metadata-paths";
import type { CachedTaskWorktreeMetadata } from "./project-metadata-task-cache";

export interface BaseRefWorktreeMetadata {
	baseRefCommit: string | null;
	originBaseRefCommit: string | null;
	hasUnmergedChanges: boolean | null;
	behindBaseCount: number | null;
}

export async function loadBaseRefWorktreeMetadata(
	pathInfo: ResolvedTaskWorktreePath,
	pathMetadata: CachedPathWorktreeMetadata,
	current: CachedTaskWorktreeMetadata | null,
): Promise<BaseRefWorktreeMetadata> {
	if (!pathMetadata.exists || !pathInfo.baseRef.trim()) {
		return {
			baseRefCommit: null,
			originBaseRefCommit: null,
			hasUnmergedChanges: null,
			behindBaseCount: null,
		};
	}

	const originRef = `origin/${pathInfo.baseRef}`;
	const [baseRefResult, originBaseRefResult] = await Promise.all([
		runGit(pathInfo.path, ["--no-optional-locks", "rev-parse", "--verify", pathInfo.baseRef], {
			timeoutClass: "metadata",
		}),
		runGit(pathInfo.path, ["--no-optional-locks", "rev-parse", "--verify", originRef], {
			timeoutClass: "metadata",
		}),
	]);
	const baseRefCommit = baseRefResult.ok ? baseRefResult.stdout : null;
	const originBaseRefCommit = originBaseRefResult.ok ? originBaseRefResult.stdout : null;
	if (
		current &&
		current.stateToken === pathMetadata.stateToken &&
		current.baseRefCommit === baseRefCommit &&
		current.originBaseRefCommit === originBaseRefCommit &&
		current.data.path === pathInfo.path &&
		current.data.baseRef === pathInfo.baseRef
	) {
		return {
			baseRefCommit,
			originBaseRefCommit,
			hasUnmergedChanges: current.data.hasUnmergedChanges,
			behindBaseCount: current.data.behindBaseCount,
		};
	}

	const [unmergedResult, treeDiffResult, behindBase] = await Promise.all([
		runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", `${pathInfo.baseRef}...HEAD`], {
			timeoutClass: "metadata",
		}),
		runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", pathInfo.baseRef, "HEAD"], {
			timeoutClass: "metadata",
		}),
		getCommitsBehindBase(pathInfo.path, pathInfo.baseRef),
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
	};
}
