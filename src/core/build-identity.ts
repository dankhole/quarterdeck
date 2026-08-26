/**
 * Exact runtime/browser artifact identity for one production build.
 *
 * Source-mode development intentionally shares the stable `development`
 * identity; Vite owns browser hot reload there. The production build wrapper
 * injects one opaque ID into both bundles so an already-open browser can detect
 * that it reconnected to a replacement runtime built from different code.
 */
const DEVELOPMENT_BUILD_ID = "development";

export const QUARTERDECK_BUILD_ID = process.env.QUARTERDECK_BUILD_ID?.trim() || DEVELOPMENT_BUILD_ID;

/**
 * A production runtime must not admit a browser that predates build identity.
 * Newer mismatched browsers are admitted long enough to receive the runtime
 * snapshot and run their bounded reload policy.
 */
export function shouldRejectLegacyRuntimeStreamClient(
	runtimeBuildId: string,
	browserBuildId: string | null | undefined,
): boolean {
	return runtimeBuildId !== DEVELOPMENT_BUILD_ID && !browserBuildId?.trim();
}
