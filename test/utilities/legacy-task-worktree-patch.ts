import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { getRuntimeHomePath } from "../../src/state/project-state";
import { getGitStdout, runGit, splitNullSeparatedGitOutput } from "../../src/workdir/git-utils";
import { deleteTaskPatchFiles } from "../../src/workdir/task-worktree-patch";
import { normalizeTaskIdForWorktreePath } from "../../src/workdir/task-worktree-path";

const USER_GIT_ACTION_OPTIONS = { timeoutClass: "userAction" } as const;

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

async function listUntrackedPaths(worktreePath: string): Promise<string[]> {
	const output = await getGitStdout(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath, {
		trimStdout: false,
		...USER_GIT_ACTION_OPTIONS,
	});
	return splitNullSeparatedGitOutput(output);
}

/** Reproduce the patch archives written by older Quarterdeck versions for restore fixtures. */
export async function captureTaskPatch(options: {
	repoPath: string;
	taskId: string;
	worktreePath: string;
}): Promise<void> {
	const headCommit = await getGitStdout(
		["rev-parse", "--verify", "HEAD"],
		options.worktreePath,
		USER_GIT_ACTION_OPTIONS,
	);

	const trackedResult = await runGit(options.worktreePath, ["diff", "--binary", "HEAD", "--"], {
		trimStdout: false,
		...USER_GIT_ACTION_OPTIONS,
	});
	if (!trackedResult.ok && trackedResult.exitCode !== 1) {
		throw new Error(trackedResult.error ?? "Failed to capture tracked diff.");
	}
	const trackedPatch = trackedResult.stdout;
	const patchChunks = trackedPatch.trim().length > 0 ? [ensureTrailingNewline(trackedPatch)] : [];

	for (const relativePath of await listUntrackedPaths(options.worktreePath)) {
		const untrackedResult = await runGit(
			options.worktreePath,
			["diff", "--binary", "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", relativePath],
			{ trimStdout: false, ...USER_GIT_ACTION_OPTIONS },
		);
		if (!untrackedResult.ok && untrackedResult.exitCode !== 1) {
			throw new Error(untrackedResult.error ?? "Failed to capture untracked diff.");
		}
		const untrackedPatch = untrackedResult.stdout;
		if (untrackedPatch.trim().length > 0) {
			patchChunks.push(ensureTrailingNewline(untrackedPatch));
		}
	}

	await deleteTaskPatchFiles(options.taskId);
	if (patchChunks.length === 0) {
		return;
	}

	const patchesRootPath = join(getRuntimeHomePath(), "trashed-task-patches");
	await mkdir(patchesRootPath, { recursive: true });
	const patchPath = join(patchesRootPath, `${normalizeTaskIdForWorktreePath(options.taskId)}.${headCommit}.patch`);
	await lockedFileSystem.writeTextFileAtomic(patchPath, patchChunks.join(""));
}
