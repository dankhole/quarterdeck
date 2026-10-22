/**
 * Single source of truth for the desktop app's packaged resource list. Recorded
 * (checksummed) at package time by `artifact-manifest.mjs`, re-verified by
 * `verify-artifact.mjs`, and checked again by the npm-installed CLI at runtime
 * against a paired desktop install (`src/desktop-install/metadata.ts`'s
 * `desktopResourcePaths`, which imports this same array). Add a new packaged
 * resource here once; every consumer picks it up automatically.
 */
export const DESKTOP_RESOURCE_PATHS = [
	"app.asar",
	"runtime/bin/node",
	"runtime/bin/nodeHost",
	"runtime/installation-admission",
	"runtime/dist/build-manifest.json",
	"runtime/dist/cli.js",
	"runtime/dist/hooks.js",
	"runtime/dist/web-ui/index.html",
	"runtime/bundle-manifest.json",
	"runtime/release-policy.json",
];
