#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareAgentLabBrowserCache } from "./agent-lab/browser-cache.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const npmBinary = process.platform === "win32" ? "npm.cmd" : "npm";

const DEPENDENCY_MARKERS = {
	root: ["node_modules/node-pty/package.json", "node_modules/zod/package.json"],
	web: ["web-ui/node_modules/react/package.json", "web-ui/node_modules/vite/package.json"],
};

async function pathExists(path) {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

export async function inspectDependencyTrees(checkoutRoot) {
	const [rootMarkers, webMarkers] = await Promise.all([
		Promise.all(DEPENDENCY_MARKERS.root.map((path) => pathExists(join(checkoutRoot, path)))),
		Promise.all(DEPENDENCY_MARKERS.web.map((path) => pathExists(join(checkoutRoot, path)))),
	]);
	return {
		rootAvailable: rootMarkers.every(Boolean),
		webAvailable: webMarkers.every(Boolean),
	};
}

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

export async function findActiveRuntimePids(stateHome) {
	const instancesRoot = join(stateHome, "diagnostics", "instances");
	const entries = await readdir(instancesRoot, { withFileTypes: true }).catch(() => []);
	const pids = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const descriptor = JSON.parse(await readFile(join(instancesRoot, entry.name, "runtime.json"), "utf8"));
			if (
				(descriptor.status === "starting" || descriptor.status === "ready") &&
				typeof descriptor.pid === "number" &&
				isProcessAlive(descriptor.pid)
			) {
				pids.push(descriptor.pid);
			}
		} catch {}
	}
	return [...new Set(pids)].sort((left, right) => left - right);
}

export async function resolveGlobalLinkedCheckout(command = npmBinary) {
	const result = spawnSync(command, ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	if (result.status !== 0) return null;
	const packagePath = join(String(result.stdout).trim(), "quarterdeck");
	try {
		return await realpath(packagePath);
	} catch {
		return null;
	}
}

export async function assertLinkedRuntimeIsStopped(
	checkoutRoot,
	options = {},
) {
	const stateHome = options.stateHome ?? process.env.QUARTERDECK_STATE_HOME ?? join(homedir(), ".quarterdeck");
	const [activeRuntimePids, linkedCheckout, resolvedCheckout] = await Promise.all([
		options.activeRuntimePids ?? findActiveRuntimePids(stateHome),
		options.linkedCheckout === undefined ? resolveGlobalLinkedCheckout() : options.linkedCheckout,
		realpath(checkoutRoot),
	]);
	if (activeRuntimePids.length === 0 || !linkedCheckout) return;
	const resolvedLinkedCheckout = await realpath(linkedCheckout).catch(() => resolve(linkedCheckout));
	if (resolvedLinkedCheckout !== resolvedCheckout) return;
	throw new Error(
		`Quarterdeck is running from this linked checkout (PID${activeRuntimePids.length === 1 ? "" : "s"} ${activeRuntimePids.join(", ")}). Stop Quarterdeck before reinstalling dependencies, rebuilding, or relinking this checkout, then retry.`,
	);
}

export function getMissingDependencyMessage(health) {
	if (!health.rootAvailable && !health.webAvailable) {
		return "Quarterdeck root and web UI dependencies are missing. Stop any linked Quarterdeck runtime, then run `npm run bootstrap`.";
	}
	if (!health.rootAvailable) {
		return "Quarterdeck root dependencies are missing. Stop any linked Quarterdeck runtime, then run `npm ci`.";
	}
	if (!health.webAvailable) {
		return "Quarterdeck web UI dependencies are missing. Stop any linked Quarterdeck runtime, then run `npm ci --prefix web-ui`.";
	}
	return null;
}

function runNpm(args, checkoutRoot = repoRoot) {
	const result = spawnSync(npmBinary, args, { cwd: checkoutRoot, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`npm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
	}
}

export async function bootstrapDependencies(checkoutRoot, options = {}) {
	await assertLinkedRuntimeIsStopped(checkoutRoot, options.runtime);
	const browserCache = await prepareAgentLabBrowserCache(checkoutRoot, options.gitCommonDirectory);
	const executeNpm = options.executeNpm ?? ((args) => runNpm(args, checkoutRoot));
	executeNpm(["ci"]);
	executeNpm(["ci", "--prefix", "web-ui"]);
	return browserCache;
}

async function runBootstrap() {
	await bootstrapDependencies(repoRoot);
}

async function runLink() {
	await assertLinkedRuntimeIsStopped(repoRoot);
	const health = await inspectDependencyTrees(repoRoot);
	const missingMessage = getMissingDependencyMessage(health);
	if (missingMessage) throw new Error(missingMessage);
	runNpm(["run", "build"]);
	runNpm(["link"]);
}

async function main() {
	const command = process.argv[2];
	if (command === "bootstrap") {
		await runBootstrap();
		return;
	}
	if (command === "link") {
		await runLink();
		return;
	}
	throw new Error("Usage: node scripts/dependency-workflow.mjs <bootstrap|link>");
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
	main().catch((error) => {
		process.stderr.write(`[quarterdeck-dependencies] ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
