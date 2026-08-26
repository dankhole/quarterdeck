export type RuntimeBuildCompatibilityDecision = "compatible" | "reload" | "blocked";

const RUNTIME_BUILD_RELOAD_STORAGE_KEY = "quarterdeck.runtime-build-reload.v1";

function createReloadAttemptId(browserBuildId: string, runtimeBuildId: string): string {
	return JSON.stringify([browserBuildId, runtimeBuildId]);
}

/**
 * Fences an already-open browser from consuming a runtime contract produced by
 * another production build. One reload is allowed because the runtime serves
 * its own matching no-store assets; a repeated mismatch fails closed instead
 * of entering a reload loop.
 */
export function resolveRuntimeBuildCompatibility(
	runtimeBuildId: string | undefined,
	browserBuildId: string,
	storage: Pick<Storage, "getItem" | "removeItem" | "setItem">,
): RuntimeBuildCompatibilityDecision {
	if (runtimeBuildId === browserBuildId) {
		try {
			storage.removeItem(RUNTIME_BUILD_RELOAD_STORAGE_KEY);
		} catch {
			// Storage is only the bounded-loop fence. Matching builds are safe even
			// when privacy settings make sessionStorage unavailable.
		}
		return "compatible";
	}

	const reloadAttemptId = createReloadAttemptId(browserBuildId, runtimeBuildId ?? "missing");
	try {
		if (storage.getItem(RUNTIME_BUILD_RELOAD_STORAGE_KEY) === reloadAttemptId) {
			return "blocked";
		}
		storage.setItem(RUNTIME_BUILD_RELOAD_STORAGE_KEY, reloadAttemptId);
	} catch {
		// Do not risk an unbounded reload when storage cannot persist the fence.
		return "blocked";
	}
	return "reload";
}
