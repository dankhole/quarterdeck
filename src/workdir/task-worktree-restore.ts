import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

import { areFileSystemPathsEqual, isFileSystemPathWithin } from "../core";
import { lockedFileSystem } from "../fs/locked-file-system";
import { isNodeError } from "../fs/node-error";
import { getRuntimeHomePath, getTaskWorktreesHomePath } from "../state/project-state";
import { getGitCommonDir, getGitStdout, runGit } from "./git-utils";
import { assertTaskWorktreeRegistration, getTaskWorktreePathKey } from "./task-worktree-identity";
import type { findTaskPatch } from "./task-worktree-patch";
import { normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import { initializeTaskWorktreeSetup } from "./task-worktree-setup";

const USER_GIT_ACTION_OPTIONS = { timeoutClass: "userAction" } as const;
type TaskPatch = NonNullable<Awaited<ReturnType<typeof findTaskPatch>>>;
interface RestoreIdentity {
	repoPath: string;
	taskId: string;
	worktreePath: string;
}

const patchRestoreSchema = z.object({
	version: z.literal(1),
	status: z.enum(["pending", "applying", "applied"]),
	taskId: z.string(),
	worktreePath: z.string(),
	commit: z.string().regex(/^[a-f\d]{40,64}$/u),
	patchHash: z.string().regex(/^[a-f\d]{64}$/u),
});

export async function taskWorktreeEntryExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return false;
		throw error;
	}
}

async function canonicalManagedPath(identity: RestoreIdentity): Promise<string> {
	const home = await realpath(getTaskWorktreesHomePath());
	const taskRoot = join(home, normalizeTaskIdForWorktreePath(identity.taskId));
	const path = await realpath(identity.worktreePath).catch((error: unknown) => {
		if (isNodeError(error, "ENOENT")) return resolve(identity.worktreePath);
		throw error;
	});
	if (!isFileSystemPathWithin(taskRoot, path) || areFileSystemPathsEqual(taskRoot, path)) {
		throw new Error("The task workspace is outside its managed folder. Its files were preserved.");
	}
	return path;
}

/** Only explicit legacy Trash restore may move an unregistered leftover folder aside. */
export async function preserveLegacyTaskWorktreeFiles(
	identity: RestoreIdentity & { restoreFromTrash?: boolean; hasRestoreSource: boolean },
): Promise<string | undefined> {
	if (await taskWorktreeEntryExists(join(identity.worktreePath, ".git"))) {
		await assertTaskWorktreeRegistration(identity.worktreePath);
		return undefined;
	}
	if (!identity.restoreFromTrash || !identity.hasRestoreSource) {
		await assertTaskWorktreeRegistration(identity.worktreePath);
	}
	const entry = await lstat(identity.worktreePath);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error("The task workspace is not a managed directory. Its files were preserved.");
	}
	const path = await canonicalManagedPath(identity);
	for (const line of (await getGitStdout(["worktree", "list", "--porcelain", "-z"], identity.repoPath)).split("\0")) {
		if (line.startsWith("worktree ") && areFileSystemPathsEqual(line.slice("worktree ".length), path)) {
			throw new Error("The task workspace still has a Git registration. Its files were preserved.");
		}
	}
	const recoveryRoot = join(
		getRuntimeHomePath(),
		"recovered-task-files",
		normalizeTaskIdForWorktreePath(identity.taskId),
	);
	await mkdir(recoveryRoot, { recursive: true });
	const recoveryDirectory = await mkdtemp(join(recoveryRoot, "restore-"));
	const recoveryPath = join(recoveryDirectory, basename(path));
	if (await taskWorktreeEntryExists(join(path, ".git"))) {
		throw new Error("The task workspace changed during recovery. Its files were preserved.");
	}
	// Rename retains the complete leftover folder, including ignored files. Never copy-and-delete it.
	await rename(path, recoveryPath);
	return `Existing task files were preserved at "${recoveryPath}" before restoring the task worktree.`;
}

function patchPath(identity: RestoreIdentity, commit: string): string {
	return join(
		getRuntimeHomePath(),
		"trashed-task-patches",
		`${normalizeTaskIdForWorktreePath(identity.taskId)}.${commit}.patch`,
	);
}

async function markerPath(identity: RestoreIdentity): Promise<string> {
	const key = await getTaskWorktreePathKey(identity.worktreePath);
	return join(await getGitCommonDir(identity.repoPath), "quarterdeck-task-restores", `${key}.json`);
}

async function readMarker(identity: RestoreIdentity): Promise<z.infer<typeof patchRestoreSchema> | null> {
	let text: string;
	try {
		text = await readFile(await markerPath(identity), "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
	const marker = patchRestoreSchema.parse(JSON.parse(text));
	if (marker.taskId !== identity.taskId || !areFileSystemPathsEqual(marker.worktreePath, identity.worktreePath)) {
		throw new Error("Saved task restore identity is invalid. Task files and the saved patch were preserved.");
	}
	return marker;
}

/** The intent lives outside the new checkout, closing the crash gap immediately after Git creates it. */
export async function beginTaskPatchRestore(identity: RestoreIdentity, patch: TaskPatch): Promise<void> {
	if (!areFileSystemPathsEqual(patch.path, patchPath(identity, patch.commit))) {
		throw new Error("Saved task patch identity is invalid. Task files were preserved.");
	}
	const patchHash = createHash("sha256")
		.update(await readFile(patch.path))
		.digest("hex");
	const marker = patchRestoreSchema.parse({
		version: 1,
		status: "pending",
		taskId: identity.taskId,
		worktreePath: identity.worktreePath,
		commit: patch.commit,
		patchHash,
	});
	const existing = await readMarker(identity);
	if (existing && (existing.commit !== marker.commit || existing.patchHash !== marker.patchHash)) {
		throw new Error("Saved task restore changed while it was pending. Task files and patches were preserved.");
	}
	if (!existing) await lockedFileSystem.writeJsonFileAtomic(await markerPath(identity), marker);
}

/** Used after a crash before creation; pending intent remains authoritative over newer archives or branches. */
export async function getPendingTaskPatchRestore(identity: RestoreIdentity): Promise<TaskPatch | null> {
	const marker = await readMarker(identity);
	if (!marker) return null;
	if (marker.status === "applied") {
		throw new Error("The restored task worktree is unavailable. Its saved restore intent was preserved.");
	}
	const path = patchPath(identity, marker.commit);
	if (
		createHash("sha256")
			.update(await readFile(path))
			.digest("hex") !== marker.patchHash
	) {
		throw new Error("Saved task patch changed during restore. Task files and the patch were preserved.");
	}
	return { path, commit: marker.commit };
}

/** A registered but incompletely restored checkout must never bypass patch restoration on retry. */
export async function completePendingTaskPatchRestore(identity: RestoreIdentity): Promise<boolean> {
	const marker = await readMarker(identity);
	if (!marker) return false;
	const path = patchPath(identity, marker.commit);
	if ((await getGitStdout(["rev-parse", "HEAD"], identity.worktreePath)) !== marker.commit) {
		throw new Error("The task HEAD changed during restore. Task files and the saved patch were preserved.");
	}
	// Record setup before restoration, and never let pending restore intent bless a failed Git checkout.
	await initializeTaskWorktreeSetup(identity.worktreePath);
	if (marker.status !== "applied") {
		if (
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex") !== marker.patchHash
		) {
			throw new Error("Saved task patch changed during restore. Task files and the patch were preserved.");
		}
		// Only a previously validated forward patch can have been applied before a crash.
		// Reverse-check alone can also match invalid patches that describe existing base files.
		const alreadyApplied =
			marker.status === "applying" &&
			(
				await runGit(
					identity.worktreePath,
					["apply", "--reverse", "--check", "--binary", path],
					USER_GIT_ACTION_OPTIONS,
				)
			).ok;
		if (!alreadyApplied) {
			const checked = await runGit(
				identity.worktreePath,
				["apply", "--check", "--binary", "--whitespace=nowarn", path],
				USER_GIT_ACTION_OPTIONS,
			);
			if (!checked.ok) {
				throw new Error(
					`Saved task changes could not be restored. Task files and the patch were preserved. ${checked.stderr || checked.error || checked.output}`,
				);
			}
			await lockedFileSystem.writeJsonFileAtomic(await markerPath(identity), { ...marker, status: "applying" });
			const applied = await runGit(
				identity.worktreePath,
				["apply", "--binary", "--whitespace=nowarn", path],
				USER_GIT_ACTION_OPTIONS,
			);
			if (!applied.ok) {
				throw new Error(
					`Saved task changes could not be restored. Task files and the patch were preserved. ${applied.stderr || applied.error || applied.output}`,
				);
			}
		}
		await lockedFileSystem.writeJsonFileAtomic(await markerPath(identity), { ...marker, status: "applied" });
	}
	await rm(path, { force: true });
	await rm(await markerPath(identity), { force: true });
	return true;
}

/** Permanent deletion also retires an incomplete legacy restore intent. */
export async function deleteTaskPatchRestore(identity: RestoreIdentity): Promise<void> {
	await rm(await markerPath(identity), { force: true });
}
