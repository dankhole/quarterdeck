import { isAbsolute, normalize } from "node:path";

export const SKIPPED_WORKDIR_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);
export const MUTABLE_WORKDIR_PATH_BLOCKED_MESSAGE = "Cannot modify skipped workdir paths.";

export function normalizeWorkdirRelativePath(input: string): string {
	const trimmed = input.trim().replaceAll("\\", "/");
	if (!trimmed) {
		throw new Error("Missing path parameter.");
	}
	const normalizedRaw = normalize(trimmed).replaceAll("\\", "/");
	const normalized = normalizedRaw.replace(/\/+$/u, "");
	if (
		!normalized ||
		normalized === "." ||
		normalized.startsWith("../") ||
		normalized === ".." ||
		isAbsolute(normalizedRaw)
	) {
		throw new Error("Path resolves outside the worktree.");
	}
	return normalized;
}

export function hasSkippedWorkdirPathComponent(relativePath: string): boolean {
	return relativePath.split("/").some((part) => SKIPPED_WORKDIR_DIRECTORIES.has(part));
}

export function assertMutableWorkdirPath(relativePath: string): void {
	if (hasSkippedWorkdirPathComponent(relativePath)) {
		throw new Error(MUTABLE_WORKDIR_PATH_BLOCKED_MESSAGE);
	}
}
