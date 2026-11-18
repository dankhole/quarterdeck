export type RuntimeProtocolCompatibilityDecision = "compatible" | "blocked";

/** Different build identities may share a contract. Incompatible peers must restart, never discard drafts by reloading. */
export function resolveRuntimeProtocolCompatibility(
	runtimeProtocolVersion: unknown,
	rendererProtocolVersion: number,
): RuntimeProtocolCompatibilityDecision {
	return runtimeProtocolVersion === rendererProtocolVersion ? "compatible" : "blocked";
}
