import { createRequire } from "node:module";
import { join } from "node:path";
import { desktopRoot } from "./paths.mjs";
import { run } from "./process.mjs";

const require = createRequire(import.meta.url);

/** Build the helper's PTY for real Node, independently of npm or Electron's ABI. */
export function rebuildRuntimePty({ runtimePath, nodeBin, nodeVersion, arch, env }) {
	const nativeEnv = { ...env };
	// node-gyp reads these legacy/package config values after CLI arguments.
	// Keep user toolchain choices (such as Python), but own the native target.
	for (const key of Object.keys(nativeEnv)) {
		const match = /^npm_(?:config_|package_config_node_gyp_)(.+)$/i.exec(key);
		const option = match?.[1].replaceAll("_", "-").toLowerCase();
		if (option && ["runtime", "target", "arch", "disturl", "dist-url", "devdir", "nodedir"].includes(option)) {
			delete nativeEnv[key];
		}
	}
	const ptyPath = join(runtimePath, "node_modules", "node-pty");
	run(
		nodeBin,
		[
			require.resolve("node-gyp/bin/node-gyp.js"),
			"rebuild",
			`--target=${nodeVersion}`,
			`--arch=${arch}`,
			"--dist-url=https://nodejs.org/download/release",
			`--devdir=${join(desktopRoot, ".cache", "node-gyp")}`,
		],
		{ cwd: ptyPath, env: nativeEnv },
	);
	// Preserve node-pty's release cleanup normally performed by npm postinstall.
	run(nodeBin, [join(ptyPath, "scripts", "post-install.js")], { cwd: ptyPath, env: nativeEnv });
}
