import { chmod, copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as esbuild from "esbuild";

/** Modules that must stay external (native addons, large runtime deps). */
const external = [
	"node-pty",
	"proper-lockfile",
	"tree-kill",
	"ws",
	"open",
	"@trpc/client",
	"@trpc/server",
	"commander",
	"zod",
];

const define = {
	"process.env.NODE_ENV": '"production"',
};

/**
 * Bundled CJS dependencies call require() on Node built-ins (process, fs, etc.).
 * ESM output needs a real require() function for those calls to work.
 */
const cjsShimBanner = [
	'import { createRequire as __quarterdeck_createRequire } from "node:module";',
	"const require = __quarterdeck_createRequire(import.meta.url);",
].join("\n");

/** Shared esbuild options for both entry points. */
const shared = {
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	external,
	define,
	sourcemap: true,
	packages: "bundle",
	banner: { js: cjsShimBanner },
};

const runtimeAssets = [
	{
		source: "src/terminal/pi-lifecycle-extension.runtime.js",
		output: "dist/terminal/pi-lifecycle-extension.runtime.js",
	},
];
const webUiDistSource = "web-ui/dist";
const webUiDistOutput = "dist/web-ui";

async function copyDirectoryContents(source, output) {
	const entries = await readdir(source, { withFileTypes: true });
	await mkdir(output, { recursive: true });
	await Promise.all(
		entries.map((entry) =>
			cp(join(source, entry.name), join(output, entry.name), {
				recursive: true,
				dereference: true,
			}),
		),
	);
}

await Promise.all([
	// CLI binary
	esbuild.build({
		...shared,
		entryPoints: ["src/cli.ts"],
		outfile: "dist/cli.js",
		banner: { js: `#!/usr/bin/env node\n${cjsShimBanner}` },
	}),
	// Library export
	esbuild.build({
		...shared,
		entryPoints: ["src/index.ts"],
		outfile: "dist/index.js",
	}),
]);

for (const asset of runtimeAssets) {
	await mkdir(dirname(asset.output), { recursive: true });
	await copyFile(asset.source, asset.output);
}

await rm(webUiDistOutput, { recursive: true, force: true });
await copyDirectoryContents(webUiDistSource, webUiDistOutput);
await chmod("dist/cli.js", 0o755);

console.log("esbuild: bundled dist/cli.js and dist/index.js and copied runtime assets");
