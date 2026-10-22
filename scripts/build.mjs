import { chmod, copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as esbuild from "esbuild";

import { createQuarterdeckEsbuildOptions, QUARTERDECK_CJS_SHIM_BANNER } from "./esbuild-shared-options.mjs";

const buildId = process.env.QUARTERDECK_BUILD_ID?.trim();
if (!buildId) {
	throw new Error(
		"QUARTERDECK_BUILD_ID is required. Run `npm run build` instead of invoking scripts/build.mjs directly.",
	);
}

/** Shared esbuild options for all three entry points. */
const shared = createQuarterdeckEsbuildOptions(buildId);

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
		banner: { js: `#!/usr/bin/env node\n${QUARTERDECK_CJS_SHIM_BANNER}` },
	}),
	esbuild.build({ ...shared, entryPoints: ["src/npm-install.ts"], outfile: "dist/npm-install.js" }),
	// Lightweight hook-ingest/notify entry point (src/hook-main.ts calling into
	// src/hook-entry.ts). Every Claude/Codex/Pi hook spawns a full process, so this
	// bundle must stay narrow — see docs/conventions/session-lifecycle.md
	// (Claude/Codex hooks) and the dist/hooks.js bundle-hygiene test.
	esbuild.build({
		...shared,
		entryPoints: ["src/hook-main.ts"],
		outfile: "dist/hooks.js",
	}),
]);

for (const asset of runtimeAssets) {
	await mkdir(dirname(asset.output), { recursive: true });
	await copyFile(asset.source, asset.output);
}

await rm(webUiDistOutput, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await copyDirectoryContents(webUiDistSource, webUiDistOutput);
if (process.platform !== "win32") await chmod("dist/cli.js", 0o755);

console.log("esbuild: bundled CLI, npm installation, and lightweight hook entry points and copied runtime assets");
