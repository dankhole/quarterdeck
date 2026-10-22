import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveNpmCommand } from "./npm-command.mjs";

const instructionBridgeInputs = new Set([
	"AGENTS.md",
	"CLAUDE.md",
	"scripts/check-agent-instructions.mjs",
	"docs/testing.md",
	"docs/conventions/structured-execution.md",
]);

/** Automatic commits run only inexpensive checks; choose code validation explicitly. */
export function shouldCheckInstructionBridge(paths) {
	return paths.some((path) => instructionBridgeInputs.has(path));
}

export function runPrecommit() {
	const staged = spawnSync("git", ["diff", "--cached", "--name-only", "--no-renames", "-z"], { encoding: "utf8" });
	if (staged.error) throw staged.error;
	if (staged.status !== 0) throw new Error("Could not read staged paths for validation.");
	if (!shouldCheckInstructionBridge(staged.stdout.split("\0").filter(Boolean))) {
		console.log("No instruction-bridge changes; no additional pre-commit checks selected.");
		return 0;
	}
	console.log("Pre-commit: npm run check:agent-instructions");
	const command = resolveNpmCommand(["run", "check:agent-instructions"]);
	const result = spawnSync(command.command, command.args, { stdio: "inherit", windowsHide: true });
	if (result.error) throw result.error;
	return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		process.exitCode = runPrecommit();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
