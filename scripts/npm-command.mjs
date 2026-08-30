import { isAbsolute, win32 } from "node:path";

import { getProcessEnvironmentValue } from "./process-environment.mjs";

/** Avoids trying to CreateProcess npm.cmd directly on Windows. */
export function resolveNpmCommand(args, options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return { command: "npm", args };
	const env = options.env ?? process.env;
	const npmCliPath = getProcessEnvironmentValue(env, "npm_execpath", platform)?.trim();
	if (!npmCliPath || /[\r\n]/u.test(npmCliPath) || (!isAbsolute(npmCliPath) && !win32.isAbsolute(npmCliPath))) {
		throw new Error("Windows npm scripts require npm_execpath to launch npm through Node.js.");
	}
	const nodeBinary = options.nodeBinary ?? process.execPath;
	if (!isAbsolute(nodeBinary) && !win32.isAbsolute(nodeBinary)) {
		throw new Error("Windows npm scripts require an absolute Node.js executable path.");
	}
	return {
		command: nodeBinary,
		args: [npmCliPath, ...args],
	};
}
