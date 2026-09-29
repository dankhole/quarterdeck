export type RuntimeProtocolCompatibilityDecision = "compatible" | "reload" | "blocked";

const RUNTIME_PROTOCOL_RELOAD_STORAGE_KEY = "quarterdeck.runtime-protocol-reload.v1";

/**
 * Admit different builds with the same declared contract. An incompatible or
 * unknown contract gets one reload, then blocks if the served assets still
 * cannot use the running server. Build IDs never participate in this decision.
 */
export function resolveRuntimeProtocolCompatibility(
	runtimeProtocolVersion: unknown,
	browserProtocolVersion: number,
	getStorage: () => Pick<Storage, "getItem" | "removeItem" | "setItem">,
): RuntimeProtocolCompatibilityDecision {
	if (runtimeProtocolVersion === browserProtocolVersion) {
		try {
			getStorage().removeItem(RUNTIME_PROTOCOL_RELOAD_STORAGE_KEY);
		} catch {
			// Compatible contracts are safe even when sessionStorage is unavailable.
		}
		return "compatible";
	}

	const reloadAttemptId = JSON.stringify([
		browserProtocolVersion,
		typeof runtimeProtocolVersion === "number" &&
		Number.isSafeInteger(runtimeProtocolVersion) &&
		runtimeProtocolVersion > 0
			? runtimeProtocolVersion
			: "unknown",
	]);
	try {
		const storage = getStorage();
		if (storage.getItem(RUNTIME_PROTOCOL_RELOAD_STORAGE_KEY) === reloadAttemptId) {
			return "blocked";
		}
		storage.setItem(RUNTIME_PROTOCOL_RELOAD_STORAGE_KEY, reloadAttemptId);
	} catch {
		// Do not risk an unbounded reload when storage cannot persist the fence.
		return "blocked";
	}
	return "reload";
}
