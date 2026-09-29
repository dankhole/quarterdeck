/**
 * Exact runtime/browser artifact identity for one production build.
 *
 * Source-mode development intentionally shares the stable `development`
 * identity; Vite owns browser hot reload there. The production build wrapper
 * injects one opaque ID into both bundles for diagnostic correlation. Contract
 * compatibility is declared separately by QUARTERDECK_RUNTIME_PROTOCOL_VERSION.
 */
const DEVELOPMENT_BUILD_ID = "development";

export const QUARTERDECK_BUILD_ID = process.env.QUARTERDECK_BUILD_ID?.trim() || DEVELOPMENT_BUILD_ID;

/**
 * A production runtime must not admit a browser that predates build identity.
 * Identified browsers already check their initial snapshot before consuming
 * state: older ones compare build IDs and newer ones compare protocol versions.
 * Admit them so they can run their bounded reload policy if needed.
 */
export function shouldRejectLegacyRuntimeStreamClient(
	runtimeBuildId: string,
	browserBuildId: string | null | undefined,
): boolean {
	return runtimeBuildId !== DEVELOPMENT_BUILD_ID && !browserBuildId?.trim();
}
