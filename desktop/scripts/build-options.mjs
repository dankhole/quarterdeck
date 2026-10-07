import { desktopRoot } from "./paths.mjs";

const shared = {
	absWorkingDir: desktopRoot,
	bundle: true,
	platform: "node",
	target: "node22",
	external: ["electron"],
	sourcemap: true,
};

export const mainBuildOptions = {
	...shared,
	external: [...shared.external, "original-fs"],
	entryPoints: ["src/main.ts"],
	outfile: "dist/main.js",
	format: "esm",
	// Bundled CommonJS dependencies still require Node builtins. This lexical
	// bridge belongs only to trusted main; sandboxed preload retains its CJS API.
	banner: {
		js: 'import { createRequire as quarterdeckCreateRequire } from "node:module";\nconst require = quarterdeckCreateRequire(import.meta.url);',
	},
};

export const preloadBuildOptions = {
	...shared,
	entryPoints: ["src/preload.ts"],
	outfile: "dist/preload.cjs",
	format: "cjs",
};
