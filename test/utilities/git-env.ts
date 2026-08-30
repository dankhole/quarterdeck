import { spawnSync } from "node:child_process";

import { mergeProcessEnvironment } from "../../src/core/process-environment.js";
import { resolveWindowsCompatibleCommand } from "../../src/core/windows-cmd-launch.js";

export function createGitTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		// Hooks can export GIT_* vars that redirect git commands away from test cwd.
		const comparisonKey = process.platform === "win32" ? key.toUpperCase() : key;
		if (comparisonKey.startsWith("GIT_")) {
			continue;
		}
		sanitized[key] = value;
	}
	return mergeProcessEnvironment(
		mergeProcessEnvironment(sanitized, {
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
			GIT_CONFIG_COUNT: process.platform === "win32" ? "2" : "1",
			GIT_CONFIG_KEY_0: "core.autocrlf",
			GIT_CONFIG_VALUE_0: "false",
			...(process.platform === "win32"
				? {
						GIT_CONFIG_KEY_1: "core.longpaths",
						GIT_CONFIG_VALUE_1: "true",
					}
				: {}),
		}),
		overrides,
	);
}

export function initGitRepository(path: string): void {
	const env = createGitTestEnv();
	const command = resolveWindowsCompatibleCommand("git", ["init", "-b", "main"], process.platform, env);
	const init = spawnSync(command.binary, command.args, {
		cwd: path,
		stdio: "ignore",
		env,
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

export function runGit(cwd: string, args: string[]): string {
	const env = createGitTestEnv();
	const command = resolveWindowsCompatibleCommand("git", args, process.platform, env);
	const result = spawnSync(command.binary, command.args, {
		cwd,
		encoding: "utf8",
		env,
	});
	if (result.status !== 0) {
		throw new Error(
			[`git ${args.join(" ")} failed in ${cwd}`, result.stdout.trim(), result.stderr.trim()]
				.filter((part) => part.length > 0)
				.join("\n"),
		);
	}
	return result.stdout.trim();
}

export function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}
