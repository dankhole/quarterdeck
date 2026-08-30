import { posix, win32 } from "node:path";

import { isWindowsSafePathComponent } from "../core/windows-path-component";

export const SKIPPED_WORKDIR_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);
export const MUTABLE_WORKDIR_PATH_BLOCKED_MESSAGE = "Cannot modify skipped workdir paths.";
export const WINDOWS_WORKDIR_PATH_INVALID_MESSAGE = "Path contains a name that Windows does not support.";

export { isWindowsSafePathComponent } from "../core/windows-path-component";

function assertPlatformPathComponents(input: string, platform: NodeJS.Platform): void {
	if (platform !== "win32") return;
	const components = input.replaceAll("\\", "/").split("/").filter(Boolean);
	if (components.some((component) => !isWindowsSafePathComponent(component))) {
		throw new Error(WINDOWS_WORKDIR_PATH_INVALID_MESSAGE);
	}
}

export function normalizeWorkdirRelativePath(input: string, platform: NodeJS.Platform = process.platform): string {
	assertPlatformPathComponents(input, platform);
	const raw = input.replaceAll("\\", "/");
	if (!raw || raw.trim().length === 0) {
		throw new Error("Missing path parameter.");
	}
	const pathApi = platform === "win32" ? win32 : posix;
	const platformInput = platform === "win32" ? raw.replaceAll("/", "\\") : raw;
	const normalizedRaw = pathApi.normalize(platformInput).replaceAll("\\", "/");
	const normalized = normalizedRaw.replace(/\/+$/u, "");
	if (
		!normalized ||
		normalized === "." ||
		normalized.startsWith("../") ||
		normalized === ".." ||
		pathApi.isAbsolute(platformInput)
	) {
		throw new Error("Path resolves outside the worktree.");
	}
	return normalized;
}

export function hasSkippedWorkdirPathComponent(
	relativePath: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return relativePath
		.split("/")
		.some((part) => SKIPPED_WORKDIR_DIRECTORIES.has(platform === "win32" ? part.toLowerCase() : part));
}

export function assertMutableWorkdirPath(relativePath: string, platform: NodeJS.Platform = process.platform): void {
	if (hasSkippedWorkdirPathComponent(relativePath, platform)) {
		throw new Error(MUTABLE_WORKDIR_PATH_BLOCKED_MESSAGE);
	}
}
