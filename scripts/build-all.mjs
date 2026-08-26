#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmBinary = process.platform === "win32" ? "npm.cmd" : "npm";
const buildId = randomUUID();
const buildEnv = {
	...process.env,
	QUARTERDECK_BUILD_ID: buildId,
};

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		env: buildEnv,
		stdio: "inherit",
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
	}
}

function assertBuildIdentity() {
	const runtimeBundle = readFileSync(join(repoRoot, "dist", "cli.js"), "utf8");
	const webIndex = readFileSync(join(repoRoot, "dist", "web-ui", "index.html"), "utf8");
	const entryAsset = webIndex.match(/<script[^>]+src="([^"]+\.js)"/u)?.[1];
	if (!entryAsset) {
		throw new Error("Could not resolve the packaged web entry asset while verifying the build identity.");
	}
	const browserBundle = readFileSync(join(repoRoot, "dist", "web-ui", entryAsset.replace(/^\//u, "")), "utf8");
	if (!runtimeBundle.includes(buildId) || !browserBundle.includes(buildId)) {
		throw new Error("The packaged runtime and browser were not stamped with the same build identity.");
	}
}

run(npmBinary, ["run", "clean"]);
run(npmBinary, ["run", "web:build"]);
run(process.execPath, ["scripts/build.mjs"]);
assertBuildIdentity();

process.stdout.write(`[quarterdeck-build] packaged runtime and browser build ${buildId}\n`);
