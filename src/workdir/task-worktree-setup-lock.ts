import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getGitCommonDir } from "./git-utils";

/** Survives worktree deletion so removal and setup can safely share ownership. */
export async function withTaskWorktreeOperationLock<T>(
	repoPath: string,
	worktreePath: string,
	operation: () => Promise<T>,
): Promise<T> {
	const absolutePath = resolve(worktreePath);
	const identity = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
	const key = createHash("sha256").update(identity).digest("hex");
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
