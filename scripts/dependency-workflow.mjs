#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireNativeMacTarget } from "../desktop/scripts/paths.mjs";
import { prepareAgentLabBrowserCache } from "./agent-lab/browser-cache.mjs";
import { buildCheckout as buildRuntimeCheckout } from "./build-all.mjs";
import { readBuildManifest } from "./build-manifest.mjs";
import { assertStandaloneBuildIsSafe } from "./managed-installation-guard.mjs";
import { resolveNpmCommand } from "./npm-command.mjs";
import { assertLinkedRuntimeIsStopped, normalizeCheckoutPathForComparison } from "./linked-runtime-guard.mjs";

export { assertLinkedRuntimeIsStopped, findActiveRuntimePids, normalizeCheckoutPathForComparison, resolveGlobalLinkedCheckout } from "./linked-runtime-guard.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

async function dependencyTreeMatchesLockfile(packageRoot) {
	try {
		// Dependency trees belong to this checkout, never another worktree.
		if (!(await lstat(join(packageRoot, "node_modules"))).isDirectory()) return false;
		const [manifest, lock, installedLock] = await Promise.all(
			["package.json", "package-lock.json", "node_modules/.package-lock.json"].map(async (name) =>
				JSON.parse(await readFile(join(packageRoot, name), "utf8")),
			),
		);
		// Removed dependencies must also trigger npm ci, otherwise an obsolete
		// vulnerable package can remain in an otherwise up-to-date tree.
		if (!installedLock.packages || Object.keys(installedLock.packages).some((path) => !lock.packages?.[path])) return false;
		const directNames = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
		if (directNames.some((name) => !lock.packages?.[`node_modules/${name}`])) return false;
		// Security fixes often change only transitive packages. Check the entire
		// locked tree, including nested versions, before reusing an installation.
		const entries = Object.entries(lock.packages ?? {}).filter(([path]) => path.startsWith("node_modules/"));
		const matches = await Promise.all(entries.map(async ([path, expected]) => {
			try {
				const installed = JSON.parse(await readFile(join(packageRoot, path, "package.json"), "utf8"));
				return installed.version === expected.version;
			} catch (error) {
				// npm omits optional dependencies unsupported by the current host.
				return error.code === "ENOENT" && expected.optional === true;
			}
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

/** Select desktop installation by host support, independently of terminal interactivity. */
export function shouldLinkDesktop(options = {}) {
	if (options.desktop === true && options.browser === true) throw new Error("Choose --desktop or --browser, not both.");
	if (options.browser === true || options.desktop === false) return false;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const osRelease = options.osRelease ?? release();
	const supported = platform === "darwin" && ["arm64", "x64"].includes(arch) && Number.parseInt(osRelease, 10) >= 22;
	if (options.desktop === true && !supported) throw new Error("Desktop linking requires macOS 13 or newer on arm64 or x64.");
	if (options.desktop === true) return true;
	return supported && (options.installMode ?? process.env.QUARTERDECK_INSTALL_MODE) !== "browser";
}

export function resolveGlobalPackageLocation() {
	const readNpmPath = (args) => {
		const invocation = resolveNpmCommand(args);
		const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", windowsHide: true });
		if (result.error) throw result.error;
		if (result.status !== 0 || !String(result.stdout).trim()) throw new Error(`Cannot resolve npm ${args.join(" ")}.`);
		return resolve(String(result.stdout).trim());
	};
	return { packageSlot: join(readNpmPath(["root", "-g"]), "quarterdeck"), prefix: readNpmPath(["prefix", "-g"]) };
}

/** Build a local candidate; only the paired installer may replace an installed owner's build. */
export async function buildDesktopCheckout(checkoutRoot, options = {}) {
	await assertStandaloneBuildIsSafe(checkoutRoot, {
		...options.managedInstallation,
		pairedDesktopInstall: options.pairedDesktopInstall,
	});
	requireNativeMacTarget(process.arch);
	if (process.arch === "x64") {
		const translated = spawnSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8", timeout: 2_000 });
		if (String(translated.stdout).trim() === "1") {
			throw new Error("Desktop builds cannot use x64 Node under Rosetta. Use native arm64 Node and rerun npm run link.");
		}
	}
	await ensureDependencies(checkoutRoot, { ...options, desktop: true });
	const identity = await (options.buildCheckout ?? buildRuntimeCheckout)(checkoutRoot, options);
	const executeNpm = options.executeNpm ?? ((args) => runNpm(args, checkoutRoot));
	await executeNpm(["--prefix", "desktop", "run", "package", "--", `--arch=${process.arch}`]);
	const appPath = join(checkoutRoot, "desktop", "out", `Quarterdeck-darwin-${process.arch}`, "Quarterdeck.app");
	console.log(`Built desktop app: ${appPath}`);
	return { appPath, identity };
}

function installLinkedDesktop(checkoutRoot, location) {
	const appPath = join(checkoutRoot, "desktop", "out", `Quarterdeck-darwin-${process.arch}`, "Quarterdeck.app");
	const result = spawnSync(process.execPath, [
		join(checkoutRoot, "dist", "cli.js"), "desktop", "install", "--from", appPath,
		"--replace-owner", "--owner-package-slot", location.packageSlot, "--owner-prefix", location.prefix,
	], { cwd: checkoutRoot, stdio: "inherit", windowsHide: true });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error("The CLI was linked, but app installation is incomplete. Quit Quarterdeck and rerun npm run link in this checkout to repair the pair.");
	}
}

function readLinkedDesktopStatus(checkoutRoot) {
	const result = spawnSync(process.execPath, [join(checkoutRoot, "dist", "cli.js"), "desktop", "status", "--json"], {
		cwd: checkoutRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		maxBuffer: 128 * 1024,
	});
	if (result.error) throw result.error;
	try {
		const status = JSON.parse(result.stdout);
		if (result.status !== 0) throw new Error(status.message ?? "Desktop status exited unsuccessfully.");
		return status;
	} catch (error) {
		throw new Error("The linked CLI could not verify the completed desktop installation. Rerun npm run link -- --desktop to repair the pair.", { cause: error });
	}
}

export async function linkCheckout(checkoutRoot, options = {}) {
	const desktop = shouldLinkDesktop(options);
	const executeNpm = options.executeNpm ?? ((args) => runNpm(args, checkoutRoot));
	// This must precede even the packaging command: dependencies and dist can be in use.
	await assertLinkedRuntimeIsStopped(checkoutRoot, options.runtime);
	const location = await (options.resolveGlobalPackageLocation ?? resolveGlobalPackageLocation)();
	await assertStandaloneBuildIsSafe(checkoutRoot, {
		...options.managedInstallation,
		packageSlot: location.packageSlot,
		pairedDesktopInstall: desktop,
	});
	let expectedIdentity;
	if (desktop) {
		// Authorization stays in this invocation, never in an inherited environment flag.
		await (options.buildDesktop ?? buildDesktopCheckout)(checkoutRoot, {
			...options,
			pairedDesktopInstall: true,
		});
		expectedIdentity = await (options.readBuildIdentity ?? (() => readBuildManifest(join(checkoutRoot, "dist"))))();
	} else {
		await ensureDependencies(checkoutRoot, options);
		await executeNpm(["run", "build"]);
		// Recheck the destination immediately before a browser-only relink.
		await assertStandaloneBuildIsSafe(checkoutRoot, {
			...options.managedInstallation,
			packageSlot: location.packageSlot,
		});
	}
	await executeNpm(["link", "--ignore-scripts"]);
	if (!desktop) return;
	const resolvedCheckout = await realpath(checkoutRoot);
	const verifyLink = async () => {
		const linkedCheckout = await (options.resolveLinkedCheckout ?? (() => realpath(location.packageSlot)))();
		const canonicalLinkedCheckout = linkedCheckout ? await realpath(linkedCheckout).catch(() => resolve(linkedCheckout)) : null;
		if (!canonicalLinkedCheckout || normalizeCheckoutPathForComparison(canonicalLinkedCheckout) !== normalizeCheckoutPathForComparison(resolvedCheckout)) {
			throw new Error("The global quarterdeck link does not point to this checkout. App installation is incomplete; rerun npm run link after resolving the conflicting npm prefix.");
		}
	};
	await verifyLink();
	await (options.installDesktop ?? ((ownerLocation) => installLinkedDesktop(checkoutRoot, ownerLocation)))(location);
	await verifyLink();
	const status = await (options.readDesktopStatus ?? (() => readLinkedDesktopStatus(checkoutRoot)))(location);
	const installation = status?.installation;
	const owner = installation?.owner;
	if (
		status?.state !== "ready" || status.pending !== false ||
		installation?.buildId !== expectedIdentity.buildId || owner?.kind !== "link" ||
		owner.packageRoot !== resolvedCheckout || owner.packageSlot !== location.packageSlot || owner.prefix !== location.prefix
	) {
		throw new Error("The CLI was linked, but its exact desktop pair is not ready or cleanup remains pending. Quit Quarterdeck and rerun npm run link -- --desktop in this checkout to repair the installation.");
	}
	console.log("Linked CLI and desktop app installation completed for this checkout.");
}

async function main() {
	const command = process.argv[2];
	const flags = process.argv.slice(3);
	if (flags.length > 0 && !(command === "link" && flags.length === 1 && ["--desktop", "--browser"].includes(flags[0]))) {
		throw new Error("Usage: npm run bootstrap | npm run link [-- --desktop|--browser]");
	}
	if (command === "bootstrap") {
		await runBootstrap();
		return;
	}
	if (command === "link") {
		await linkCheckout(repoRoot, {
			...(flags.includes("--desktop") ? { desktop: true } : {}),
			browser: flags.includes("--browser"),
		});
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
