import { stat } from "node:fs/promises";

import type { RuntimeProjectAvailability } from "../core";
import { readProjectRelocationJournal } from "../state/project-relocation-journal";
import { isUnderWorktreesHome } from "../state/project-state-utils";
import { hasGitRepository } from "./git-repository-probe";

export interface ProjectAvailabilityScope {
	projectId?: string;
	repoPath: string;
	folderOnly?: boolean;
	directoryIdentity?: { device: string; inode: string };
}

export interface ProjectAvailabilityDependencies {
	pathIsDirectory?: (path: string) => Promise<boolean>;
	hasGitRepository?: (path: string, projectId?: string) => Promise<boolean>;
	hasPendingRelocation?: (projectId: string) => Promise<boolean>;
}

async function inspectDirectory(path: string): Promise<RuntimeProjectAvailability> {
	try {
		return (await stat(path)).isDirectory()
			? { status: "available" }
			: { status: "unavailable", reason: "not_directory" };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : null;
		return {
			status: "unavailable",
			reason: code === "ENOENT" ? "missing" : code === "ENOTDIR" ? "not_directory" : "inaccessible",
		};
	}
}

/** Observes admission to filesystem work; absence never authorizes deleting saved project state. */
export async function observeProjectAvailability(
	scope: ProjectAvailabilityScope,
	deps: ProjectAvailabilityDependencies = {},
): Promise<RuntimeProjectAvailability> {
	if (isUnderWorktreesHome(scope.repoPath)) return { status: "unavailable", reason: "invalid_location" };
	if (scope.projectId) {
		try {
			const pending = deps.hasPendingRelocation
				? await deps.hasPendingRelocation(scope.projectId)
				: (await readProjectRelocationJournal(scope.projectId)) !== null;
			if (pending) return { status: "unavailable", reason: "relocation_pending" };
		} catch {
			// An unreadable journal must not admit a launch against an uncertain location.
			return { status: "unavailable", reason: "relocation_pending" };
		}
	}
	try {
		const directory = deps.pathIsDirectory
			? (await deps.pathIsDirectory(scope.repoPath))
				? { status: "available" as const }
				: await inspectDirectory(scope.repoPath)
			: await inspectDirectory(scope.repoPath);
		if (directory.status === "unavailable") return directory;
		if (scope.directoryIdentity) {
			const identity = await stat(scope.repoPath, { bigint: true });
			if (
				identity.dev.toString() !== scope.directoryIdentity.device ||
				identity.ino.toString() !== scope.directoryIdentity.inode
			) {
				return { status: "unavailable", reason: "invalid_location" };
			}
		}
		if (scope.folderOnly) return { status: "available" };
		const gitRepositoryAvailable = deps.hasGitRepository
			? await deps.hasGitRepository(scope.repoPath, scope.projectId)
			: await hasGitRepository(scope.repoPath);
		return gitRepositoryAvailable ? { status: "available" } : { status: "unavailable", reason: "not_git_repository" };
	} catch {
		return { status: "unavailable", reason: "inaccessible" };
	}
}
