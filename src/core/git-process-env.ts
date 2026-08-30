import { mergeProcessEnvironment } from "./process-environment.js";

const GIT_REPOSITORY_ENV_KEYS = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
]);

/**
 * Apply the repository-independent Git policy owned by Quarterdeck. Git for
 * Windows still requires `core.longpaths` for working-tree operations that
 * cross the legacy Win32 path limit, including nested task worktrees.
 */
export function buildGitCommandArgs(args: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
	return ["-c", "core.quotepath=false", ...(platform === "win32" ? ["-c", "core.longpaths=true"] : []), ...args];
}

export function createGitProcessEnv(
	overrides: NodeJS.ProcessEnv = {},
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		// Prevent parent git hook context from hijacking repository-scoped git commands.
		const comparisonKey = platform === "win32" ? key.toUpperCase() : key;
		if (GIT_REPOSITORY_ENV_KEYS.has(comparisonKey)) {
			continue;
		}
		sanitized[key] = value;
	}
	return mergeProcessEnvironment(sanitized, overrides, platform);
}
