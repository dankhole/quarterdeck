import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeWorktreeDeleteResponse, RuntimeWorktreeEnsureResponse } from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath, loadWorkspaceContext } from "../state/workspace-state";
import { getGitCommandErrorMessage, getGitCommonDir, getGitStdout, readGitHeadInfo, runGit } from "./git-utils";
import { applyTaskPatch, captureTaskPatch, deleteTaskPatchFiles, findTaskPatch } from "./task-worktree-patch";
import { getWorkspaceFolderLabelForWorktreePath, normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import { initializeSubmodulesIfNeeded, pathExists, syncIgnoredPathsIntoWorktree } from "./task-worktree-symlinks";

const QUARTERDECK_TASK_WORKTREE_SETUP_LOCKFILE_NAME = "quarterdeck-task-worktree-setup.lock";

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
	const result = await runGit(cwd, args);
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
	const workspaceLabel = getWorkspaceFolderLabelForWorktreePath(repoPath);
	return join(getWorktreesRootPath(taskId), workspaceLabel);
}

async function removeTaskWorktreeInternal(repoPath: string, worktreePath: string): Promise<boolean> {
	const existed = await pathExists(worktreePath);
	const removeResult = await runGit(repoPath, ["worktree", "remove", "--force", worktreePath]);
	if (!removeResult.ok) {
		// If remove failed (e.g. worktree in bad state), prune stale registrations
		// so git doesn't think the path is still registered after we rm it.
		await runGit(repoPath, ["worktree", "prune"]);
	}
	await rm(worktreePath, { recursive: true, force: true });
	return existed;
}

async function pruneEmptyParents(rootPath: string, fromPath: string): Promise<void> {
	let current = fromPath;
	while (current.startsWith(rootPath) && current !== rootPath) {
		try {
			const entries = await readdir(current);
			if (entries.length > 0) {
				return;
			}
			await rm(current, { recursive: true, force: true });
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

// Two call sites reach this function — both must pass `branch` for branch-aware checkout:
//   1. startTaskSession (runtime-api.ts) — reads branch from persisted board state server-side
//   2. ensureWorktree tRPC endpoint (workspace-api.ts) — receives branch from the client request
export async function ensureTaskWorktreeIfDoesntExist(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	branch?: string | null;
}): Promise<RuntimeWorktreeEnsureResponse> {
	try {
		const context = await loadWorkspaceContext(options.cwd);
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const worktreePath = getTaskWorktreePath(context.repoPath, taskId);
		// Investigation note: ensure is called on every task start. The previous implementation
		// compared the worktree HEAD to the latest baseRef commit and recreated the worktree
		// when the base branch advanced, which could destroy valid task progress. Existing
		// worktrees are now treated as authoritative and only missing worktrees are created.
		const existingResult = await runGit(worktreePath, ["rev-parse", "HEAD"]);
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

			const baseRefResult = await runGit(context.repoPath, [
				"rev-parse",
				"--verify",
				`${requestedBaseRef}^{commit}`,
			]);
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
			await runGit(context.repoPath, ["worktree", "prune"]);

			await mkdir(dirname(worktreePath), { recursive: true });

			// Branch-aware worktree creation: try named branch before falling back to detached HEAD.
			if (options.branch) {
				const branchCheck = await runGit(context.repoPath, [
					"rev-parse",
					"--verify",
					`refs/heads/${options.branch}`,
				]);

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
					const checkoutResult = await runGit(context.repoPath, ["worktree", "add", worktreePath, options.branch]);
					if (checkoutResult.ok) {
						return await finalizeBranchWorktree(
							branchCheck.stdout.trim(),
							"Saved task changes could not be reapplied onto the branch.",
						);
					}
					// Checkout failed (e.g., locked by another worktree) — clean up before fallback
					await removeTaskWorktreeInternal(context.repoPath, worktreePath);
					await runGit(context.repoPath, ["worktree", "prune"]);
					// fall through to detached
				} else {
					// Branch NOT exists — create new branch (creation path)
					const createResult = await runGit(context.repoPath, [
						"worktree",
						"add",
						"-b",
						options.branch,
						worktreePath,
						baseCommit,
					]);
					if (createResult.ok) {
						return await finalizeBranchWorktree(
							baseCommit,
							"Saved task changes could not be reapplied onto the recreated branch.",
						);
					}
					// -b failed — clean up before fallback
					await removeTaskWorktreeInternal(context.repoPath, worktreePath);
					await runGit(context.repoPath, ["worktree", "prune"]);
					// fall through to detached
				}
			}

			const addResult = await runGit(context.repoPath, ["worktree", "add", "--detach", worktreePath, baseCommit]);
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
				await getGitStdout(["worktree", "add", "--detach", worktreePath, baseCommit], context.repoPath);
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

export async function deleteTaskWorktree(options: {
	repoPath: string;
	taskId: string;
}): Promise<RuntimeWorktreeDeleteResponse> {
	try {
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const rootPath = getWorktreesBaseRootPath();
		const worktreePath = getTaskWorktreePath(options.repoPath, taskId);
		if (!(await pathExists(worktreePath))) {
			await deleteTaskPatchFiles(taskId);
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
