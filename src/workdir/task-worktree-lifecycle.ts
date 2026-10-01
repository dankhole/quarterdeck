import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadRuntimeConfig } from "../config/runtime-config";
import {
	areFileSystemPathsEqual,
	isFileSystemPathWithin,
	type RuntimeWorktreeDeleteResponse,
	type RuntimeWorktreeEnsureResponse,
} from "../core";
import { removeDirectoryWithRetries } from "../fs/remove-path";
import { getTaskWorktreesHomePath, loadProjectContext } from "../state/project-state";
import { readGitHeadInfo, runGit } from "./git-utils";
import { resolveTaskWorktreeCleanupPath } from "./task-worktree-cleanup-path";
import { assertTaskWorktreeRegistration } from "./task-worktree-identity";
import { deleteTaskPatchFiles, findTaskPatch } from "./task-worktree-patch";
import { getWorkdirFolderLabelForWorktreePath, normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import {
	beginTaskPatchRestore,
	completePendingTaskPatchRestore,
	deleteTaskPatchRestore,
	getPendingTaskPatchRestore,
	preserveLegacyTaskWorktreeFiles,
	taskWorktreeEntryExists,
} from "./task-worktree-restore";
import {
	finishTaskWorktreeSetup,
	initializeTaskWorktreeSetup,
	markTaskWorktreeCheckoutFailed,
	type WorktreeSetupProgress,
} from "./task-worktree-setup";
import { withTaskWorktreeOperationLock, withTaskWorktreeSetupLock } from "./task-worktree-setup-lock";
import { pathExists } from "./task-worktree-symlinks";

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
	if (await taskWorktreeEntryExists(join(worktreePath, ".git"))) {
		await assertTaskWorktreeRegistration(worktreePath);
	}
	const removeResult = await runGit(
		repoPath,
		["worktree", "remove", "--force", worktreePath],
		USER_GIT_ACTION_OPTIONS,
	);
	await removeDirectoryWithRetries(worktreePath);
	if (!removeResult.ok) {
		// Git only prunes missing worktrees. Remove the directory first so a
		// failed Git removal cannot leave the task's branch checked out forever.
		const pruned = await runGit(repoPath, ["worktree", "prune"], USER_GIT_ACTION_OPTIONS);
		if (!pruned.ok) {
			throw new Error(pruned.stderr || pruned.error || "Could not prune task worktree registration.");
		}
	}
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

// Lifecycle orchestration and low-level compatibility callers must both pass
// `branch` for branch-aware checkout. The server reads it from durable board
// state; browser task actions do not supply workspace identity.
export async function ensureTaskWorktreeIfDoesntExist(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	branch?: string | null;
	retrySetup?: boolean;
	onSetupProgress?: WorktreeSetupProgress;
	/** Server-owned persisted path; never a browser-supplied checkout target. */
	existingPath?: string;
	/** Internal authorization from lifecycle restore of a legacy Trash card without a durable path. */
	restoreFromTrash?: boolean;
}): Promise<RuntimeWorktreeEnsureResponse> {
	let recoveryWarning: string | undefined;
	try {
		const context = await loadProjectContext(options.cwd);
		if (context.folderOnly && !options.existingPath)
			throw new Error("Folder projects run tasks in place without Git worktrees.");
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const worktreePath = options.existingPath ?? getTaskWorktreePath(context.repoPath, taskId);
		if (options.existingPath && !(await pathExists(worktreePath))) {
			throw new Error("The existing task worktree is unavailable. Task files were preserved.");
		}
		// Investigation note: ensure is called on every task start. The previous implementation
		// compared the worktree HEAD to the latest baseRef commit and recreated the worktree
		// when the base branch advanced, which could destroy valid task progress. Existing
		// worktrees are now treated as authoritative and only missing worktrees are created.
		let newWorktree = false;
		const result = await withTaskWorktreeSetupLock<RuntimeWorktreeEnsureResponse>(context.repoPath, async () => {
			const requestedBaseRef = options.baseRef.trim();
			const restoreIdentity = { repoPath: context.repoPath, taskId, worktreePath };
			let warning: string | undefined;
			if (await taskWorktreeEntryExists(worktreePath)) {
				if (await taskWorktreeEntryExists(join(worktreePath, ".git"))) {
					await assertTaskWorktreeRegistration(worktreePath);
				} else {
					const hasRestoreSource =
						Boolean(await findTaskPatch(taskId)) ||
						Boolean(
							options.branch &&
								(await tryRunGit(context.repoPath, [
									"rev-parse",
									"--verify",
									`refs/heads/${options.branch}^{commit}`,
								])),
						);
					warning = await preserveLegacyTaskWorktreeFiles({
						...restoreIdentity,
						restoreFromTrash: options.restoreFromTrash,
						hasRestoreSource,
					});
					recoveryWarning = warning;
				}
				if (await taskWorktreeEntryExists(worktreePath)) {
					newWorktree = await completePendingTaskPatchRestore(restoreIdentity);
					const lockedExistingCommit = await tryRunGit(worktreePath, ["rev-parse", "HEAD"]);
					if (!lockedExistingCommit) {
						throw new Error(
							`Cannot read the existing task worktree HEAD at "${worktreePath}". Task files were preserved.`,
						);
					}
					const headInfo = await readGitHeadInfo(worktreePath);
					return {
						ok: true,
						path: worktreePath,
						baseRef: requestedBaseRef,
						baseCommit: lockedExistingCommit,
						branch: headInfo.branch,
					};
				}
			}

			if (!requestedBaseRef) {
				return {
					ok: false,
					path: null,
					baseRef: requestedBaseRef,
					baseCommit: null,
					error: ["Task base branch is required for worktree creation.", recoveryWarning]
						.filter(Boolean)
						.join(" "),
				};
			}

			const storedPatch = (await getPendingTaskPatchRestore(restoreIdentity)) ?? (await findTaskPatch(taskId));
			const branchCommit = options.branch
				? await tryRunGit(context.repoPath, ["rev-parse", "--verify", `refs/heads/${options.branch}^{commit}`])
				: null;
			if (options.restoreFromTrash && !storedPatch && !branchCommit) {
				throw new Error(
					"The archived task has no surviving task branch or saved patch. Restore was stopped to preserve its remaining files.",
				);
			}
			const baseRef = storedPatch?.commit ?? branchCommit ?? requestedBaseRef;
			const baseRefResult = await runGit(
				context.repoPath,
				["rev-parse", "--verify", `${baseRef}^{commit}`],
				USER_GIT_ACTION_OPTIONS,
			);
			if (!baseRefResult.ok) {
				throw new Error(
					storedPatch
						? "The saved task commit is unavailable. The saved patch and task files were preserved."
						: getWorktreeBaseRefResolutionErrorMessage(
								requestedBaseRef,
								baseRefResult.stderr || baseRefResult.output,
							),
				);
			}
			const baseCommit = baseRefResult.stdout;
			if (storedPatch) await beginTaskPatchRestore(restoreIdentity, storedPatch);

			// Clean up stale worktree registrations that can linger when git
			// worktree remove fails or the process is interrupted. Without this,
			// git worktree add refuses with "missing but already registered".
			await runGit(context.repoPath, ["worktree", "prune"], USER_GIT_ACTION_OPTIONS);

			await mkdir(dirname(worktreePath), { recursive: true });

			let branch: string | null = null;
			if (options.branch && (!storedPatch || !branchCommit || branchCommit === baseCommit)) {
				const branchArgs = branchCommit
					? ["worktree", "add", worktreePath, options.branch]
					: ["worktree", "add", "-b", options.branch, worktreePath, baseCommit];
				const added = await runGit(context.repoPath, branchArgs, USER_GIT_ACTION_OPTIONS);
				if (added.ok) branch = options.branch;
				else if (await taskWorktreeEntryExists(worktreePath)) {
					if (await taskWorktreeEntryExists(join(worktreePath, ".git"))) {
						await markTaskWorktreeCheckoutFailed(worktreePath);
					}
					throw new Error(
						`Worktree creation failed after its folder appeared. Task files were preserved. ${added.stderr || added.output}`,
					);
				}
			} else if (options.branch && storedPatch) {
				warning = [
					warning,
					"The task branch changed after archival. Saved task changes were restored at their original commit in a detached worktree.",
				]
					.filter(Boolean)
					.join(" ");
			}
			if (!branch) {
				if (await taskWorktreeEntryExists(worktreePath)) {
					throw new Error("A task folder appeared during worktree creation. Its files were preserved.");
				}
				const added = await runGit(
					context.repoPath,
					["worktree", "add", "--detach", worktreePath, baseCommit],
					USER_GIT_ACTION_OPTIONS,
				);
				if (!added.ok) {
					if (await taskWorktreeEntryExists(join(worktreePath, ".git"))) {
						await markTaskWorktreeCheckoutFailed(worktreePath);
					}
					throw new Error(added.stderr || added.error || added.output || "Task worktree creation failed.");
				}
			}
			if (storedPatch) await completePendingTaskPatchRestore(restoreIdentity);
			else await initializeTaskWorktreeSetup(worktreePath);
			newWorktree = true;

			return {
				ok: true,
				path: worktreePath,
				baseRef: requestedBaseRef,
				baseCommit,
				branch,
				warning,
			};
		});
		if (result.ok) {
			const config = await loadRuntimeConfig(context.projectId);
			await finishTaskWorktreeSetup({
				repoPath: context.repoPath,
				worktreePath,
				script: config.worktreeSetupScript,
				newWorktree,
				retrySetup: options.retrySetup,
				onSetupProgress: options.onSetupProgress,
			});
		}
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			path: null,
			baseRef: options.baseRef.trim(),
			baseCommit: null,
			error: [message, recoveryWarning].filter(Boolean).join(" "),
		};
	}
}

/**
 * Compatibility Trash operation: retain the complete workspace and every legacy restore patch.
 * Permanent deletion is the only operation that removes task files.
 */
export async function archiveTaskWorktreeForTrash(options: {
	repoPath: string;
	taskId: string;
	operationId?: string;
	folderOnly?: boolean;
	/** Server-owned persisted task workspace, which may retain an earlier project folder label. */
	existingPath?: string;
}): Promise<RuntimeWorktreeDeleteResponse> {
	try {
		const worktreePath = await resolveTaskWorktreeCleanupPath(options);
		if (!(await pathExists(worktreePath)) && options.folderOnly) {
			return { ok: true, removed: false };
		}
		return await withTaskWorktreeOperationLock(options.repoPath, worktreePath, async () =>
			withTaskWorktreeSetupLock(options.repoPath, async () => {
				if (await taskWorktreeEntryExists(worktreePath)) {
					if (!options.folderOnly || (await taskWorktreeEntryExists(join(worktreePath, ".git")))) {
						await assertTaskWorktreeRegistration(worktreePath);
					}
				}
				return { ok: true, removed: false };
			}),
		);
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
	folderOnly?: boolean;
	/** Server-owned persisted task workspace, which may retain an earlier project folder label. */
	existingPath?: string;
}): Promise<RuntimeWorktreeDeleteResponse> {
	try {
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const rootPath = getWorktreesBaseRootPath();
		const worktreePath = await resolveTaskWorktreeCleanupPath(options);
		if (!(await pathExists(worktreePath)) && options.folderOnly) {
			await deleteTaskPatchFiles(taskId);
			return { ok: true, removed: false };
		}
		return await withTaskWorktreeOperationLock(options.repoPath, worktreePath, async () =>
			withTaskWorktreeSetupLock(options.repoPath, async () => {
				const removed = await removeTaskWorktreeInternal(options.repoPath, worktreePath);
				await deleteTaskPatchFiles(taskId);
				if (!options.folderOnly) await deleteTaskPatchRestore({ repoPath: options.repoPath, taskId, worktreePath });
				await pruneEmptyParents(rootPath, dirname(worktreePath));
				return { ok: true, removed };
			}),
		);
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
