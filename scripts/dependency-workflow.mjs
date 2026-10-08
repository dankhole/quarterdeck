#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareAgentLabBrowserCache } from "./agent-lab/browser-cache.mjs";
import { resolveNpmCommand } from "./npm-command.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

function removeWindowsNamespacePrefix(path) {
	const normalizedSeparators = path.replaceAll("/", "\\");
	if (/^\\\\\?\\unc\\/iu.test(normalizedSeparators)) return `\\\\${normalizedSeparators.slice(8)}`;
	if (/^\\\\\?\\[A-Za-z]:\\/u.test(normalizedSeparators)) return normalizedSeparators.slice(4);
	return path;
}

export function normalizeCheckoutPathForComparison(path, platform = process.platform) {
	if (platform === "win32") {
		return win32.resolve(removeWindowsNamespacePrefix(path)).toLowerCase();
	}
	return posix.resolve(path);
}

async function dependencyTreeMatchesLockfile(packageRoot) {
	try {
		// Dependency trees belong to this checkout, never another worktree.
		if (!(await lstat(join(packageRoot, "node_modules"))).isDirectory()) return false;
		const [manifest, lock] = await Promise.all(
			["package.json", "package-lock.json"].map(async (name) =>
				JSON.parse(await readFile(join(packageRoot, name), "utf8")),
			),
		);
		const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
		const matches = await Promise.all(names.map(async (name) => {
			const expectedVersion = lock.packages?.[`node_modules/${name}`]?.version;
			if (typeof expectedVersion !== "string") return false;
			const installed = JSON.parse(await readFile(join(packageRoot, "node_modules", name, "package.json"), "utf8"));
			return installed.version === expectedVersion;
		}));
		return matches.every(Boolean);
	} catch {
		return false;
	}
}

export async function inspectDependencyTrees(checkoutRoot) {
	const [rootAvailable, webAvailable] = await Promise.all([
		dependencyTreeMatchesLockfile(checkoutRoot),
		dependencyTreeMatchesLockfile(join(checkoutRoot, "web-ui")),
	]);
	return { rootAvailable, webAvailable };
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

export async function resolveGlobalLinkedCheckout(command) {
	const invocation = command
		? { command, args: ["root", "-g"] }
		: resolveNpmCommand(["root", "-g"]);
	const result = spawnSync(invocation.command, invocation.args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
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
	if (normalizeCheckoutPathForComparison(resolvedLinkedCheckout) !== normalizeCheckoutPathForComparison(resolvedCheckout)) {
		return;
	}
	throw new Error(
		`Quarterdeck is running from this linked checkout (PID${activeRuntimePids.length === 1 ? "" : "s"} ${activeRuntimePids.join(", ")}). Stop Quarterdeck before reinstalling dependencies, rebuilding, or relinking this checkout, then retry.`,
	);
}

function runNpm(args, checkoutRoot = repoRoot) {
	const invocation = resolveNpmCommand(args);
	const result = spawnSync(invocation.command, invocation.args, {
		cwd: checkoutRoot,
		stdio: "inherit",
		windowsHide: true,
	});
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

/** Prepare only the dependency trees needed by the requested source workflow. */
export async function ensureDependencies(checkoutRoot, options = {}) {
	await assertLinkedRuntimeIsStopped(checkoutRoot, options.runtime);
	const prefixes = options.desktop ? ["", "web-ui", "desktop"] : ["", "web-ui"];
	// Reject all shared trees before any installation can mutate them.
	for (const prefix of prefixes) {
		const packageRoot = join(checkoutRoot, prefix);
		const tree = await lstat(join(packageRoot, "node_modules")).catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (tree && (!tree.isDirectory() || tree.isSymbolicLink())) {
			throw new Error(`Dependencies require a real, independent node_modules directory in ${packageRoot}.`);
		}
	}
	const executeNpm = options.executeNpm ?? ((args) => runNpm(args, checkoutRoot));
	for (const prefix of prefixes) {
		if (await dependencyTreeMatchesLockfile(join(checkoutRoot, prefix))) continue;
		if (prefix === "web-ui") {
			await prepareAgentLabBrowserCache(checkoutRoot, options.gitCommonDirectory);
		}
		console.log(`Installing locked ${prefix || "root"} dependencies…`);
		await executeNpm(prefix ? ["ci", "--prefix", prefix] : ["ci"]);
	}
	if (options.desktop) {
		// Electron's installer reuses the matching binary when already present.
		await executeNpm(["--prefix", "desktop", "exec", "--no", "--", "install-electron"]);
	}
}

async function runBootstrap() {
	await bootstrapDependencies(repoRoot);
}

export async function linkCheckout(checkoutRoot, options = {}) {
	const executeNpm = options.executeNpm ?? ((args) => runNpm(args, checkoutRoot));
	if (options.desktop) {
		// desktop:install owns preparation and the single paired build.
		await executeNpm(["run", "desktop:install"]);
	} else {
		await ensureDependencies(checkoutRoot, options);
		await executeNpm(["run", "build"]);
	}
	await executeNpm(["link"]);
}

async function main() {
	const command = process.argv[2];
	const flags = process.argv.slice(3);
	if (flags.length > 0 && !(command === "link" && flags.length === 1 && flags[0] === "--desktop")) {
		throw new Error("Usage: npm run bootstrap | npm run link [-- --desktop]");
	}
	if (command === "bootstrap") {
		await runBootstrap();
		return;
	}
	if (command === "link") {
		await linkCheckout(repoRoot, { desktop: flags.includes("--desktop") });
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
