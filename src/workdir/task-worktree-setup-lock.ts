import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { KeyedOperationCoordinator } from "../core/keyed-operation-coordinator";
import { lockedFileSystem } from "../fs/locked-file-system";
import { withRuntimeWriteOperation } from "../state/runtime-write-admission.js";
import { getGitCommonDir } from "./git-utils";
import { getTaskWorktreePathKey } from "./task-worktree-identity";

const repositorySetupOperations = new KeyedOperationCoordinator();

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
	const commonDirectory = await realpath(await getGitCommonDir(repoPath));
	const key = process.platform === "win32" ? commonDirectory.toLowerCase() : commonDirectory;
	// A slow removal can outlast the filesystem lock's retry budget. Queue this
	// runtime's owners before acquiring that lock, which still fences other processes.
	return await withRuntimeWriteOperation([commonDirectory], () =>
		repositorySetupOperations.run(key, () =>
			lockedFileSystem.withLock(
				{
					path: commonDirectory,
					type: "directory",
					lockfileName: "quarterdeck-task-worktree-setup.lock",
				},
				operation,
			),
		),
	);
}
