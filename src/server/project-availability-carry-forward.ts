import type { RuntimeProjectAvailability } from "../core";

/**
 * Policy for reusing a prior Git-level availability verdict across an
 * indeterminate probe (a timeout, a blocked process launch, or a bounded
 * resource-exhaustion error). The probe itself proves nothing in that case;
 * this module decides what, if anything, from past evidence is still safe to
 * report instead of guessing.
 *
 * Mechanism (kept in `project-registry.ts`): a `Map<projectId, StoredProjectAvailability>`,
 * written only inside the registry's per-project serialized operation queue.
 * Policy (this module): whether a stored observation still applies to the
 * current scope, and whether its status is even eligible to be reused.
 */

export interface ProjectAvailabilityScopeFingerprint {
	repoPath: string;
	folderOnly: boolean;
	directoryIdentityFingerprint: string | null;
}

export interface StoredProjectAvailability extends ProjectAvailabilityScopeFingerprint {
	availability: RuntimeProjectAvailability;
}

/** The conservative, unstored result reported when there is no eligible previous evidence. */
export const CONSERVATIVE_INDETERMINATE_AVAILABILITY: RuntimeProjectAvailability = {
	status: "unavailable",
	reason: "not_git_repository",
};

/**
 * The scope fields that must stay identical for a stored observation to be
 * reused as "previous evidence." A project can change folderOnly/repoPath/
 * directory identity without going through `rebindProjectLocation` (for
 * example, re-adding an existing path), so carry-forward must not survive a
 * scope change it never saw.
 */
export function projectAvailabilityScopeFingerprint(scope: {
	repoPath: string;
	folderOnly?: boolean;
	directoryIdentity?: unknown;
}): ProjectAvailabilityScopeFingerprint {
	return {
		repoPath: scope.repoPath,
		folderOnly: scope.folderOnly === true,
		directoryIdentityFingerprint: scope.directoryIdentity ? JSON.stringify(scope.directoryIdentity) : null,
	};
}

function fingerprintsMatch(a: ProjectAvailabilityScopeFingerprint, b: ProjectAvailabilityScopeFingerprint): boolean {
	return (
		a.repoPath === b.repoPath &&
		a.folderOnly === b.folderOnly &&
		a.directoryIdentityFingerprint === b.directoryIdentityFingerprint
	);
}

/**
 * Only a prior Git-level verdict is safe to carry forward across an
 * indeterminate probe: `available`, or `unavailable` for the specific reason
 * `not_git_repository`. Any other previous reason (missing, relocation_pending,
 * invalid_location, inaccessible, not_directory) was a finding about something
 * upstream of the Git probe — and this observation's fresh directory/
 * relocation/identity checks already disproved it, so it cannot be reused.
 */
function isCarryForwardEligible(availability: RuntimeProjectAvailability): boolean {
	return availability.status === "available" || availability.reason === "not_git_repository";
}

/**
 * Returns the stored entry's availability only when it was observed for this
 * exact scope (repoPath, folderOnly, directory identity). A scope change
 * invalidates it even though nothing deleted the map entry.
 */
export function previousAvailabilityForScope(
	stored: StoredProjectAvailability | undefined,
	currentScope: { repoPath: string; folderOnly?: boolean; directoryIdentity?: unknown },
): RuntimeProjectAvailability | null {
	if (!stored) return null;
	return fingerprintsMatch(stored, projectAvailabilityScopeFingerprint(currentScope)) ? stored.availability : null;
}

/**
 * Resolves what to report for an indeterminate probe: the previous verdict
 * when it is scope-matched and carry-forward eligible, otherwise the
 * conservative fallback. `carriedForward: false` tells the caller the
 * conservative fallback must not be recorded as evidence, so the next
 * definitive observation is treated as first evidence, not a "change".
 */
export function resolveIndeterminateAvailability(previous: RuntimeProjectAvailability | null): {
	availability: RuntimeProjectAvailability;
	carriedForward: boolean;
} {
	if (previous && isCarryForwardEligible(previous)) {
		return { availability: previous, carriedForward: true };
	}
	return { availability: CONSERVATIVE_INDETERMINATE_AVAILABILITY, carriedForward: false };
}
