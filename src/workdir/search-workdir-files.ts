import { normalizeFileSystemPathForComparison, type RuntimeWorkdirFileSearchMatch } from "../core";
import { runGit, splitNullSeparatedGitOutput } from "./git-utils";
import {
	type WorkdirFileTree,
	WorkdirFileTreeLimitError,
	type WorkdirFileTreeOptions,
	walkWorkdirFileTree,
} from "./workdir-file-tree";

const CACHE_TTL_MS = 5_000;
const FILE_LIST_CACHE_TTL_MS = 30_000;
const FILE_LIST_CACHE_MAX_ROOTS = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ── Filesystem-based file listing (used by file browser) ────────────────────

interface CachedFileList {
	expiresAt: number;
	result: WorkdirFileTree | WorkdirFileTreeLimitError;
}

const fsFileListCache = new Map<string, CachedFileList>();
const fsFileListLoads = new Map<string, Promise<WorkdirFileTree>>();

function cacheFileListResult(cacheKey: string, result: CachedFileList["result"]): void {
	const now = Date.now();
	for (const [key, cached] of fsFileListCache) {
		if (cached.expiresAt <= now) fsFileListCache.delete(key);
	}
	fsFileListCache.set(cacheKey, { expiresAt: now + FILE_LIST_CACHE_TTL_MS, result });
	if (fsFileListCache.size > FILE_LIST_CACHE_MAX_ROOTS) {
		const oldest = fsFileListCache.keys().next().value;
		if (oldest !== undefined) fsFileListCache.delete(oldest);
	}
}

function fileListCacheKey(cwd: string, useGitIgnores: boolean): string {
	return `${useGitIgnores ? "git" : "folder"}:${normalizeFileSystemPathForComparison(cwd)}`;
}

async function loadFileList(cwd: string, options: WorkdirFileTreeOptions): Promise<WorkdirFileTree> {
	const useGitIgnores = options.useGitIgnores !== false;
	const cacheKey = fileListCacheKey(cwd, useGitIgnores);
	const cached = fsFileListCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		if (cached.result instanceof WorkdirFileTreeLimitError) throw cached.result;
		return cached.result;
	}
	fsFileListCache.delete(cacheKey);

	const inFlight = fsFileListLoads.get(cacheKey);
	if (inFlight) return inFlight;

	const load = walkWorkdirFileTree(cwd, { useGitIgnores });
	fsFileListLoads.set(cacheKey, load);
	try {
		const entries = await load;
		// Invalidations detach the old load. It may finish for existing callers,
		// but must not populate the cache or interfere with its replacement.
		if (fsFileListLoads.get(cacheKey) === load) cacheFileListResult(cacheKey, entries);
		return entries;
	} catch (error) {
		// Do not rebuild an over-limit tree on every poll. Transient failures
		// remain immediately retryable, and invalidation detaches this failure too.
		if (error instanceof WorkdirFileTreeLimitError && fsFileListLoads.get(cacheKey) === load) {
			cacheFileListResult(cacheKey, error);
		}
		throw error;
	} finally {
		if (fsFileListLoads.get(cacheKey) === load) fsFileListLoads.delete(cacheKey);
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

export async function listAllWorkdirFiles(cwd: string, options: WorkdirFileTreeOptions = {}): Promise<string[]> {
	return [...(await loadFileList(cwd, options)).files];
}

export async function listAllWorkdirFileEntries(
	cwd: string,
	options: WorkdirFileTreeOptions = {},
): Promise<{ files: string[]; directories: string[] }> {
	const entries = await loadFileList(cwd, options);
	return { files: [...entries.files], directories: [...entries.directories] };
}

export function invalidateWorkdirFileListCache(cwd: string): void {
	const cacheKey = normalizeFileSystemPathForComparison(cwd);
	for (const useGitIgnores of [true, false]) {
		const listingKey = fileListCacheKey(cwd, useGitIgnores);
		fsFileListCache.delete(listingKey);
		fsFileListLoads.delete(listingKey);
	}
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
