import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { join, resolve } from "node:path";

import { areFileSystemPathsEqual, isFileSystemPathWithin, type RuntimeBoardData } from "../core";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	type ProjectRelocationPlan,
	readProjectRelocationJournal,
	writeProjectRelocationJournal,
} from "../state/project-relocation-journal";
import type { ProjectDirectoryIdentity } from "../state/project-state-index";
import { getProjectDirectoryPath, isUnderWorktreesHome } from "../state/project-state-utils";
import { runGit } from "./git-utils";
import {
	canonicalProjectDirectory,
	isCaseOnlyProjectRename,
	projectPathExists,
	readProjectDirectoryIdentity,
	resolveRenamedProjectPath,
	sameProjectDirectoryIdentity,
} from "./project-relocation-paths";
import { prepareProjectWorktrees, repairProjectWorktrees } from "./project-relocation-worktrees";

export type { ProjectRelocationJournal, ProjectRelocationPlan } from "../state/project-relocation-journal";
export {
	finalizeProjectRelocation,
	getProjectRelocationJournalPath,
	readProjectRelocationJournal,
} from "../state/project-relocation-journal";
export { readProjectDirectoryIdentity, relocateProjectPath } from "./project-relocation-paths";

/** This lock stays outside the moved folder and is distinct from the board transaction lock. */
export async function withProjectRelocationLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
	return await lockedFileSystem.withLock(
		{ path: join(getProjectDirectoryPath(projectId), "relocation-operation") },
		operation,
	);
}

export interface PrepareProjectRelocationInput {
	operationId?: string;
	projectId: string;
	oldPath: string;
	destination: { kind: "locate"; path: string } | { kind: "rename"; folderName: string };
	folderOnly?: boolean;
	directoryIdentity?: ProjectDirectoryIdentity;
	projects: ReadonlyArray<{ projectId: string; repoPath: string }>;
	board: RuntimeBoardData;
}

/** Read-only validation; repeat under project exclusion before stopping any process. */
export async function prepareProjectRelocation(input: PrepareProjectRelocationInput): Promise<ProjectRelocationPlan> {
	const oldPath = resolve(input.oldPath);
	const kind = input.destination.kind;
	const newPath =
		input.destination.kind === "rename"
			? resolveRenamedProjectPath(oldPath, input.destination.folderName)
			: await canonicalProjectDirectory(input.destination.path);
	if (isUnderWorktreesHome(newPath))
		throw new Error("A Quarterdeck task worktree cannot be used as a project folder.");
	if (
		input.projects.some(
			(project) => project.projectId !== input.projectId && areFileSystemPathsEqual(project.repoPath, newPath),
		)
	) {
		throw new Error("That folder is already registered as another project.");
	}
	if (
		kind === "rename" &&
		input.projects.some(
			(project) => project.projectId !== input.projectId && isFileSystemPathWithin(oldPath, project.repoPath),
		)
	) {
		throw new Error(
			"This folder contains another registered project. Move it outside Quarterdeck, then locate each project separately.",
		);
	}
	if (kind === "locate" && !areFileSystemPathsEqual(oldPath, newPath) && (await projectPathExists(oldPath))) {
		throw new Error("The original project folder still exists. Use Rename folder on disk to rename it.");
	}
	const availablePath = kind === "rename" ? await canonicalProjectDirectory(oldPath) : newPath;
	if (kind === "rename" && !areFileSystemPathsEqual(availablePath, oldPath)) {
		throw new Error("The project folder now resolves to a different path. Locate its current folder first.");
	}
	const directoryIdentity = await readProjectDirectoryIdentity(availablePath);
	if (kind === "rename" && (await projectPathExists(newPath))) {
		if (
			!isCaseOnlyProjectRename(oldPath, newPath) ||
			!sameProjectDirectoryIdentity(directoryIdentity, await readProjectDirectoryIdentity(newPath))
		) {
			throw new Error("A folder or file already exists with that name. Choose another name.");
		}
	}
	// Explicit Locate confirms the selected folder after remounts or cross-volume moves change its identity.
	// Capture that identity in the plan so later effects and recovery still detect a replaced destination.
	if (
		kind === "rename" &&
		input.directoryIdentity &&
		!sameProjectDirectoryIdentity(input.directoryIdentity, directoryIdentity)
	) {
		throw new Error("The selected folder does not match the original project's directory identity.");
	}
	if (!input.folderOnly) {
		const root = await runGit(availablePath, ["rev-parse", "--show-toplevel"]);
		if (!root.ok || !areFileSystemPathsEqual(root.stdout.trim(), availablePath)) {
			throw new Error("Select the Git repository's root folder.");
		}
	}
	const worktreePlan = await prepareProjectWorktrees({
		oldPath,
		newPath,
		availablePath,
		board: input.board,
		folderOnly: input.folderOnly ?? false,
	});
	return {
		operationId: input.operationId ?? randomUUID(),
		projectId: input.projectId,
		oldPath,
		newPath,
		kind,
		folderOnly: input.folderOnly ?? false,
		directoryIdentity,
		...worktreePlan,
	};
}

async function completeFilesystemRelocation(plan: ProjectRelocationPlan): Promise<void> {
	const destinationExists = await projectPathExists(plan.newPath);
	const caseOnly = plan.kind === "rename" && isCaseOnlyProjectRename(plan.oldPath, plan.newPath);
	if (!destinationExists) {
		if (plan.kind !== "rename")
			throw new Error("The selected project folder is unavailable. Locate it again to finish recovery.");
		const sourceIdentity = await readProjectDirectoryIdentity(plan.oldPath);
		if (!sameProjectDirectoryIdentity(sourceIdentity, plan.directoryIdentity)) {
			throw new Error("The original folder changed during relocation. No folder was renamed.");
		}
		// Recheck immediately before the single same-parent rename; never replace a known destination.
		if (await projectPathExists(plan.newPath))
			throw new Error("The destination appeared during relocation. No folder was renamed.");
		await rename(plan.oldPath, plan.newPath);
	}
	const identity = await readProjectDirectoryIdentity(plan.newPath);
	if (!sameProjectDirectoryIdentity(identity, plan.directoryIdentity)) {
		throw new Error(
			"The relocation destination changed. Project files were preserved; locate the original folder to recover.",
		);
	}
	if (destinationExists && caseOnly && (await projectPathExists(plan.oldPath))) {
		if (!sameProjectDirectoryIdentity(await readProjectDirectoryIdentity(plan.oldPath), identity)) {
			throw new Error("The original folder changed during relocation. No folder was renamed.");
		}
		// Case-insensitive filesystems resolve both spellings before rename; still update the directory entry.
		await rename(plan.oldPath, plan.newPath);
	}
	if (!caseOnly && !areFileSystemPathsEqual(plan.oldPath, plan.newPath) && (await projectPathExists(plan.oldPath))) {
		throw new Error("Both project locations exist. Resolve the folder locations before retrying recovery.");
	}
	await repairProjectWorktrees(plan);
}

/** The durable record remains until runtime board/index migration and publication preparation finish. */
export async function beginProjectRelocation(plan: ProjectRelocationPlan): Promise<void> {
	const existing = await readProjectRelocationJournal(plan.projectId);
	if (!existing) await writeProjectRelocationJournal(plan, "prepared");
	else if (existing.operationId !== plan.operationId)
		throw new Error("A previous folder relocation must finish first.");
}

export async function applyProjectRelocation(plan: ProjectRelocationPlan): Promise<void> {
	await beginProjectRelocation(plan);
	await completeFilesystemRelocation(plan);
	await writeProjectRelocationJournal(plan, "filesystem_applied");
}

export async function recoverProjectRelocation(plan: ProjectRelocationPlan): Promise<void> {
	await completeFilesystemRelocation(plan);
}

export async function markProjectRelocationIndexCommitted(plan: ProjectRelocationPlan): Promise<void> {
	await writeProjectRelocationJournal(plan, "index_committed");
}
