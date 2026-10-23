import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { areFileSystemPathsEqual, isFileSystemPathWithin } from "../core";
import { getTaskWorktreesHomePath } from "../state/project-state-utils";
import { getGitCommonDir } from "../workdir/git-utils";
import { assertTaskWorktreeRegistration, isGitWorktreePathRegistered } from "../workdir/task-worktree-identity";
import { normalizeTaskIdForWorktreePath } from "../workdir/task-worktree-path";

/** Trust only the registered checkout owned by this task, never the managed home as a whole. */
export async function resolvePiWorktreeTrustScope(input: {
	taskId: string;
	cwd: string;
	projectPath?: string;
}): Promise<string | undefined> {
	if (!input.projectPath) return undefined;
	try {
		const taskId = normalizeTaskIdForWorktreePath(input.taskId);
		const [home, cwd, projectPath] = await Promise.all([
			realpath(getTaskWorktreesHomePath()),
			realpath(input.cwd),
			realpath(input.projectPath),
		]);
		// Keep taskRoot lexical under the physical home: resolving it separately
		// would let a task-folder symlink move this boundary outside managed storage.
		const taskRoot = join(home, taskId);
		if (
			areFileSystemPathsEqual(taskRoot, home) ||
			!isFileSystemPathWithin(taskRoot, cwd) ||
			areFileSystemPathsEqual(taskRoot, cwd) ||
			areFileSystemPathsEqual(projectPath, cwd)
		) {
			return undefined;
		}
		await assertTaskWorktreeRegistration(cwd);
		const [worktreeCommonDir, projectCommonDir] = await Promise.all([
			getGitCommonDir(cwd).then((path) => realpath(path)),
			getGitCommonDir(projectPath).then((path) => realpath(path)),
		]);
		if (
			!areFileSystemPathsEqual(worktreeCommonDir, projectCommonDir) ||
			!(await isGitWorktreePathRegistered(projectPath, cwd))
		) {
			return undefined;
		}
		return cwd;
	} catch {
		// Trust is optional launch assistance. Missing paths or uncertain ownership
		// leave Pi's normal trust resolution in charge without changing task files.
		return undefined;
	}
}
