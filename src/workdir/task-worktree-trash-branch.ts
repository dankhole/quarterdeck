import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { areFileSystemPathsEqual } from "../core";
import { lockedFileSystem } from "../fs/locked-file-system";
import { isNodeError } from "../fs/node-error";
import { getGitCommonDir, getGitDir, getGitStdout, runGit } from "./git-utils";
import { resolveTaskWorktreeCleanupPath } from "./task-worktree-cleanup-path";
import {
	assertTaskWorktreeRegistration,
	getTaskWorktreePathKey,
	isGitWorktreePathRegistered,
} from "./task-worktree-identity";
import { withTaskWorktreeOperationLock, withTaskWorktreeSetupLock } from "./task-worktree-setup-lock";
import { pathExists } from "./task-worktree-symlinks";

const MARKER_NAME = "quarterdeck-trash-branch.json";
const markerSchema = z.object({
	version: z.literal(1),
	taskId: z.string(),
	pathKey: z.string(),
	branchRef: z.string().regex(/^refs\/heads\/[^\s\0]+$/u),
	commit: z.string().regex(/^[a-f0-9]{40,64}$/u),
});
type TrashBranchMarker = z.infer<typeof markerSchema>;

interface WorkspaceIdentity {
	repoPath: string;
	taskId: string;
	existingPath?: string;
}

async function readMarker(gitDir: string, taskId: string, worktreePath: string): Promise<TrashBranchMarker | null> {
	let text: string;
	try {
		text = await readFile(join(gitDir, MARKER_NAME), "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
	const marker = markerSchema.parse(JSON.parse(text));
	if (marker.taskId !== taskId || marker.pathKey !== (await getTaskWorktreePathKey(worktreePath))) {
		throw new Error("The saved Trash branch belongs to another workspace.");
	}
	return marker;
}

async function syncPath(path: string, directory = false): Promise<void> {
	if (directory && process.platform === "win32") return;
	const handle = await open(path, directory ? "r" : "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function assertNoGitOperation(gitDir: string): Promise<void> {
	// Git operations can be active without conflicts or an unmerged index.
	for (const entry of [
		"rebase-merge",
		"rebase-apply",
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"sequencer",
		"BISECT_START",
		"BISECT_LOG",
		"BISECT_NAMES",
		"AUTO_MERGE",
		"HEAD.lock",
		"index.lock",
	]) {
		try {
			await lstat(join(gitDir, entry));
		} catch (error) {
			if (isNodeError(error, "ENOENT")) continue;
			throw error;
		}
		throw new Error(
			`A Git operation is in progress (${entry}). Finish or abort it before changing the task's branch attachment.`,
		);
	}
}

async function readHead(worktreePath: string): Promise<{ commit: string; branchRef: string | null }> {
	const commit = await getGitStdout(["rev-parse", "--verify", "HEAD^{commit}"], worktreePath);
	const symbolic = await runGit(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
	if (!symbolic.ok && symbolic.exitCode !== 1) throw new Error(symbolic.error ?? "Cannot read task HEAD.");
	return { commit, branchRef: symbolic.ok ? symbolic.stdout : null };
}

async function readOperationBranch(path: string): Promise<string | null> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function assertBranchNotReserved(worktreePath: string, branchRef: string): Promise<void> {
	const commonDir = await realpath(await getGitCommonDir(worktreePath));
	const worktrees = await getGitStdout(["worktree", "list", "--porcelain", "-z"], worktreePath, { trimStdout: false });
	for (const record of worktrees.split("\0\0")) {
		const fields = record.split("\0");
		if (fields.includes(`branch ${branchRef}`))
			throw new Error("the original branch is checked out in another worktree");
		if (!fields.includes("detached")) continue;
		const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
		if (!path) throw new Error("a detached worktree's registration could not be read");
		// Native ref display omits rebase/bisect reservations. Read only Git's
		// operation-owned branch identity, from its validated administrative path.
		const gitDir = await realpath(await getGitDir(path));
		if (!areFileSystemPathsEqual(await realpath(await getGitCommonDir(path)), commonDir)) {
			throw new Error("another worktree's repository registration changed");
		}
		if (!areFileSystemPathsEqual(gitDir, commonDir)) await assertTaskWorktreeRegistration(path);
		for (const operation of ["rebase-merge", "rebase-apply"]) {
			if ((await readOperationBranch(join(gitDir, operation, "head-name"))) === branchRef) {
				throw new Error("the original branch is reserved by another worktree's rebase");
			}
		}
		const bisectStart = await readOperationBranch(join(gitDir, "BISECT_START"));
		if (bisectStart === branchRef || bisectStart === branchRef.slice("refs/heads/".length)) {
			throw new Error("the original branch is reserved by another worktree's bisect");
		}
	}
}

/** Caller holds the worktree operation and repository setup locks and has validated ownership. */
export async function detachTaskWorktreeBranchForTrash(options: {
	taskId: string;
	worktreePath: string;
}): Promise<void> {
	await assertTaskWorktreeRegistration(options.worktreePath);
	const gitDir = await getGitDir(options.worktreePath);
	await assertNoGitOperation(gitDir);
	const head = await readHead(options.worktreePath);
	const saved = await readMarker(gitDir, options.taskId, options.worktreePath);
	// Detached tasks have no invented origin. A pending marker survives a crash
	// after detach and must never be replaced by stale board branch metadata.
	if (!head.branchRef) return;
	if (!head.branchRef.startsWith("refs/heads/")) throw new Error("Task HEAD is not attached to a local branch.");
	if (saved && (saved.branchRef !== head.branchRef || saved.commit !== head.commit)) {
		throw new Error("The task checkout changed after its Trash branch was saved. Its branch was left attached.");
	}
	if (!saved) {
		await lockedFileSystem.writeJsonFileAtomic(
			join(gitDir, MARKER_NAME),
			{
				version: 1,
				taskId: options.taskId,
				pathKey: await getTaskWorktreePathKey(options.worktreePath),
				branchRef: head.branchRef,
				commit: head.commit,
			} satisfies TrashBranchMarker,
			{ mode: 0o600 },
		);
	}
	// Flush intent even on replay before Git can detach HEAD.
	await syncPath(join(gitDir, MARKER_NAME));
	await syncPath(gitDir, true);
	await assertTaskWorktreeRegistration(options.worktreePath);
	await assertNoGitOperation(gitDir);
	const current = await readHead(options.worktreePath);
	if (current.branchRef !== head.branchRef || current.commit !== head.commit) {
		throw new Error("The task checkout changed while saving its Trash branch. Its branch was left attached.");
	}
	// No checkout/reset: preserve index bytes, files, hooks, and the branch tip.
	// Git cannot verify HEAD's old symbolic target and replace that same ref in
	// one transaction. Existing ownership locks plus this recheck fence runtime
	// callers; old-OID CAS also rejects an external change to a different commit.
	const detached = await runGit(options.worktreePath, [
		"-c",
		`core.hooksPath=${devNull}`,
		"update-ref",
		"--no-deref",
		"-m",
		"Quarterdeck Trash",
		"HEAD",
		head.commit,
		head.commit,
	]);
	if (!detached.ok) throw new Error(detached.error ?? "Could not release the task branch.");
}

async function withWorkspaceLocks<T>(
	identity: WorkspaceIdentity,
	action: (path: string, gitDir: string) => Promise<T>,
): Promise<T | undefined> {
	const path = await resolveTaskWorktreeCleanupPath(identity);
	return await withTaskWorktreeOperationLock(identity.repoPath, path, () =>
		withTaskWorktreeSetupLock(identity.repoPath, async () => {
			if (
				!identity.existingPath &&
				!(await pathExists(path)) &&
				!(await isGitWorktreePathRegistered(identity.repoPath, path))
			)
				return undefined;
			await assertTaskWorktreeRegistration(path);
			return await action(path, await getGitDir(path));
		}),
	);
}

/** Explicit Restore only. Failure to reattach never blocks the retained workspace. */
export async function restoreTaskWorktreeBranchFromTrash(identity: WorkspaceIdentity): Promise<string | undefined> {
	try {
		return await withWorkspaceLocks(identity, async (path, gitDir) => {
			const marker = await readMarker(gitDir, identity.taskId, path);
			if (!marker) return undefined;
			await assertNoGitOperation(gitDir);
			const head = await readHead(path);
			if (head.commit !== marker.commit) throw new Error("the task checkout changed since Trash");
			if (head.branchRef === marker.branchRef) return undefined; // replay after successful attachment
			if (head.branchRef) throw new Error("the task is already attached to another branch");
			const branch = await runGit(path, ["show-ref", "--verify", "--hash", marker.branchRef]);
			if (!branch.ok) throw new Error("the original local branch no longer exists");
			if (branch.stdout !== marker.commit) throw new Error("the original branch moved since Trash");
			await assertBranchNotReserved(path, marker.branchRef);
			await assertNoGitOperation(gitDir);
			const current = await readHead(path);
			if (current.branchRef || current.commit !== marker.commit)
				throw new Error("the task checkout changed during restore");
			// A single Git transaction guards both tips. Older Git versions without
			// symref-update fail safely; never fall back to an unguarded symbolic-ref.
			// Explicit Restore is user work: admit it ahead of background Git without
			// occupying the slots reserved for foreground availability checks.
			const attached = await runGit(path, ["-c", `core.hooksPath=${devNull}`, "update-ref", "--stdin"], {
				priority: "userAction",
				stdin: `start\nverify ${marker.branchRef} ${marker.commit}\nsymref-update HEAD ${marker.branchRef} oid ${marker.commit}\nprepare\ncommit\n`,
			});
			if (!attached.ok)
				throw new Error(`Git could not safely reattach the branch (${attached.stderr || attached.error})`);
			return undefined;
		});
	} catch (error) {
		return `The task workspace was preserved, but its original branch could not be reattached: ${error instanceof Error ? error.message : String(error)}. Continue in the saved checkout or attach the branch manually.`;
	}
}

/** Consume origin only after explicit Restore has successfully resumed the task. */
export async function completeTaskWorktreeTrashRestore(identity: WorkspaceIdentity): Promise<void> {
	await withWorkspaceLocks(identity, async (path, gitDir) => {
		if (!(await readMarker(gitDir, identity.taskId, path))) return;
		await unlink(join(gitDir, MARKER_NAME));
		await syncPath(gitDir, true);
	});
}
