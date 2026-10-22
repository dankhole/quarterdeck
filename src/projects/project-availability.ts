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
	/** Tri-state Git root probe; defaults to the real probe. */
	probeGitRepository?: (path: string, projectId?: string) => Promise<GitRepositoryProbeResult>;
	hasPendingRelocation?: (projectId: string) => Promise<boolean>;
}

/**
 * Filesystem errors that describe runtime resource pressure, not the folder:
 * descriptor or memory exhaustion, temporary unavailability, or a busy resource.
 */
const INDETERMINATE_FILESYSTEM_ERROR_CODES: ReadonlySet<string> = new Set([
	"EMFILE",
	"ENFILE",
	"EAGAIN",
	"EBUSY",
	"ENOMEM",
]);

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? error.code : null;
}

function isIndeterminateFilesystemError(error: unknown): boolean {
	const code = errorCode(error);
	return typeof code === "string" && INDETERMINATE_FILESYSTEM_ERROR_CODES.has(code);
}

/**
 * Where an observation stopped without a definite answer:
 * - `filesystem`: a folder, identity, or relocation-journal check hit resource
 *   pressure, so nothing about the folder was established.
 * - `git`: the relocation, directory, and identity checks passed for this same
 *   observation, but the Git root probe could not answer.
 */
export type ProjectAvailabilityIndeterminateStage = "filesystem" | "git";

/**
 * Internal observation. Indeterminacy never reaches the browser/runtime wire
 * contract (`RuntimeProjectAvailability`): callers resolve it to a last-known or
 * the provisional `availability` before publishing.
 */
export interface ProjectAvailabilityObservation {
	/** Definite, or provisional while `indeterminate` is set. */
	availability: RuntimeProjectAvailability;
	indeterminate: ProjectAvailabilityIndeterminateStage | null;
}

async function inspectDirectory(path: string): Promise<RuntimeProjectAvailability> {
	try {
		return (await stat(path)).isDirectory()
			? { status: "available" }
			: { status: "unavailable", reason: "not_directory" };
	} catch (error) {
		if (isIndeterminateFilesystemError(error)) throw error;
		const code = errorCode(error);
		return {
			status: "unavailable",
			reason: code === "ENOENT" ? "missing" : code === "ENOTDIR" ? "not_directory" : "inaccessible",
		};
	}
}

/**
 * Observes admission to filesystem work; absence never authorizes deleting saved
 * project state. An indeterminate observation reports its provisional value.
 */
export async function observeProjectAvailability(
	scope: ProjectAvailabilityScope,
	deps: ProjectAvailabilityDependencies = {},
): Promise<RuntimeProjectAvailability> {
	return (await observeProjectAvailabilityDetailed(scope, deps)).availability;
}

/** Same observation, distinguishing an indeterminate answer from a definite one. */
export async function observeProjectAvailabilityDetailed(
	scope: ProjectAvailabilityScope,
	deps: ProjectAvailabilityDependencies = {},
): Promise<ProjectAvailabilityObservation> {
	const definite = (availability: RuntimeProjectAvailability): ProjectAvailabilityObservation => ({
		availability,
		indeterminate: null,
	});
	const indeterminate = (
		stage: ProjectAvailabilityIndeterminateStage,
		provisional: RuntimeProjectAvailability,
	): ProjectAvailabilityObservation => ({ availability: provisional, indeterminate: stage });
	if (isUnderWorktreesHome(scope.repoPath)) return definite({ status: "unavailable", reason: "invalid_location" });
	if (scope.projectId) {
		try {
			const pending = deps.hasPendingRelocation
				? await deps.hasPendingRelocation(scope.projectId)
				: (await readProjectRelocationJournal(scope.projectId)) !== null;
			if (pending) return definite({ status: "unavailable", reason: "relocation_pending" });
		} catch (error) {
			// An unreadable journal must not admit a launch against an uncertain location.
			const pending: RuntimeProjectAvailability = { status: "unavailable", reason: "relocation_pending" };
			return isIndeterminateFilesystemError(error) ? indeterminate("filesystem", pending) : definite(pending);
		}
	}
	try {
		const directory = deps.pathIsDirectory
			? (await deps.pathIsDirectory(scope.repoPath))
				? { status: "available" as const }
				: await inspectDirectory(scope.repoPath)
			: await inspectDirectory(scope.repoPath);
		if (directory.status === "unavailable") return definite(directory);
		if (scope.directoryIdentity) {
			const identity = await readProjectDirectoryIdentity(scope.repoPath);
			if (!matchesProjectDirectoryIdentity(scope.directoryIdentity, identity)) {
				return definite({ status: "unavailable", reason: "invalid_location" });
			}
		}
		if (scope.folderOnly) return definite({ status: "available" });
		const git = deps.probeGitRepository
			? await deps.probeGitRepository(scope.repoPath, scope.projectId)
			: await probeGitRepository(scope.repoPath);
		// The folder is accessible: Git being unable to answer is provisionally available.
		if (git === "indeterminate") return indeterminate("git", { status: "available" });
		return definite(
			git === "repository" ? { status: "available" } : { status: "unavailable", reason: "not_git_repository" },
		);
	} catch (error) {
		if (isIndeterminateFilesystemError(error)) return indeterminate("filesystem", { status: "available" });
		return definite({ status: "unavailable", reason: "inaccessible" });
	}
}
