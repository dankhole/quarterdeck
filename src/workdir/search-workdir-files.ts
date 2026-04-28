import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import pLimit from "p-limit";

import type { RuntimeWorkdirFileSearchMatch } from "../core";
import { runGit } from "./git-utils";

const CACHE_TTL_MS = 5_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const FILE_WALK_CONCURRENCY = 16;
const SKIPPED_WALK_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

// ── Filesystem-based file listing (used by file browser) ────────────────────

interface CachedFileList {
	expiresAt: number;
	files: string[];
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
			if (!SKIPPED_WALK_DIRECTORIES.has(entry.name)) {
				directories.push(fullPath);
			}
		} else {
			files.push(toWorkdirRelativePath(rootDir, fullPath));
		}
	}
	return { files, directories };
}

/** Walk a directory tree with bounded breadth-first concurrency, collecting all file paths. */
async function walkDirectory(rootDir: string): Promise<string[]> {
	const limit = pLimit(FILE_WALK_CONCURRENCY);
	const files: string[] = [];
	let directories = [rootDir];

	while (directories.length > 0) {
		const currentDirectories = directories;
		directories = [];
		const results = await Promise.all(
			currentDirectories.map((dirPath) => limit(() => readDirectory(rootDir, dirPath))),
		);
		for (const result of results) {
			files.push(...result.files);
			directories.push(...result.directories);
		}
	}

	return files;
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
		const [filesResult, statusResult, deletedResult] = await Promise.all([
			runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"], {
				trimStdout: false,
				timeoutClass: "metadata",
			}),
			runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], {
				trimStdout: false,
				timeoutClass: "metadata",
			}),
			runGit(cwd, ["ls-files", "--deleted"], {
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
		const allFiles = normalizeLines(filesResult.stdout);
		const { changed: changedPaths, deleted: statusDeletedPaths } = statusResult.ok
			? parsePorcelainStatus(statusResult.stdout)
			: { changed: new Set<string>(), deleted: new Set<string>() };
		const deletedPaths = new Set(statusDeletedPaths);
		if (deletedResult.ok) {
			for (const path of normalizeLines(deletedResult.stdout)) {
				deletedPaths.add(path);
			}
		}
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

	const files = await walkDirectory(cwd);
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
