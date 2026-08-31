import { accessSync, constants } from "node:fs";
import { extname, win32 } from "node:path";

import { type ResolvedWindowsBinaryPath, resolveWindowsBinaryPath } from "./command-discovery.js";
import {
	getWindowsEnvironmentValue,
	resolveWindowsPowerShellPath,
	resolveWindowsSystem32ExecutablePath,
} from "./windows-system-paths.js";

const WINDOWS_CMD_META_CHARS_REGEXP = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_CMD_EXTENSIONS = new Set([".cmd", ".bat"]);
const WINDOWS_DIRECT_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_NODE_MODULES_CMD_SHIM_REGEXP = /(?:^|[\\/])node_modules[\\/]\.bin[\\/][^\\/]+\.(?:cmd|bat)$/iu;

// `process.env` behaves case-insensitively on Windows, but once we copy env into a
// plain object for child-process merging we need to preserve that behavior ourselves.
function canAccessPath(path: string): boolean {
	try {
		accessSync(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export interface ResolvedWindowsCompatibleCommand {
	binary: string;
	args: string[];
	commandLine?: string;
}

export class WindowsCommandResolutionError extends Error {
	readonly code = "ENOENT";

	constructor(binary: string) {
		super(`Windows command "${binary}" could not be resolved from PATH.`);
		this.name = "WindowsCommandResolutionError";
	}
}

function resolveWindowsPowerShellShim(resolved: ResolvedWindowsBinaryPath): string | null {
	if (resolved.extension === ".ps1") return canAccessPath(resolved.path) ? resolved.path : null;
	if (!WINDOWS_CMD_EXTENSIONS.has(resolved.extension)) return null;
	const powerShellPath = `${resolved.path.slice(0, -resolved.extension.length)}.ps1`;
	return canAccessPath(powerShellPath) ? powerShellPath : null;
}

function normalizeWindowsCmdArgument(value: string): string {
	return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\\n");
}

function quoteWindowsProcessArgument(value: string): string {
	let quoted = '"';
	let backslashCount = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashCount += 1;
			continue;
		}
		if (character === '"') {
			quoted += "\\".repeat(backslashCount * 2 + 1);
			quoted += character;
			backslashCount = 0;
			continue;
		}
		quoted += "\\".repeat(backslashCount);
		quoted += character;
		backslashCount = 0;
	}
	quoted += "\\".repeat(backslashCount * 2);
	return `${quoted}"`;
}

export function buildWindowsProcessArgsCommandLine(args: string[]): string {
	return args.map((argument) => quoteWindowsProcessArgument(argument)).join(" ");
}

function escapeWindowsCommand(value: string): string {
	return value.replace(WINDOWS_CMD_META_CHARS_REGEXP, "^$1");
}

function escapeWindowsArgument(value: string, doubleEscapeMetaCharacters: boolean): string {
	let escaped = quoteWindowsProcessArgument(normalizeWindowsCmdArgument(`${value}`));
	escaped = escaped.replace(WINDOWS_CMD_META_CHARS_REGEXP, "^$1");
	if (doubleEscapeMetaCharacters) escaped = escaped.replace(WINDOWS_CMD_META_CHARS_REGEXP, "^$1");
	return escaped;
}

function shouldDoubleEscapeWindowsCmdShim(binary: string): boolean {
	// npm-style .bin proxies parse `%*` once more; ordinary batch commands do not.
	return WINDOWS_NODE_MODULES_CMD_SHIM_REGEXP.test(binary);
}

export function resolveWindowsComSpec(env: NodeJS.ProcessEnv = process.env): string {
	const comSpec = getWindowsEnvironmentValue(env, "ComSpec")?.trim();
	if (comSpec && win32.isAbsolute(comSpec) && !/["\r\n]/u.test(comSpec)) {
		return comSpec;
	}
	return resolveWindowsSystem32ExecutablePath("cmd.exe", env);
}

export function buildWindowsCmdArgsCommandLine(binary: string, args: string[]): string {
	const escapedCommand = escapeWindowsCommand(binary);
	const doubleEscapeMetaCharacters = shouldDoubleEscapeWindowsCmdShim(binary);
	const escapedArgs = args.map((part) => escapeWindowsArgument(part, doubleEscapeMetaCharacters));
	const shellCommand = [escapedCommand, ...escapedArgs].join(" ");
	return `/d /v:off /s /c "${shellCommand}"`;
}

export function buildWindowsCmdArgsArray(binary: string, args: string[]): string[] {
	const escapedCommand = escapeWindowsCommand(binary);
	const doubleEscapeMetaCharacters = shouldDoubleEscapeWindowsCmdShim(binary);
	const escapedArgs = args.map((part) => escapeWindowsArgument(part, doubleEscapeMetaCharacters));
	const shellCommand = [escapedCommand, ...escapedArgs].join(" ");
	return ["/d", "/v:off", "/s", "/c", `"${shellCommand}"`];
}

export function resolveWindowsCompatibleCommand(
	binary: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedWindowsCompatibleCommand {
	if (platform !== "win32") {
		return { binary, args };
	}
	const normalized = binary.trim().toLowerCase();
	const comSpec = resolveWindowsComSpec(env);
	if (normalized === "cmd" || normalized === "cmd.exe" || normalized === comSpec.toLowerCase()) {
		return { binary: comSpec, args };
	}

	const resolved = resolveWindowsBinaryPath(binary, env);
	if (!resolved) {
		throw new WindowsCommandResolutionError(binary);
	}
	if (WINDOWS_DIRECT_EXTENSIONS.has(resolved.extension)) {
		return { binary: resolved.path, args };
	}

	const powerShellShim = resolveWindowsPowerShellShim(resolved);
	if (powerShellShim) {
		return {
			binary: resolveWindowsPowerShellPath(env),
			args: [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				powerShellShim,
				...args,
			],
		};
	}
	const commandLine = buildWindowsCmdArgsCommandLine(resolved.path, args);
	return { binary: comSpec, args: buildWindowsCmdArgsArray(resolved.path, args), commandLine };
}

export function shouldUseWindowsCmdLaunch(
	binary: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (platform !== "win32") {
		return false;
	}
	const normalized = binary.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (normalized === "cmd" || normalized === "cmd.exe") {
		return false;
	}
	if (normalized === resolveWindowsComSpec(env).toLowerCase()) {
		return false;
	}

	const explicitExtension = extname(normalized).toLowerCase();
	if (WINDOWS_CMD_EXTENSIONS.has(explicitExtension)) {
		return true;
	}
	if (WINDOWS_DIRECT_EXTENSIONS.has(explicitExtension)) {
		return false;
	}

	const resolvedExtension = resolveWindowsBinaryPath(binary, env)?.extension;
	if (resolvedExtension && WINDOWS_DIRECT_EXTENSIONS.has(resolvedExtension)) {
		return false;
	}
	if (resolvedExtension && WINDOWS_CMD_EXTENSIONS.has(resolvedExtension)) {
		return true;
	}

	return true;
}
