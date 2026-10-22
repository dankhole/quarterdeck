import { stat } from "node:fs/promises";

import type { RuntimeProjectAvailability } from "../core";
import {
	matchesProjectDirectoryIdentity,
	type ProjectDirectoryIdentity,
	readProjectDirectoryIdentity,
} from "../fs/project-directory-identity";
import { readProjectRelocationJournal } from "../state/project-relocation-journal";
import { isUnderWorktreesHome } from "../state/project-state-utils";
import { type GitRepositoryProbeResult, probeGitRepository } from "./git-repository-probe";

export interface ProjectAvailabilityScope {
	projectId?: string;
	repoPath: string;
	folderOnly?: boolean;
	directoryIdentity?: ProjectDirectoryIdentity;
}

export interface ProjectAvailabilityDependencies {
	pathIsDirectory?: (path: string) => Promise<boolean>;
	probeGitRepository?: (path: string, projectId?: string) => Promise<GitRepositoryProbeResult>;
	hasPendingRelocation?: (projectId: string) => Promise<boolean>;
}

/**
 * Internal observation type. `indeterminate` is never part of the browser/runtime
 * wire contract (`RuntimeProjectAvailability`): callers that publish availability
 * must resolve it to a definitive status before it leaves this layer.
 */
export type ProjectAvailabilityObservation = RuntimeProjectAvailability | { status: "indeterminate" };

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

/**
 * Observes admission to filesystem work; absence never authorizes deleting saved project state.
 *
 * `indeterminate` is only possible after the directory, relocation-journal, and
 * directory-identity checks above have already passed for this same observation:
 * it means the Git root probe itself could not run to completion (for example,
 * load-induced timeout), not that the repository is missing.
 */
export async function observeProjectAvailability(
	scope: ProjectAvailabilityScope,
	deps: ProjectAvailabilityDependencies = {},
): Promise<ProjectAvailabilityObservation> {
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
			const identity = await readProjectDirectoryIdentity(scope.repoPath);
			if (!matchesProjectDirectoryIdentity(scope.directoryIdentity, identity)) {
				return { status: "unavailable", reason: "invalid_location" };
			}
		}
		if (scope.folderOnly) return { status: "available" };
		const gitProbe = deps.probeGitRepository
			? await deps.probeGitRepository(scope.repoPath, scope.projectId)
			: await probeGitRepository(scope.repoPath);
		if (gitProbe === "repository") return { status: "available" };
		if (gitProbe === "indeterminate") return { status: "indeterminate" };
		return { status: "unavailable", reason: "not_git_repository" };
	} catch {
		return { status: "unavailable", reason: "inaccessible" };
	}
}
