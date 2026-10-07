import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, requireNativeMacTarget } from "../desktop/scripts/paths.mjs";
import { resolveNpmCommand } from "./npm-command.mjs";

const action = process.argv[2];
if (!["build", "install"].includes(action) || process.argv.length !== 3) {
	throw new Error("Use npm run desktop:build or npm run desktop:install.");
}
requireNativeMacTarget(process.arch);
for (const directory of [repoRoot, join(repoRoot, "web-ui"), join(repoRoot, "desktop")]) {
	let dependencies;
	try {
		dependencies = lstatSync(join(directory, "node_modules"));
	} catch {
		throw new Error(`Install dependencies in ${directory} before building the desktop app (npm ci).`);
	}
	if (!dependencies.isDirectory() || dependencies.isSymbolicLink()) {
		throw new Error(`Desktop builds require a real, independent node_modules directory in ${directory}.`);
	}
}

function run(command, args) {
	const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Desktop ${action} failed (${result.status ?? result.signal}).`);
}

for (const args of [["run", "build"], ["--prefix", "desktop", "run", "package", "--", `--arch=${process.arch}`]]) {
	const invocation = resolveNpmCommand(args);
	run(invocation.command, invocation.args);
}
const appPath = join(repoRoot, "desktop", "out", `Quarterdeck-darwin-${process.arch}`, "Quarterdeck.app");
if (action === "install") {
	run(process.execPath, [join(repoRoot, "dist", "cli.js"), "desktop", "install", "--from", appPath]);
} else {
	console.log(`Built desktop app: ${appPath}`);
}
