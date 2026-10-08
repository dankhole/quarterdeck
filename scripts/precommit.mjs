import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveNpmCommand } from "./npm-command.mjs";

const testFile = /\.test\.(?:[cm]?[jt]sx?)$/u;
const sharedRuntimeFiles = new Set(["src/terminal/output-utils.ts", "src/workdir/task-worktree-path.ts"]);

/** Unknown/shared inputs take the broad gate; only explicit ownership narrows it. */
export function selectPrecommitChecks(paths, fileExists = existsSync) {
	const lanes = { root: [], web: [], desktop: [] };
	let shared = false;
	let instructions = false;
	for (const path of paths) {
		if (/^(?:AGENTS|CLAUDE)\.md$/u.test(path)) instructions = true;
		if (/^[^/]+\.md$/iu.test(path) || /^docs\/.*\.(?:md|txt)$/iu.test(path) || path === "LICENSE" || path.startsWith("man/")) continue;
		if (path.startsWith("web-ui/")) lanes.web.push(path.slice("web-ui/".length));
		else if (path.startsWith("desktop/")) lanes.desktop.push(path.slice("desktop/".length));
		else if (path.startsWith("test/")) lanes.root.push(path);
		else if (path.startsWith("src/") && /\.tsx?$/u.test(path) && !/^src\/(?:core|shared|config|diagnostics)\//u.test(path) && !sharedRuntimeFiles.has(path)) lanes.root.push(path);
		else shared = true;
	}
	const checks = instructions ? [["run", "check:agent-instructions"]] : [];
	for (const [lane, files] of Object.entries(lanes)) {
		if (!shared && files.length === 0) continue;
		const prefix = lane === "root" ? [] : ["--prefix", lane === "web" ? "web-ui" : "desktop"];
		const directory = lane === "root" ? "" : `${lane === "web" ? "web-ui" : "desktop"}/`;
		const focused = !shared && files.every((file) => testFile.test(file) && fileExists(`${directory}${file}`));
		checks.push([...prefix, "run", "typecheck"]);
		checks.push([
			...prefix,
			"run",
			lane === "root" && !focused ? "test:fast" : "test",
			...(focused ? ["--", ...new Set(files)] : []),
		]);
	}
	return checks;
}

export function runPrecommit() {
	const staged = spawnSync("git", ["diff", "--cached", "--name-only", "--no-renames", "-z"], { encoding: "utf8" });
	if (staged.error) throw staged.error;
	if (staged.status !== 0) throw new Error("Could not read staged paths for validation.");
	const checks = selectPrecommitChecks(staged.stdout.split("\0").filter(Boolean));
	if (checks.length === 0) console.log("No executable changes: staged formatting is sufficient.");
	for (const args of checks) {
		console.log(`Pre-commit: npm ${args.join(" ")}`);
		const command = resolveNpmCommand(args);
		const result = spawnSync(command.command, command.args, { stdio: "inherit", windowsHide: true });
		if (result.error) throw result.error;
		if (result.status !== 0) return result.status ?? 1;
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		process.exitCode = runPrecommit();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
