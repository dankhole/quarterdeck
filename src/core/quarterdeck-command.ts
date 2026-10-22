import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { desktopStableAppPath, getDesktopAdmissionDescriptor } from "../desktop-install/admission.js";
import { readLabLaunchConfig } from "../shared/desktop-lab-launch-config.js";
import { buildShellCommandLine } from "./shell.js";

export interface RuntimeInvocationContext {
	execPath: string;
	argv: string[];
	execArgv?: string[];
}

function isValidatedSyntheticRuntime(context: RuntimeInvocationContext): boolean {
	const runtime = dirname(dirname(context.execPath));
	if (
		resolve(runtime, "../../..") === desktopStableAppPath() ||
		process.env.QUARTERDECK_AGENT_LAB !== "1" ||
		process.connected !== true ||
		typeof process.send !== "function" ||
		context.argv[1] !== join(runtime, "dist/cli.js")
	)
		return false;
	// DesktopRuntimeChannel consumes the child marker so independent hook CLI
	// processes cannot start another runtime. Only the live helper retains IPC.
	const lab = readLabLaunchConfig(process.env.QUARTERDECK_DESKTOP_LAB_CONFIG);
	const simulationFlag = context.argv.indexOf("--simulate-host-integrations");
	return (
		process.env.QUARTERDECK_STATE_HOME !== undefined &&
		realpathSync(process.env.QUARTERDECK_STATE_HOME) === lab.stateHome &&
		simulationFlag > 1 &&
		context.argv[simulationFlag + 1] === lab.hostSimulationConfigPath
	);
}

function resolveNodeExecutable(context: RuntimeInvocationContext): string {
	if (!context.execPath.endsWith("/Contents/Resources/runtime/bin/nodeHost")) {
		return context.execPath;
	}

	// Provider children do not retain the runtime's admission descriptor. Their
	// generated hooks must acquire their own admission before loading bundled Node.
	const wrapper = join(dirname(context.execPath), "node");
	try {
		if (!getDesktopAdmissionDescriptor() && !isValidatedSyntheticRuntime(context))
			throw new Error("Missing native admission");
		for (const path of [context.execPath, wrapper]) {
			const info = lstatSync(path);
			if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0 || realpathSync(path) !== path) {
				throw new Error("Invalid bundled Node executable");
			}
		}
	} catch {
		throw new Error(
			"The bundled Quarterdeck hook launcher could not verify native installation admission. Quit Quarterdeck and repair the npm installation.",
		);
	}
	return wrapper;
}

function resolveNodeCommandPrefix(context: RuntimeInvocationContext): string[] {
	const executable = resolveNodeExecutable(context);
	const execArgv = context.execArgv ?? [];
	if (execArgv.length === 0) {
		return [executable];
	}
	return [executable, ...execArgv];
}

function isLikelyTsxCliEntrypoint(value: string): boolean {
	const normalized = value.replaceAll("\\", "/").toLowerCase();
	if (normalized.endsWith("/tsx") || normalized.endsWith("/tsx.js")) {
		return true;
	}
	return normalized.includes("/tsx/") && normalized.endsWith("/cli.mjs");
}

function looksLikeEntrypointPath(value: string): boolean {
	if (!value) {
		return false;
	}
	if (value.includes("/") || value.includes("\\")) {
		return true;
	}
	if (/\.(?:mjs|cjs|js|ts|mts|cts)$/iu.test(value)) {
		return true;
	}
	return /quarterdeck(?:\.(?:cmd|ps1|exe))?$/iu.test(value);
}

export function resolveQuarterdeckCommandParts(
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
): string[] {
	const commandPrefix = resolveNodeCommandPrefix(context);
	const entrypoint = context.argv[1];
	if (!entrypoint || !looksLikeEntrypointPath(entrypoint)) {
		return commandPrefix;
	}

	const tsxTarget = context.argv[2];
	if (tsxTarget && isLikelyTsxCliEntrypoint(entrypoint) && looksLikeEntrypointPath(tsxTarget)) {
		return [...commandPrefix, entrypoint, tsxTarget];
	}

	return [...commandPrefix, entrypoint];
}

export function buildQuarterdeckCommandParts(
	args: string[],
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
): string[] {
	return [...resolveQuarterdeckCommandParts(context), ...args];
}

export function buildQuarterdeckCommandLine(
	args: string[],
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const [binary, ...commandArgs] = buildQuarterdeckCommandParts(args, context);
	if (!binary) {
		throw new Error("Quarterdeck command resolution produced no executable.");
	}
	return buildShellCommandLine(binary, commandArgs, platform, env);
}

/**
 * Locates the lightweight `dist/hooks.js` entry (built by `scripts/build.mjs` from
 * `src/hook-main.ts`) next to the bundled `dist/cli.js` that defines this very module
 * at runtime. `selfPath` defaults to this module's own `import.meta.url`, which esbuild
 * resolves to the single-file `dist/cli.js` bundle in production; a tsx/dev run leaves
 * it pointing at this source file instead, which never has a sibling bundle. Returns
 * `null` whenever the bundled sibling cannot be confirmed, so callers can fall back to
 * re-invoking the exact command that is already serving the current process.
 */
export function resolveBundledHookEntryPath(selfPath: string, platformSep: string = sep): string | null {
	let real: string;
	try {
		// realpathSync also resolves an npm-global bin symlink (e.g. a global
		// install's `quarterdeck` -> .../lib/node_modules/quarterdeck/dist/cli.js)
		// down to the real bundle path before the suffix/sibling checks below.
		real = realpathSync(selfPath);
	} catch {
		return null;
	}
	if (!real.endsWith(`${platformSep}cli.js`)) {
		return null;
	}
	const candidate = join(dirname(real), "hooks.js");
	try {
		// Mirrors resolveNodeExecutable's tamper check (regular file, not a
		// symlink to an attacker-controlled target) minus the executable-bit
		// requirement: hooks.js is passed as a plain argument to node, never exec'd.
		const info = lstatSync(candidate);
		if (!info.isFile() || info.isSymbolicLink() || realpathSync(candidate) !== candidate) {
			return null;
		}
	} catch {
		return null;
	}
	return candidate;
}

/**
 * Source entry of the lightweight hook bundle for an unbundled (tsx/dev)
 * runtime launched from `src/cli.ts`, so dev hooks exercise the same narrow
 * entry as production instead of loading the full CLI graph per hook. Returns
 * null for every other entrypoint shape.
 */
function resolveSourceHookEntrypoint(entrypoint: string): string | null {
	if (basename(entrypoint) !== "cli.ts") {
		return null;
	}
	const candidate = join(dirname(entrypoint), "hook-main.ts");
	try {
		return statSync(candidate).isFile() ? candidate : null;
	} catch {
		return null;
	}
}

/**
 * `hooks ingest|notify` only need the small hook entry, not the full
 * server/router graph `cli.js` pulls in to start the runtime. Prefer the bundled
 * `dist/hooks.js` beside this module's `dist/cli.js`; for a tsx-launched
 * `src/cli.ts`, swap in its `hook-main.ts` sibling. Every other shape (no sibling
 * bundle, a bare `quarterdeck` binary, no entrypoint) keeps the exact command
 * already serving this process, so it keeps working as before.
 */
export function resolveQuarterdeckHookCommandParts(
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
	selfPath: string = fileURLToPath(import.meta.url),
): string[] {
	const bundledEntry = resolveBundledHookEntryPath(selfPath);
	if (bundledEntry) {
		return [...resolveNodeCommandPrefix(context), bundledEntry];
	}
	const parts = resolveQuarterdeckCommandParts(context);
	const entrypoint = parts.at(-1);
	const sourceEntry = entrypoint ? resolveSourceHookEntrypoint(entrypoint) : null;
	return sourceEntry ? [...parts.slice(0, -1), sourceEntry] : parts;
}

export function buildQuarterdeckHookCommandParts(
	args: string[],
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
	selfPath: string = fileURLToPath(import.meta.url),
): string[] {
	return [...resolveQuarterdeckHookCommandParts(context, selfPath), ...args];
}

export function buildQuarterdeckHookCommandLine(
	args: string[],
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	selfPath: string = fileURLToPath(import.meta.url),
): string {
	const [binary, ...commandArgs] = buildQuarterdeckHookCommandParts(args, context, selfPath);
	if (!binary) {
		throw new Error("Quarterdeck hook command resolution produced no executable.");
	}
	return buildShellCommandLine(binary, commandArgs, platform, env);
}
