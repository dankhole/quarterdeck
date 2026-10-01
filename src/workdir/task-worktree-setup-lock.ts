import { join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getGitCommonDir } from "./git-utils";
import { getTaskWorktreePathKey } from "./task-worktree-identity";

/** Survives worktree deletion so removal and setup can safely share ownership. */
export async function withTaskWorktreeOperationLock<T>(
	repoPath: string,
	worktreePath: string,
	operation: () => Promise<T>,
): Promise<T> {
	const key = await getTaskWorktreePathKey(worktreePath);
	return await lockedFileSystem.withLock(
		{
			path: join(await getGitCommonDir(repoPath), `quarterdeck-worktree-${key}`),
			type: "file",
		},
		operation,
	);
}

/** Serialize Git registration and shared submodule metadata across a repository. */
export async function withTaskWorktreeSetupLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
	return await lockedFileSystem.withLock(
		{
			path: await getGitCommonDir(repoPath),
			type: "directory",
			lockfileName: "quarterdeck-task-worktree-setup.lock",
		},
		operation,
	);
}
