import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/project-state";
import { getGitStdout, runGit } from "./git-utils";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";

const QUARTERDECK_TRASHED_TASK_PATCHES_DIR_NAME = "trashed-task-patches";
const TASK_PATCH_FILE_SUFFIX = ".patch";
const USER_GIT_ACTION_OPTIONS = { timeoutClass: "userAction" } as const;

function getTaskPatchFilePrefix(taskId: string): string {
	return `${normalizeTaskIdForWorktreePath(taskId)}.`;
}

function getTrashedTaskPatchesRootPath(): string {
	return join(getRuntimeHomePath(), QUARTERDECK_TRASHED_TASK_PATCHES_DIR_NAME);
}

function parseTaskPatchCommit(taskId: string, filename: string): string | null {
	const prefix = getTaskPatchFilePrefix(taskId);
	if (!filename.startsWith(prefix) || !filename.endsWith(TASK_PATCH_FILE_SUFFIX)) {
		return null;
	}
	const commit = filename.slice(prefix.length, -TASK_PATCH_FILE_SUFFIX.length).trim();
	return commit.length > 0 ? commit : null;
}

async function listTaskPatchFiles(taskId: string): Promise<string[]> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	try {
		const entries = await readdir(patchesRootPath);
		return entries.filter((entry) => parseTaskPatchCommit(taskId, entry) !== null);
	} catch {
		return [];
	}
}

export async function deleteTaskPatchFiles(taskId: string): Promise<void> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	const filenames = await listTaskPatchFiles(taskId);
	await Promise.all(filenames.map((filename) => rm(join(patchesRootPath, filename), { force: true })));
}

export async function findTaskPatch(taskId: string): Promise<{ path: string; commit: string } | null> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	const filenames = await listTaskPatchFiles(taskId);
	const filename = filenames.sort().at(-1);
	if (!filename) {
		return null;
	}
	const commit = parseTaskPatchCommit(taskId, filename);
	if (!commit) {
		return null;
	}
	return {
		path: join(patchesRootPath, filename),
		commit,
	};
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

async function listUntrackedPaths(worktreePath: string): Promise<string[]> {
	// Original used runGitRaw (throws on failure).
	const output = await getGitStdout(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath, {
		trimStdout: false,
		...USER_GIT_ACTION_OPTIONS,
	});
	return output
		.split("\0")
		.map((path) => path.trim())
		.filter((path) => path.length > 0);
}

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

	const patchesRootPath = getTrashedTaskPatchesRootPath();
	await mkdir(patchesRootPath, { recursive: true });
	const patchPath = join(
		patchesRootPath,
		`${normalizeTaskIdForWorktreePath(options.taskId)}.${headCommit}${TASK_PATCH_FILE_SUFFIX}`,
	);
	await lockedFileSystem.writeTextFileAtomic(patchPath, patchChunks.join(""));
}

export async function applyTaskPatch(patchPath: string, worktreePath: string): Promise<void> {
	await getGitStdout(["apply", "--binary", "--whitespace=nowarn", patchPath], worktreePath, USER_GIT_ACTION_OPTIONS);
}
