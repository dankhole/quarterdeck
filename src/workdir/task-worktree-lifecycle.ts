import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	areFileSystemPathsEqual,
	isFileSystemPathWithin,
	type RuntimeWorktreeDeleteResponse,
	type RuntimeWorktreeEnsureResponse,
} from "../core";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { removeDirectoryWithRetries } from "../fs/remove-path";
import { getTaskWorktreesHomePath, loadProjectContext } from "../state/project-state";
import { getGitCommandErrorMessage, getGitCommonDir, getGitStdout, readGitHeadInfo, runGit } from "./git-utils";
import { applyTaskPatch, captureTaskPatch, deleteTaskPatchFiles, findTaskPatch } from "./task-worktree-patch";
import { getWorkdirFolderLabelForWorktreePath, normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import { initializeSubmodulesIfNeeded, pathExists, syncIgnoredPathsIntoWorktree } from "./task-worktree-symlinks";

const QUARTERDECK_TASK_WORKTREE_SETUP_LOCKFILE_NAME = "quarterdeck-task-worktree-setup.lock";
const USER_GIT_ACTION_OPTIONS = { timeoutClass: "userAction" } as const;

function isMissingInitialCommitError(message: string): boolean {
	const normalizedMessage = message.trim().toLowerCase();
	if (!normalizedMessage) {
		return false;
	}

	return (
		normalizedMessage.includes("needed a single revision") ||
		normalizedMessage.includes("ambiguous argument") ||
		normalizedMessage.includes("unknown revision or path not in the working tree") ||
		normalizedMessage.includes("bad revision")
	);
}

function getWorktreeBaseRefResolutionErrorMessage(baseRef: string, errorMessage: string): string {
	if (!isMissingInitialCommitError(errorMessage)) {
		return errorMessage;
	}

	return `This repository does not have an initial commit yet, so Quarterdeck cannot create a task worktree from base ref "${baseRef}". Create an initial commit, then try moving the task to in progress again.`;
}

async function tryRunGit(cwd: string, args: string[]): Promise<string | null> {
	const result = await runGit(cwd, args, USER_GIT_ACTION_OPTIONS);
	return result.ok ? result.stdout : null;
}

async function getTaskWorktreeSetupLock(repoPath: string): Promise<LockRequest> {
	return {
		path: await getGitCommonDir(repoPath),
		type: "directory",
		lockfileName: QUARTERDECK_TASK_WORKTREE_SETUP_LOCKFILE_NAME,
	};
}

async function withTaskWorktreeSetupLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
	return await lockedFileSystem.withLock(await getTaskWorktreeSetupLock(repoPath), operation);
}

function getWorktreesRootPath(taskId: string): string {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	return join(getTaskWorktreesHomePath(), normalizedTaskId);
}

function getWorktreesBaseRootPath(): string {
	return getTaskWorktreesHomePath();
}

export function getTaskWorktreePath(repoPath: string, taskId: string): string {
	const projectLabel = getWorkdirFolderLabelForWorktreePath(repoPath);
	return join(getWorktreesRootPath(taskId), projectLabel);
}

async function removeTaskWorktreeInternal(repoPath: string, worktreePath: string): Promise<boolean> {
	const existed = await pathExists(worktreePath);
	const removeResult = await runGit(
		repoPath,
		["worktree", "remove", "--force", worktreePath],
		USER_GIT_ACTION_OPTIONS,
	);
	if (!removeResult.ok) {
		// If remove failed (e.g. worktree in bad state), prune stale registrations
		// so git doesn't think the path is still registered after we rm it.
		await runGit(repoPath, ["worktree", "prune"], USER_GIT_ACTION_OPTIONS);
	}
	await removeDirectoryWithRetries(worktreePath);
	return existed;
}

async function pruneEmptyParents(rootPath: string, fromPath: string): Promise<void> {
	let current = fromPath;
	while (isFileSystemPathWithin(rootPath, current) && !areFileSystemPathsEqual(rootPath, current)) {
		try {
			const entries = await readdir(current);
			if (entries.length > 0) {
				return;
			}
			await removeDirectoryWithRetries(current);
			current = dirname(current);
		} catch {
			return;
		}
	}
}

async function prepareNewTaskWorktree(repoPath: string, worktreePath: string): Promise<void> {
	try {
		await initializeSubmodulesIfNeeded(worktreePath);
		await syncIgnoredPathsIntoWorktree(repoPath, worktreePath);
	} catch (error) {
		await removeTaskWorktreeInternal(repoPath, worktreePath).catch(() => {});
		throw error;
	}
}

// Lifecycle orchestration and low-level compatibility callers must both pass
// `branch` for branch-aware checkout. The server reads it from durable board
// state; browser task actions do not supply workspace identity.
export async function ensureTaskWorktreeIfDoesntExist(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	branch?: string | null;
}): Promise<RuntimeWorktreeEnsureResponse> {
	try {
		const context = await loadProjectContext(options.cwd);
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const worktreePath = getTaskWorktreePath(context.repoPath, taskId);
		// Investigation note: ensure is called on every task start. The previous implementation
		// compared the worktree HEAD to the latest baseRef commit and recreated the worktree
		// when the base branch advanced, which could destroy valid task progress. Existing
		// worktrees are now treated as authoritative and only missing worktrees are created.
		const existingResult = await runGit(worktreePath, ["rev-parse", "HEAD"], USER_GIT_ACTION_OPTIONS);
		if (existingResult.ok && existingResult.stdout) {
			await syncIgnoredPathsIntoWorktree(context.repoPath, worktreePath);
			const headInfo = await readGitHeadInfo(worktreePath);
			return {
				ok: true,
				path: worktreePath,
				baseRef: options.baseRef.trim(),
				baseCommit: existingResult.stdout,
				branch: headInfo.branch,
			};
		}

		return await withTaskWorktreeSetupLock(context.repoPath, async () => {
			const lockedExistingCommit = await tryRunGit(worktreePath, ["rev-parse", "HEAD"]);
			if (lockedExistingCommit) {
				await syncIgnoredPathsIntoWorktree(context.repoPath, worktreePath);
				const headInfo = await readGitHeadInfo(worktreePath);
				return {
					ok: true,
					path: worktreePath,
					baseRef: options.baseRef.trim(),
					baseCommit: lockedExistingCommit,
					branch: headInfo.branch,
				};
			}

			const requestedBaseRef = options.baseRef.trim();
			if (!requestedBaseRef) {
				return {
					ok: false,
					path: null,
					baseRef: requestedBaseRef,
					baseCommit: null,
					error: "Task base branch is required for worktree creation.",
				};
			}

			const baseRefResult = await runGit(
				context.repoPath,
				["rev-parse", "--verify", `${requestedBaseRef}^{commit}`],
				USER_GIT_ACTION_OPTIONS,
			);
			if (!baseRefResult.ok) {
				return {
					ok: false,
					path: null,
					baseRef: requestedBaseRef,
					baseCommit: null,
					error: getWorktreeBaseRefResolutionErrorMessage(
						requestedBaseRef,
						baseRefResult.stderr || baseRefResult.output,
					),
				};
			}
			const requestedBaseCommit = baseRefResult.stdout;

			const storedPatch = await findTaskPatch(taskId);
			let baseCommit = storedPatch?.commit ?? requestedBaseCommit;
			let warning: string | undefined;

			if (await pathExists(worktreePath)) {
				await removeTaskWorktreeInternal(context.repoPath, worktreePath);
			}

			// Clean up stale worktree registrations that can linger when git
			// worktree remove fails or the process is interrupted. Without this,
			// git worktree add refuses with "missing but already registered".
			await runGit(context.repoPath, ["worktree", "prune"], USER_GIT_ACTION_OPTIONS);

			await mkdir(dirname(worktreePath), { recursive: true });

			// Branch-aware worktree creation: try named branch before falling back to detached HEAD.
			if (options.branch) {
				const branchCheck = await runGit(
					context.repoPath,
					["rev-parse", "--verify", `refs/heads/${options.branch}`],
					USER_GIT_ACTION_OPTIONS,
				);

				const finalizeBranchWorktree = async (
					resolvedBaseCommit: string,
					patchWarning: string,
				): Promise<RuntimeWorktreeEnsureResponse> => {
					let localWarning: string | undefined;
					await prepareNewTaskWorktree(context.repoPath, worktreePath);
					if (storedPatch) {
						try {
							await applyTaskPatch(storedPatch.path, worktreePath);
							await rm(storedPatch.path, { force: true });
						} catch {
							localWarning = patchWarning;
						}
					}
					return {
						ok: true,
						path: worktreePath,
						baseRef: requestedBaseRef,
						baseCommit: resolvedBaseCommit,
						branch: options.branch,
						warning: localWarning,
					};
				};

				if (branchCheck.ok) {
					// Branch EXISTS — checkout existing branch (resume path)
					const checkoutResult = await runGit(
						context.repoPath,
						["worktree", "add", worktreePath, options.branch],
						USER_GIT_ACTION_OPTIONS,
					);
					if (checkoutResult.ok) {
						return await finalizeBranchWorktree(
							branchCheck.stdout.trim(),
							"Saved task changes could not be reapplied onto the branch.",
						);
					}
					// Checkout failed (e.g., locked by another worktree) — clean up before fallback
					await removeTaskWorktreeInternal(context.repoPath, worktreePath);
					await runGit(context.repoPath, ["worktree", "prune"], USER_GIT_ACTION_OPTIONS);
					// fall through to detached
				} else {
					// Branch NOT exists — create new branch (creation path)
					const createResult = await runGit(
						context.repoPath,
						["worktree", "add", "-b", options.branch, worktreePath, baseCommit],
						USER_GIT_ACTION_OPTIONS,
					);
					if (createResult.ok) {
						return await finalizeBranchWorktree(
							baseCommit,
							"Saved task changes could not be reapplied onto the recreated branch.",
						);
					}
					// -b failed — clean up before fallback
					await removeTaskWorktreeInternal(context.repoPath, worktreePath);
					await runGit(context.repoPath, ["worktree", "prune"], USER_GIT_ACTION_OPTIONS);
					// fall through to detached
				}
			}

			const addResult = await runGit(
				context.repoPath,
				["worktree", "add", "--detach", worktreePath, baseCommit],
				USER_GIT_ACTION_OPTIONS,
			);
			if (!addResult.ok) {
				if (!storedPatch) {
					return {
						ok: false,
						path: null,
						baseRef: requestedBaseRef,
						baseCommit: null,
						error: addResult.stderr || addResult.output,
					};
				}

				baseCommit = requestedBaseCommit;
				warning =
					"Could not restore the saved task patch onto its original commit. Started from the task base ref instead.";
				await getGitStdout(
					["worktree", "add", "--detach", worktreePath, baseCommit],
					context.repoPath,
					USER_GIT_ACTION_OPTIONS,
				);
			}
			await prepareNewTaskWorktree(context.repoPath, worktreePath);

			if (storedPatch && baseCommit === storedPatch.commit) {
				try {
					await applyTaskPatch(storedPatch.path, worktreePath);
					await rm(storedPatch.path, { force: true });
				} catch (error) {
					warning = `Saved task changes could not be reapplied automatically. ${getGitCommandErrorMessage(error)}`;
				}
			}

			return {
				ok: true,
				path: worktreePath,
				baseRef: requestedBaseRef,
				baseCommit,
				branch: null,
				warning,
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			path: null,
			baseRef: options.baseRef.trim(),
			baseCommit: null,
			error: message,
		};
	}
}

/**
 * Archive a task workspace for Trash while preserving any saved restore patch.
 * Replaying this after the worktree is gone must not delete that patch.
 */
export async function archiveTaskWorktreeForTrash(options: {
	repoPath: string;
	taskId: string;
	operationId?: string;
}): Promise<RuntimeWorktreeDeleteResponse> {
	try {
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const rootPath = getWorktreesBaseRootPath();
		const worktreePath = getTaskWorktreePath(options.repoPath, taskId);
		if (!(await pathExists(worktreePath))) {
			await pruneEmptyParents(rootPath, dirname(worktreePath));
			return {
				ok: true,
				removed: false,
			};
		}

		try {
			await captureTaskPatch({
				repoPath: options.repoPath,
				taskId,
				worktreePath,
			});
		} catch {
			// Patch capture is best-effort. A corrupted or partially-created
			// worktree (e.g. plain directory, no git init) should still be removed.
		}
		const removed = await removeTaskWorktreeInternal(options.repoPath, worktreePath);
		await pruneEmptyParents(rootPath, dirname(worktreePath));

		return {
			ok: true,
			removed,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			removed: false,
			error: message,
		};
	}
}

/** Permanently remove a task workspace and every saved restore patch. */
export async function purgeTaskWorkspaceForDelete(options: {
	repoPath: string;
	taskId: string;
	operationId?: string;
}): Promise<RuntimeWorktreeDeleteResponse> {
	try {
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const rootPath = getWorktreesBaseRootPath();
		const worktreePath = getTaskWorktreePath(options.repoPath, taskId);
		const removed = (await pathExists(worktreePath))
			? await removeTaskWorktreeInternal(options.repoPath, worktreePath)
			: false;
		await deleteTaskPatchFiles(taskId);
		await pruneEmptyParents(rootPath, dirname(worktreePath));
		return { ok: true, removed };
	} catch (error) {
		return {
			ok: false,
			removed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** @deprecated Use the intent-specific archive or purge operation. */
export const deleteTaskWorktree = archiveTaskWorktreeForTrash;
