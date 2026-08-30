import { accessSync, constants } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve, win32 } from "node:path";

import { getWindowsEnvironmentValue, getWindowsPathEntries, getWindowsPathExtensions } from "./windows-system-paths.js";

function canAccessPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
	try {
		accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function getEnvironmentValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
	if (platform !== "win32") {
		return env[key];
	}
	return getWindowsEnvironmentValue(env, key);
}

function getWindowsExecutableCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
	const pathext = getWindowsPathExtensions(env);
	const lowerBinary = binary.toLowerCase();
	const explicitExtension = extname(lowerBinary);
	if (
		[".bat", ".cmd", ".com", ".exe", ".ps1"].includes(explicitExtension) ||
		pathext.some((extension) => explicitExtension === extension.toLowerCase())
	) {
		return [binary];
	}
	// Bare Windows commands resolve through PATHEXT (or CreateProcess' implicit
	// .exe behavior). Treating an extensionless file as launchable makes the
	// availability probe disagree with the command resolver and can report an
	// agent as installed even though the subsequent launch cannot execute it.
	return pathext.map((extension) => `${binary}${extension}`);
}

export interface ResolvedWindowsBinaryPath {
	extension: string;
	path: string;
}

function resolveAbsoluteCommandPath(path: string): string {
	return isAbsolute(path) || win32.isAbsolute(path) ? path : resolve(path);
}

/**
 * Resolve a Windows command to the exact file selected by the inherited PATH.
 *
 * Windows searches the child process' current directory before PATH for bare
 * executable names. Quarterdeck launches children with project directories as
 * cwd, so retaining a bare name after discovery would allow a project-local
 * executable to replace the command that the runtime already validated.
 */
export function resolveWindowsBinaryPath(
	binary: string,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedWindowsBinaryPath | null {
	const trimmed = binary.trim();
	if (!trimmed) return null;

	const explicitExtension = extname(trimmed).toLowerCase();
	const hasDirectorySeparators = trimmed.includes("/") || trimmed.includes("\\");
	if (explicitExtension && hasDirectorySeparators) {
		return { extension: explicitExtension, path: resolveAbsoluteCommandPath(trimmed) };
	}

	if (explicitExtension) {
		for (const pathEntry of getWindowsPathEntries(env)) {
			const candidate = resolveAbsoluteCommandPath(join(pathEntry, trimmed));
			if (canAccessPath(candidate, "win32")) {
				return { extension: explicitExtension, path: candidate };
			}
		}
		return null;
	}

	const commandCandidates = getWindowsExecutableCandidates(trimmed, env);
	if (hasDirectorySeparators) {
		for (const candidate of commandCandidates) {
			const resolvedCandidate = resolveAbsoluteCommandPath(candidate);
			if (canAccessPath(resolvedCandidate, "win32")) {
				return { extension: extname(resolvedCandidate).toLowerCase(), path: resolvedCandidate };
			}
		}
		return null;
	}

	for (const pathEntry of getWindowsPathEntries(env)) {
		for (const candidateName of commandCandidates) {
			const candidate = resolveAbsoluteCommandPath(join(pathEntry, candidateName));
			if (canAccessPath(candidate, "win32")) {
				return { extension: extname(candidate).toLowerCase(), path: candidate };
			}
		}
	}
	return null;
}

// Intentionally perform PATH inspection in-process instead of spawning `which`, `where`,
// `command -v`, or an interactive shell.
//
// Why this exists:
// Quarterdeck is launched from the user's shell and inherits that shell's environment, including
// PATH and exported variables. For agent detection and other startup-time capability checks,
// the question we care about is "can the current Quarterdeck process directly execute this binary
// from its inherited environment?" A direct PATH scan answers exactly that question.
//
// Why we do not delegate to shell commands:
// 1. Spawning helper commands like `which` or `where` adds unnecessary subprocess overhead
//    to hot paths such as loading runtime config.
// 2. Falling back to `zsh -ic 'command -v ...'` or similar is much worse because it can
//    trigger full interactive shell startup. On machines with heavy shell init like `conda`
//    or `nvm`, doing that repeatedly per task or per config read can freeze the runtime and
//    even make new terminal windows feel hung while the machine is saturated.
// 3. Depending on external lookup commands is also less robust than inspecting PATH directly.
//    For example, detection should not depend on `which` itself being available on PATH.
//
// Why this is acceptable:
// If a binary is only available after re-running shell init files, Quarterdeck should treat it as
// unavailable for task-agent startup. That keeps behavior predictable and aligned with the
// environment the Quarterdeck process already has, instead of silently relying on hidden shell
// side effects.
export function isBinaryAvailableOnPath(
	binary: string,
	options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): boolean {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const trimmed = binary.trim();
	if (!trimmed) {
		return false;
	}
	if (platform === "win32") {
		const resolved = resolveWindowsBinaryPath(trimmed, env);
		return resolved !== null && canAccessPath(resolved.path, platform);
	}
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return canAccessPath(trimmed, platform);
	}

	const pathEntries = (getEnvironmentValue(env, "PATH", platform) ?? "").split(delimiter).filter(Boolean);
	if (pathEntries.length === 0) {
		return false;
	}

	for (const entry of pathEntries) {
		if (canAccessPath(join(entry, trimmed), platform)) {
			return true;
		}
	}
	return false;
}
