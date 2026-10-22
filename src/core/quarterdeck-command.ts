import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

/** `cli.js`'s sibling entrypoint bundle that only wires the hook/statusline commands. */
const CLI_TO_HOOK_ENTRYPOINT: Readonly<Record<string, string>> = {
	"cli.js": "hooks.js",
	"cli.ts": "hooks.ts",
};

/**
 * `hooks ingest|notify` and `statusline` only need the small `hooks.js`
 * bundle, not the full server/router graph `cli.js` pulls in to start the
 * runtime. Swap the resolved entrypoint for its `hooks.js`/`hooks.ts` sibling
 * when `resolveQuarterdeckCommandParts` resolved to a recognized `cli.js` or
 * `cli.ts` file; every other shape (a bare `quarterdeck` binary, a
 * tsx-launched source file that is not `cli.ts`, or no entrypoint at all)
 * keeps the unmodified result so already-generated settings that still
 * reference `cli.js`, and invocation shapes this module does not recognize,
 * keep working exactly as before.
 */
function deriveHookEntrypoint(entrypoint: string): string | null {
	const hookBasename = CLI_TO_HOOK_ENTRYPOINT[basename(entrypoint)];
	return hookBasename ? join(dirname(entrypoint), hookBasename) : null;
}

export function resolveQuarterdeckHookCommandParts(
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
): string[] {
	const parts = resolveQuarterdeckCommandParts(context);
	const entrypoint = parts.at(-1);
	const hookEntrypoint = entrypoint ? deriveHookEntrypoint(entrypoint) : null;
	return hookEntrypoint ? [...parts.slice(0, -1), hookEntrypoint] : parts;
}

export function buildQuarterdeckHookCommandParts(
	args: string[],
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
): string[] {
	return [...resolveQuarterdeckHookCommandParts(context), ...args];
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
): string {
	const [binary, ...commandArgs] = buildQuarterdeckHookCommandParts(args, context);
	if (!binary) {
		throw new Error("Quarterdeck hook command resolution produced no executable.");
	}
	return buildShellCommandLine(binary, commandArgs, platform, env);
}
