import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { areFileSystemPathsEqual, type RuntimeBoardData } from "../core";
import { isNodeError } from "../fs/node-error";
import type { ProjectRelocationPlan } from "../state/project-relocation-journal";
import { runGit } from "./git-utils";
import { projectPathExists, relocateProjectPath } from "./project-relocation-paths";
import { assertTaskWorktreeRegistration } from "./task-worktree-identity";
import { getTaskWorktreePath } from "./task-worktree-lifecycle";
import { withTaskWorktreeSetupLock } from "./task-worktree-setup-lock";

function ownershipFailure(path: string): Error {
	return new Error(`Git worktree registration cannot be verified at "${path}". Task files were preserved.`);
}

async function readGitfileDirectory(path: string): Promise<string> {
	const content = (await readFile(join(path, ".git"), "utf8")).trim();
	if (!content.startsWith("gitdir: ")) throw ownershipFailure(path);
	return resolve(path, content.slice("gitdir: ".length));
}

/** Verify both links against the destination's actual admin entry before asking Git to repair either. */
async function verifyWorktree(
	worktree: ProjectRelocationPlan["worktrees"][number],
	oldRoot: string,
	newRoot: string,
	availableRoot: string,
): Promise<void> {
	const adminPath = join(availableRoot, ".git", "worktrees", worktree.gitAdminName);
	const availablePath = (await projectPathExists(worktree.path)) ? worktree.path : worktree.originalPath;
	try {
		const realAdmin = await realpath(adminPath);
		if (!areFileSystemPathsEqual(realAdmin, adminPath)) throw ownershipFailure(worktree.path);
		const gitDirectory = await readGitfileDirectory(availablePath);
		const allowedDirectories = [oldRoot, newRoot].map((root) =>
			join(root, ".git", "worktrees", worktree.gitAdminName),
		);
		if (!allowedDirectories.some((candidate) => areFileSystemPathsEqual(candidate, gitDirectory))) {
			throw ownershipFailure(worktree.path);
		}
		const backlink = resolve(adminPath, (await readFile(join(adminPath, "gitdir"), "utf8")).trim());
		if (
			!areFileSystemPathsEqual(backlink, join(worktree.path, ".git")) &&
			!areFileSystemPathsEqual(backlink, join(worktree.originalPath, ".git"))
		) {
			throw ownershipFailure(worktree.path);
		}
		const commonDirectory = resolve(adminPath, (await readFile(join(adminPath, "commondir"), "utf8")).trim());
		if (!areFileSystemPathsEqual(commonDirectory, join(availableRoot, ".git"))) throw ownershipFailure(worktree.path);
	} catch {
		throw ownershipFailure(worktree.path);
	}
}

export async function prepareProjectWorktrees(input: {
	oldPath: string;
	newPath: string;
	availablePath: string;
	board: RuntimeBoardData;
	folderOnly: boolean;
}): Promise<Pick<ProjectRelocationPlan, "worktrees" | "taskWorkingDirectories">> {
	const { oldPath, newPath, availablePath, board, folderOnly } = input;
	const worktrees: ProjectRelocationPlan["worktrees"] = [];
	const taskWorkingDirectories: Record<string, string> = {};
	const assignedPaths = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			const previousPath = card.workingDirectory;
			if (previousPath) taskWorkingDirectories[card.id] = relocateProjectPath(previousPath, oldPath, newPath);
			if (card.useWorktree === false || (previousPath && areFileSystemPathsEqual(previousPath, oldPath))) continue;
			const path = previousPath ?? getTaskWorktreePath(oldPath, card.id);
			const destination = relocateProjectPath(path, oldPath, newPath);
			const existing = (await projectPathExists(destination)) ? destination : path;
			if (!(await projectPathExists(existing))) continue;
			const physicalPath = await realpath(existing);
			assignedPaths.add(physicalPath);
			if (column.id !== "trash") {
				taskWorkingDirectories[card.id] = relocateProjectPath(physicalPath, oldPath, newPath);
			}
		}
	}
	const gitPath = join(availablePath, ".git");
	let gitExists = false;
	try {
		const gitEntry = await lstat(gitPath);
		gitExists = gitEntry.isDirectory() && !gitEntry.isSymbolicLink();
		if (!gitExists && (!folderOnly || assignedPaths.size > 0)) {
			throw new Error(
				"Folder relocation requires a main Git checkout. Linked project roots must be moved and repaired with Git first.",
			);
		}
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
		if (!folderOnly || assignedPaths.size > 0)
			throw new Error("The selected folder does not contain this project's Git repository.");
	}
	if (!gitExists) return { worktrees, taskWorkingDirectories };
	// Git's root repair also touches registered non-task worktrees. Verify every existing registration.
	let administrativeEntries: string[] = [];
	try {
		administrativeEntries = await readdir(join(gitPath, "worktrees"));
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
	}
	for (const gitAdminName of administrativeEntries) {
		const adminPath = join(gitPath, "worktrees", gitAdminName);
		if (await projectPathExists(join(adminPath, "modules"))) {
			throw new Error(
				"A task worktree has initialized submodules. Move and repair that Git layout manually before locating the project.",
			);
		}
		const backlink = resolve(adminPath, (await readFile(join(adminPath, "gitdir"), "utf8")).trim());
		const originalPath = dirname(backlink);
		const path = relocateProjectPath(originalPath, oldPath, newPath);
		if (!(await projectPathExists(path)) && !(await projectPathExists(originalPath))) continue;
		const worktree = { path, originalPath, gitAdminName };
		await verifyWorktree(worktree, oldPath, newPath, availablePath);
		worktrees.push(worktree);
	}
	for (const assignedPath of assignedPaths) {
		const destination = relocateProjectPath(assignedPath, oldPath, newPath);
		if (!worktrees.some((worktree) => areFileSystemPathsEqual(worktree.path, destination))) {
			throw ownershipFailure(assignedPath);
		}
	}
	return { worktrees, taskWorkingDirectories };
}

export async function repairProjectWorktrees(plan: ProjectRelocationPlan): Promise<void> {
	if (plan.worktrees.length === 0) return;
	await withTaskWorktreeSetupLock(plan.newPath, async () => {
		for (const worktree of plan.worktrees) {
			// Journal entries are server-owned, but fail closed on corrupt path components too.
			const name = relative(
				join(plan.newPath, ".git", "worktrees"),
				join(plan.newPath, ".git", "worktrees", worktree.gitAdminName),
			);
			if (!name || name.includes(sep) || name === "..") throw ownershipFailure(worktree.path);
			await verifyWorktree(worktree, plan.oldPath, plan.newPath, plan.newPath);
		}
		const repaired = await runGit(
			plan.newPath,
			["worktree", "repair", ...plan.worktrees.map((worktree) => worktree.path)],
			{
				timeoutClass: "userAction",
			},
		);
		if (!repaired.ok)
			throw new Error(
				"Git could not repair the relocated project's worktrees. Retry Locate folder to finish recovery.",
			);
		for (const worktree of plan.worktrees) await assertTaskWorktreeRegistration(worktree.path);
	});
}
