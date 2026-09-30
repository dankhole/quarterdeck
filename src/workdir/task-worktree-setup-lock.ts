import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { isNodeError } from "../fs/node-error";
import { getGitCommonDir } from "./git-utils";

/** Resolve aliases even after removal has deleted the worktree and its task folder. */
async function canonicalOperationPath(worktreePath: string): Promise<string> {
	let existingPath = resolve(worktreePath);
	const missingSegments: string[] = [];
	while (true) {
		try {
			return join(await realpath(existingPath), ...missingSegments.reverse());
		} catch (error) {
			const parent = dirname(existingPath);
			if (!isNodeError(error, "ENOENT") || parent === existingPath) throw error;
			missingSegments.push(basename(existingPath));
			existingPath = parent;
		}
	}
}

/** Survives worktree deletion so removal and setup can safely share ownership. */
export async function withTaskWorktreeOperationLock<T>(
	repoPath: string,
	worktreePath: string,
	operation: () => Promise<T>,
): Promise<T> {
	const absolutePath = await canonicalOperationPath(worktreePath);
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
