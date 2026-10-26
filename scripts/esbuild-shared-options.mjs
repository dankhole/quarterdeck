/**
 * Shared esbuild configuration for every bundled Quarterdeck Node entry point
 * (`dist/cli.js`, `dist/npm-install.js`, `dist/hooks.js`). Extracted from
 * `scripts/build.mjs` so tests (e.g. a lightweight-hook-bundle hygiene check)
 * can build an entry point with the exact same settings without triggering
 * that script's full build side effects.
 */

/** Modules that must stay external (native addons, large runtime deps). */
export const QUARTERDECK_ESBUILD_EXTERNAL = [
	"node-pty",
	"proper-lockfile",
	"ws",
	"open",
	"@trpc/client",
	"@trpc/server",
	"commander",
	"zod",
];

/**
 * Bundled CJS dependencies call require() on Node built-ins (process, fs, etc.).
 * ESM output needs a real require() function for those calls to work.
 */
export const QUARTERDECK_CJS_SHIM_BANNER = [
	'import { createRequire as __quarterdeck_createRequire } from "node:module";',
	"const require = __quarterdeck_createRequire(import.meta.url);",
].join("\n");

/** Self-contained Pi asset: only Node built-ins remain external after copying. */
export function createPiLifecycleEsbuildOptions() {
	return {
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
	};
}

/** Shared esbuild options for every Quarterdeck Node entry point. */
export function createQuarterdeckEsbuildOptions(buildId) {
	return {
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
		external: QUARTERDECK_ESBUILD_EXTERNAL,
		define: {
			"process.env.NODE_ENV": '"production"',
			"process.env.QUARTERDECK_BUILD_ID": JSON.stringify(buildId),
		},
		sourcemap: true,
		packages: "bundle",
		banner: { js: QUARTERDECK_CJS_SHIM_BANNER },
	};
}
