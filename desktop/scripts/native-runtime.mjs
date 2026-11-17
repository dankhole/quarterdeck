import { createRequire } from "node:module";
import { join } from "node:path";
import { desktopRoot } from "./paths.mjs";
import { run } from "./process.mjs";

const require = createRequire(import.meta.url);

/** Prepare the helper PTY for real Node, independently of Electron's ABI. */
export function prepareRuntimePty({ runtimePath, nodeBin, nodeVersion, arch, env, platform = process.platform }) {
	const nativeEnv = { ...env };
	// node-pty uses C-style {0} initialization for macOS kevent structs.
	// Omitted fields are zero-initialized; silence only this upstream warning.
	if (platform === "darwin")
		nativeEnv.CXXFLAGS = [nativeEnv.CXXFLAGS, "-Wno-missing-field-initializers"].filter(Boolean).join(" ");
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
	if (platform === "win32") {
		// The lockfile-authenticated upstream Windows Node-API binaries avoid
		// requiring an MSVC/Spectre toolchain on every packaging host. Load both
		// with the pinned real Node before accepting them; never fall back to a
		// different architecture or an Electron-rebuilt binary.
		run(
			nodeBin,
			[
				"-e",
				"require('./prebuilds/win32-' + process.arch + '/conpty.node'); require('./prebuilds/win32-' + process.arch + '/conpty_console_list.node');",
			],
			{ cwd: ptyPath, env: nativeEnv },
		);
		run(nodeBin, [join(ptyPath, "scripts", "post-install.js")], { cwd: ptyPath, env: nativeEnv });
		return;
	}
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
