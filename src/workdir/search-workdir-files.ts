import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import pLimit from "p-limit";

import { normalizeFileSystemPathForComparison, type RuntimeWorkdirFileSearchMatch } from "../core";
import { runGit, splitNullSeparatedGitOutput } from "./git-utils";
import { hasSkippedWorkdirPathComponent } from "./workdir-path-policy";

const CACHE_TTL_MS = 5_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const FILE_WALK_CONCURRENCY = 16;

// ── Filesystem-based file listing (used by file browser) ────────────────────

interface CachedFileList {
	expiresAt: number;
	files: string[];
	directories: string[];
}

const fsFileListCache = new Map<string, CachedFileList>();

interface DirectoryReadResult {
	files: string[];
	directories: string[];
}

function toWorkdirRelativePath(rootDir: string, fullPath: string): string {
	const relPath = relative(rootDir, fullPath);
	return sep === "\\" ? relPath.replaceAll("\\", "/") : relPath;
}

/** Read one directory, returning visible files and subdirectories for the next bounded batch. */
async function readDirectory(rootDir: string, dirPath: string): Promise<DirectoryReadResult> {
	let entries: Dirent[];
	try {
		entries = await readdir(dirPath, { withFileTypes: true });
	} catch {
		return { files: [], directories: [] }; // Permission denied, symlink loop, etc.
	}

	const files: string[] = [];
	const directories: string[] = [];
	for (const entry of entries) {
		const fullPath = join(dirPath, entry.name);

		if (entry.isDirectory()) {
			if (!hasSkippedWorkdirPathComponent(entry.name)) {
				directories.push(fullPath);
			}
		} else {
			files.push(toWorkdirRelativePath(rootDir, fullPath));
		}
	}
	return { files, directories };
}

/** Walk a directory tree with bounded breadth-first concurrency, collecting all file paths. */
async function walkDirectory(rootDir: string): Promise<{ files: string[]; directories: string[] }> {
	const limit = pLimit(FILE_WALK_CONCURRENCY);
	const files: string[] = [];
	const collectedDirectories: string[] = [];
	let directories = [rootDir];

	while (directories.length > 0) {
		const currentDirectories = directories;
		directories = [];
		const results = await Promise.all(
			currentDirectories.map((dirPath) => limit(() => readDirectory(rootDir, dirPath))),
		);
		for (const result of results) {
			files.push(...result.files);
			collectedDirectories.push(...result.directories.map((dirPath) => toWorkdirRelativePath(rootDir, dirPath)));
			directories.push(...result.directories);
		}
	}

	return { files, directories: collectedDirectories };
}

// ── Git-based file index (used by search for change-status metadata) ────────

interface CachedFileIndex {
	expiresAt: number;
	files: string[];
	changedPaths: Set<string>;
	deletedPaths: Set<string>;
}

const fileIndexCache = new Map<string, CachedFileIndex>();

function normalizeNullSeparatedPaths(stdout: string): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	for (const path of splitNullSeparatedGitOutput(stdout)) {
		if (seen.has(path)) {
			continue;
		}
		seen.add(path);
		files.push(path);
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
	const fields = stdout.split("\0");
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field || field.length < 4) {
			continue;
		}
		const indexStatus = field.charAt(0);
		const workTreeStatus = field.charAt(1);
		const path = field.slice(3);
		if (!path) {
			continue;
		}
		if (indexStatus === "R" || indexStatus === "C" || workTreeStatus === "R" || workTreeStatus === "C") {
			// Porcelain v1 `-z` emits the destination first and the source as the
			// following NUL-delimited field. The destination is the searchable path.
			index += 1;
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
	const cacheKey = normalizeFileSystemPathForComparison(cwd);
	const cached = fileIndexCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return {
			files: cached.files,
			changedPaths: cached.changedPaths,
		};
	}
	fileIndexCache.delete(cacheKey);

	try {
		const [filesResult, statusResult, deletedResult] = await Promise.all([
			runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
				trimStdout: false,
				timeoutClass: "metadata",
			}),
			runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
				trimStdout: false,
				timeoutClass: "metadata",
			}),
			runGit(cwd, ["ls-files", "--deleted", "-z"], {
				trimStdout: false,
				timeoutClass: "metadata",
			}),
		]);
		if (!filesResult.ok) {
			return {
				files: [],
				changedPaths: new Set<string>(),
			};
		}
		const allFiles = normalizeNullSeparatedPaths(filesResult.stdout);
		const { changed: changedPaths, deleted: statusDeletedPaths } = statusResult.ok
			? parsePorcelainStatus(statusResult.stdout)
			: { changed: new Set<string>(), deleted: new Set<string>() };
		const deletedPaths = new Set(statusDeletedPaths);
		if (deletedResult.ok) {
			for (const path of normalizeNullSeparatedPaths(deletedResult.stdout)) {
				deletedPaths.add(path);
			}
		}
		// Filter out deleted files — git ls-files --cached still lists them
		const files = deletedPaths.size > 0 ? allFiles.filter((path) => !deletedPaths.has(path)) : allFiles;
		fileIndexCache.set(cacheKey, {
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
	const cacheKey = normalizeFileSystemPathForComparison(cwd);
	const cached = fsFileListCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return [...cached.files];
	}
	fsFileListCache.delete(cacheKey);

	const { files, directories } = await walkDirectory(cwd);
	files.sort();
	directories.sort();

	fsFileListCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, files, directories });
	return [...files];
}

export async function listAllWorkdirFileEntries(cwd: string): Promise<{ files: string[]; directories: string[] }> {
	const cacheKey = normalizeFileSystemPathForComparison(cwd);
	const cached = fsFileListCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return { files: [...cached.files], directories: [...cached.directories] };
	}
	fsFileListCache.delete(cacheKey);

	const entries = await walkDirectory(cwd);
	entries.files.sort();
	entries.directories.sort();

	fsFileListCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, ...entries });
	return { files: [...entries.files], directories: [...entries.directories] };
}

export function invalidateWorkdirFileListCache(cwd: string): void {
	const cacheKey = normalizeFileSystemPathForComparison(cwd);
	fsFileListCache.delete(cacheKey);
	fileIndexCache.delete(cacheKey);
}

export function searchFilePaths(
	files: readonly string[],
	query: string,
	limit?: number,
	changedPaths: ReadonlySet<string> = new Set<string>(),
): RuntimeWorkdirFileSearchMatch[] {
	const trimmedQuery = query.trim();
	const normalizedLimit = normalizeLimit(limit);
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

export async function searchWorkdirFiles(
	cwd: string,
	query: string,
	limit?: number,
): Promise<RuntimeWorkdirFileSearchMatch[]> {
	const { files, changedPaths } = await loadFileIndex(cwd);
	return searchFilePaths(files, query, limit, changedPaths);
}
