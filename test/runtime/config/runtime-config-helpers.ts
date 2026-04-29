import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { resetAgentAvailabilityCache } from "../../../src/config";

export function withTemporaryEnv<T>(
	input: {
		home: string;
		pathPrefix?: string;
		replacePath?: boolean;
	},
	run: () => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousPath = process.env.PATH;
	resetAgentAvailabilityCache();
	process.env.HOME = input.home;
	process.env.USERPROFILE = input.home;
	if (input.pathPrefix) {
		process.env.PATH = input.replacePath
			? input.pathPrefix
			: previousPath
				? `${input.pathPrefix}${delimiter}${previousPath}`
				: input.pathPrefix;
	}
	return run().finally(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (input.pathPrefix) {
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
		}
		resetAgentAvailabilityCache();
	});
}

export function writeFakeCommand(binDir: string, command: string): void {
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		const scriptPath = join(binDir, `${command}.cmd`);
		writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n", "utf8");
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(scriptPath, 0o755);
}

export function writeFakeVersionedCommand(
	binDir: string,
	command: string,
	version: string,
	options: { codexHooksSupported?: boolean } = {},
): void {
	mkdirSync(binDir, { recursive: true });
	const codexHooksSupported = options.codexHooksSupported ?? true;
	if (process.platform === "win32") {
		const scriptPath = join(binDir, `${command}.cmd`);
		writeFileSync(
			scriptPath,
			`@echo off
if "%1"=="--version" echo ${version}
if "%1"=="features" if "%2"=="list" echo codex_hooks  stable  ${codexHooksSupported ? "true" : "false"}
exit /b 0
`,
			"utf8",
		);
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(
		scriptPath,
		`#!/bin/sh
if [ "$1" = "--version" ]; then
	echo "${version}"
fi
if [ "$1" = "features" ] && [ "$2" = "list" ]; then
	echo "codex_hooks                         stable             ${codexHooksSupported ? "true" : "false"}"
fi
exit 0
`,
		"utf8",
	);
	chmodSync(scriptPath, 0o755);
}
