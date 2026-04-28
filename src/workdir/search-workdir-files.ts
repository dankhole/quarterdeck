import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { RuntimeWorkdirFileSearchMatch } from "../core";
import { runGit } from "./git-utils";

const CACHE_TTL_MS = 5_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ── Filesystem-based file listing (used by file browser) ────────────────────

interface CachedFileList {
	expiresAt: number;
	files: string[];
}

const fsFileListCache = new Map<string, CachedFileList>();

/** Recursively walk a directory tree, collecting all file paths. */
async function walkDirectory(rootDir: string, dirPath: string, files: string[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dirPath, { withFileTypes: true });
	} catch {
		return; // Permission denied, symlink loop, etc.
	}

	for (const entry of entries) {
		const fullPath = join(dirPath, entry.name);

		if (entry.isDirectory()) {
			await walkDirectory(rootDir, fullPath, files);
		} else {
			const relPath = relative(rootDir, fullPath);
			files.push(sep === "\\" ? relPath.replaceAll("\\", "/") : relPath);
		}
	}
}

// ── Git-based file index (used by search for change-status metadata) ────────

interface CachedFileIndex {
	expiresAt: number;
	files: string[];
	changedPaths: Set<string>;
	deletedPaths: Set<string>;
}

const fileIndexCache = new Map<string, CachedFileIndex>();

function normalizeLines(stdout: string): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	for (const rawLine of stdout.split(/\r?\n/g)) {
		const line = rawLine.trim();
		if (!line || seen.has(line)) {
			continue;
		}
		seen.add(line);
		files.push(line);
	}
	return files;
}

interface PorcelainParseResult {
	changed: Set<string>;
	deleted: Set<string>;
}

function parsePorcelainStatus(stdout: string): PorcelainParseResult {
	const changed = new Set<string>();
	const deleted = new Set<string>();
	for (const rawLine of stdout.split(/\r?\n/g)) {
		const line = rawLine.trimEnd();
		if (!line || line.length < 4) {
			continue;
		}
		const indexStatus = line.charAt(0);
		const workTreeStatus = line.charAt(1);
		const payload = line.slice(3).trim();
		if (!payload) {
			continue;
		}
		const renamedParts = payload.split(" -> ");
		const path = renamedParts[renamedParts.length - 1]?.trim();
		if (!path) {
			continue;
		}
		// D in either column means the file is gone from the working tree or staged for deletion
		if (indexStatus === "D" || workTreeStatus === "D") {
			deleted.add(path);
		} else {
			changed.add(path);
		}
	}
	return { changed, deleted };
}

async function loadFileIndex(cwd: string): Promise<{ files: readonly string[]; changedPaths: ReadonlySet<string> }> {
	const cached = fileIndexCache.get(cwd);
	if (cached && cached.expiresAt > Date.now()) {
		return {
			files: cached.files,
			changedPaths: cached.changedPaths,
		};
	}
	fileIndexCache.delete(cwd);

	try {
		const [filesResult, statusResult] = await Promise.all([
			runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"], {
				trimStdout: false,
				timeoutClass: "metadata",
			}),
			runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], {
				trimStdout: false,
				timeoutClass: "metadata",
			}).catch(() => ({ stdout: "" })),
		]);
		if (!filesResult.ok) {
			return {
				files: [],
				changedPaths: new Set<string>(),
			};
		}
		const allFiles = normalizeLines(filesResult.stdout);
		const { changed: changedPaths, deleted: deletedPaths } = parsePorcelainStatus(statusResult.stdout);
		// Filter out deleted files — git ls-files --cached still lists them
		const files = deletedPaths.size > 0 ? allFiles.filter((path) => !deletedPaths.has(path)) : allFiles;
		fileIndexCache.set(cwd, {
			expiresAt: Date.now() + CACHE_TTL_MS,
			files,
			changedPaths,
			deletedPaths,
		});
		return { files, changedPaths };
	} catch {
		return {
			files: [],
			changedPaths: new Set<string>(),
		};
	}
}

function getMatchScore(path: string, queryLower: string): number | null {
	const pathLower = path.toLowerCase();
	const name = path.slice(path.lastIndexOf("/") + 1);
	const nameLower = name.toLowerCase();

	if (nameLower.startsWith(queryLower)) {
		return 0;
	}
	if (pathLower.startsWith(queryLower)) {
		return 1;
	}
	if (nameLower.includes(queryLower)) {
		return 2;
	}
	if (pathLower.includes(queryLower)) {
		return 3;
	}
	return null;
}

function normalizeLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_LIMIT;
	}
	const rounded = Math.floor(limit ?? DEFAULT_LIMIT);
	return Math.max(1, Math.min(MAX_LIMIT, rounded));
}

export async function listAllWorkdirFiles(cwd: string): Promise<string[]> {
	const cached = fsFileListCache.get(cwd);
	if (cached && cached.expiresAt > Date.now()) {
		return [...cached.files];
	}
	fsFileListCache.delete(cwd);

	const files: string[] = [];
	await walkDirectory(cwd, cwd, files);
	files.sort();

	fsFileListCache.set(cwd, { expiresAt: Date.now() + CACHE_TTL_MS, files });
	return [...files];
}

export async function searchWorkdirFiles(
	cwd: string,
	query: string,
	limit?: number,
): Promise<RuntimeWorkdirFileSearchMatch[]> {
	const trimmedQuery = query.trim();
	const normalizedLimit = normalizeLimit(limit);
	const { files, changedPaths } = await loadFileIndex(cwd);
	if (files.length === 0) {
		return [];
	}
	if (!trimmedQuery) {
		const sorted = [...files].sort((left, right) => {
			const leftChanged = changedPaths.has(left);
			const rightChanged = changedPaths.has(right);
			if (leftChanged !== rightChanged) {
				return leftChanged ? -1 : 1;
			}
			return left.localeCompare(right);
		});
		return sorted.slice(0, normalizedLimit).map((path) => ({
			path,
			name: path.slice(path.lastIndexOf("/") + 1) || path,
			changed: changedPaths.has(path),
		}));
	}

	const queryLower = trimmedQuery.toLowerCase();
	const ranked = files
		.map((path) => {
			const score = getMatchScore(path, queryLower);
			if (score == null) {
				return null;
			}
			return { path, score, changed: changedPaths.has(path) };
		})
		.filter((entry): entry is { path: string; score: number; changed: boolean } => entry !== null)
		.sort((left, right) => {
			if (left.changed !== right.changed) {
				return left.changed ? -1 : 1;
			}
			if (left.score !== right.score) {
				return left.score - right.score;
			}
			if (left.path.length !== right.path.length) {
				return left.path.length - right.path.length;
			}
			return left.path.localeCompare(right.path);
		});

	return ranked.slice(0, normalizedLimit).map((entry) => ({
		path: entry.path,
		name: entry.path.slice(entry.path.lastIndexOf("/") + 1) || entry.path,
		changed: entry.changed,
	}));
}
