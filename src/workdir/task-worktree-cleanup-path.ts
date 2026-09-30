import { readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { areFileSystemPathsEqual, isFileSystemPathWithin } from "../core";
import { isNodeError } from "../fs/node-error";
import { getTaskWorktreesHomePath } from "../state/project-state-utils";
import { getGitCommonDir, getGitStdout } from "./git-utils";
import { assertTaskWorktreeRegistration } from "./task-worktree-identity";
import { getWorkdirFolderLabelForWorktreePath, normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import { pathExists } from "./task-worktree-symlinks";

/** Folder labels can outlive a project rename; task identity and exact Git registration own cleanup. */
export async function resolveTaskWorktreeCleanupPath(input: {
	repoPath: string;
	taskId: string;
	existingPath?: string;
	folderOnly?: boolean;
}): Promise<string> {
	const worktreesHome = getTaskWorktreesHomePath();
	const canonicalHome = await realpath(worktreesHome).catch((error: unknown) => {
		if (isNodeError(error, "ENOENT")) return worktreesHome;
		throw error;
	});
	const taskRoot = join(canonicalHome, normalizeTaskIdForWorktreePath(input.taskId));
	const fallback = join(taskRoot, getWorkdirFolderLabelForWorktreePath(input.repoPath));
	const candidates = new Set<string>();
	if (input.existingPath) {
		const path = await realpath(input.existingPath).catch((error: unknown) => {
			if (isNodeError(error, "ENOENT")) return resolve(input.existingPath as string);
			throw error;
		});
		if (!isFileSystemPathWithin(taskRoot, path) || areFileSystemPathsEqual(taskRoot, path)) {
			throw new Error("The task workspace is outside its managed folder. Its files were preserved.");
		}
		candidates.add(path);
	} else {
		try {
			for (const entry of await readdir(taskRoot, { withFileTypes: true })) {
				if (entry.isDirectory()) candidates.add(join(taskRoot, entry.name));
			}
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) throw error;
		}
		if (!input.folderOnly) {
			// Missing folders can still own a Git registration and keep their branch checked out.
			for (const line of (await getGitStdout(["worktree", "list", "--porcelain"], input.repoPath)).split("\n")) {
				if (!line.startsWith("worktree ")) continue;
				const path = line.slice("worktree ".length);
				if (areFileSystemPathsEqual(dirname(path), taskRoot)) candidates.add(path);
			}
		}
	}
	if (candidates.size > 1)
		throw new Error(
			"More than one task workspace exists. Its files were preserved; repair its registration before deleting it.",
		);
	const path = candidates.values().next().value as string | undefined;
	if (!path) return fallback;
	if (await pathExists(join(path, ".git"))) {
		await assertTaskWorktreeRegistration(path);
		if (
			!areFileSystemPathsEqual(
				await realpath(await getGitCommonDir(path)),
				await realpath(await getGitCommonDir(input.repoPath)),
			)
		) {
			throw new Error("The task workspace belongs to another project. Its files were preserved.");
		}
	}
	return path;
}
