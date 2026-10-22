import type { RuntimeProjectAvailability } from "../core";
import { areFileSystemPathsEqual } from "../core/path-comparison";
import type { ProjectAvailabilityIndeterminateStage } from "./project-availability";

/**
 * Policy for reusing a prior availability verdict across an indeterminate
 * observation (a Git probe timeout, blocked launch, or signal death, or
 * resource pressure on a folder check). Such an observation proves nothing;
 * this module decides what, if anything, from past evidence still applies.
 *
 * Mechanism (`ProjectAvailabilityObserver`): one stored observation per
 * project, written only inside the observer's per-project recording lane.
 * Policy (this module): whether a stored observation applies to the current
 * scope, and whether its verdict survives what this observation established.
 */

export interface ProjectAvailabilityScopeFingerprint {
	repoPath: string;
	folderOnly: boolean;
	directoryIdentityFingerprint: string | null;
}

export interface StoredProjectAvailability extends ProjectAvailabilityScopeFingerprint {
	availability: RuntimeProjectAvailability;
}

interface ProjectAvailabilityScopeLike {
	repoPath: string;
	folderOnly?: boolean;
	directoryIdentity?: unknown;
}

/**
 * The scope fields that must stay identical for a stored observation to count
 * as previous evidence. A project can change folder-only mode or directory
 * identity without a rebind (for example, re-adding an existing path), so a
 * stored observation never survives a scope change it did not see.
 */
export function projectAvailabilityScopeFingerprint(
	scope: ProjectAvailabilityScopeLike,
): ProjectAvailabilityScopeFingerprint {
	return {
		repoPath: scope.repoPath,
		folderOnly: scope.folderOnly === true,
		directoryIdentityFingerprint: scope.directoryIdentity ? JSON.stringify(scope.directoryIdentity) : null,
	};
}

/** Returns the stored verdict only when it was observed for this exact scope. */
export function previousAvailabilityForScope(
	stored: StoredProjectAvailability | undefined,
	scope: ProjectAvailabilityScopeLike,
): RuntimeProjectAvailability | null {
	if (!stored) return null;
	const current = projectAvailabilityScopeFingerprint(scope);
	return areFileSystemPathsEqual(stored.repoPath, current.repoPath) &&
		stored.folderOnly === current.folderOnly &&
		stored.directoryIdentityFingerprint === current.directoryIdentityFingerprint
		? stored.availability
		: null;
}

/**
 * A `git`-stage indeterminate already passed this observation's relocation,
 * directory, and identity checks, which disproves any earlier finding about
 * them: only a Git-level verdict (`available` or `not_git_repository`) still
 * applies. A `filesystem`-stage indeterminate established nothing, so any
 * scope-matched verdict does.
 */
function isCarryForwardEligible(
	previous: RuntimeProjectAvailability,
	stage: ProjectAvailabilityIndeterminateStage,
): boolean {
	if (stage === "filesystem") return true;
	return previous.status === "available" || previous.reason === "not_git_repository";
}

/**
 * Resolves what to report for an indeterminate observation: the eligible
 * previous verdict, otherwise the observation's provisional value (available
 * for an accessible folder Git could not confirm; relocation pending for an
 * unreadable journal). Neither is recorded as evidence, so the next definite
 * observation is compared only with real evidence. Admission never relies on
 * this result: launches require a definite answer.
 */
export function resolveIndeterminateAvailability(
	previous: RuntimeProjectAvailability | null,
	stage: ProjectAvailabilityIndeterminateStage,
	provisional: RuntimeProjectAvailability,
): { availability: RuntimeProjectAvailability; carriedForward: boolean } {
	if (previous && isCarryForwardEligible(previous, stage)) return { availability: previous, carriedForward: true };
	return { availability: provisional, carriedForward: false };
}
