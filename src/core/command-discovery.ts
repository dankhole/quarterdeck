import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

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
	const normalizedKey = key.toLowerCase();
	return Object.entries(env).find(([entryKey]) => entryKey.toLowerCase() === normalizedKey)?.[1];
}

function getWindowsExecutableCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
	const pathext = getEnvironmentValue(env, "PATHEXT", "win32")?.split(";").filter(Boolean) ?? [
		".COM",
		".EXE",
		".BAT",
		".CMD",
	];
	const lowerBinary = binary.toLowerCase();
	if (pathext.some((extension) => lowerBinary.endsWith(extension.toLowerCase()))) {
		return [binary];
	}
	return [binary, ...pathext.map((extension) => `${binary}${extension}`)];
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
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return canAccessPath(trimmed, platform);
	}

	const pathEntries = (getEnvironmentValue(env, "PATH", platform) ?? "")
		.split(platform === "win32" ? ";" : delimiter)
		.filter(Boolean);
	if (pathEntries.length === 0) {
		return false;
	}

	if (platform === "win32") {
		const candidates = getWindowsExecutableCandidates(trimmed, env);
		for (const entry of pathEntries) {
			for (const candidate of candidates) {
				if (canAccessPath(join(entry, candidate), platform)) {
					return true;
				}
			}
		}
		return false;
	}

	for (const entry of pathEntries) {
		if (canAccessPath(join(entry, trimmed), platform)) {
			return true;
		}
	}
	return false;
}
