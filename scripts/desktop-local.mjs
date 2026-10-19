import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot, requireNativeMacTarget } from "../desktop/scripts/paths.mjs";
import { ensureDependencies, linkCheckout } from "./dependency-workflow.mjs";
import { resolveNpmCommand } from "./npm-command.mjs";

const action = process.argv[2];
if (!["build", "install"].includes(action) || process.argv.length !== 3) {
	throw new Error("Use npm run desktop:build or npm run desktop:install.");
}
requireNativeMacTarget(process.arch);
if (process.arch === "x64") {
	const translated = spawnSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8", timeout: 2_000 });
	if (String(translated.stdout).trim() === "1") {
		throw new Error("Desktop builds cannot use x64 Node under Rosetta. Use native arm64 Node and rerun npm run link.");
	}
}
if (action === "install") {
	await linkCheckout(repoRoot, { desktop: true });
} else {
	await ensureDependencies(repoRoot, { desktop: true });

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
	console.log(`Built desktop app: ${appPath}`);
}
