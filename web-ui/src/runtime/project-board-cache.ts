import type { RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardData } from "@/types";

export interface ProjectBoardCacheEntry {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	authoritativeRevision: number;
	projectPath: string | null;
	projectGit: RuntimeGitRepositoryInfo | null;
	cachedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 10;

const cache = new Map<string, ProjectBoardCacheEntry>();

/**
 * Cache entries can outlive the last authoritative apply. The cached board may
 * include local UI changes made after that apply, so the stored revision is the
 * server revision the cached view was last aligned with, not proof that the
 * cached board itself is authoritative for persistence.
 */
export function stashProjectBoard(projectId: string, entry: Omit<ProjectBoardCacheEntry, "cachedAt">): void {
	if (entry.authoritativeRevision == null) {
		return;
	}
	cache.set(projectId, { ...entry, cachedAt: Date.now() });
	if (cache.size > MAX_ENTRIES) {
		evictOldest();
	}
}

export function restoreProjectBoard(projectId: string): ProjectBoardCacheEntry | null {
	const entry = cache.get(projectId);
	if (!entry) {
		return null;
	}
	if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
		cache.delete(projectId);
		return null;
	}
	return entry;
}

export function updateProjectBoardCache(projectId: string, entry: Omit<ProjectBoardCacheEntry, "cachedAt">): void {
	if (!cache.has(projectId) || entry.authoritativeRevision == null) {
		return;
	}
	cache.set(projectId, { ...entry, cachedAt: Date.now() });
}

export function invalidateProjectBoardCache(projectId: string): void {
	cache.delete(projectId);
}

export function clearProjectBoardCache(): void {
	cache.clear();
}

function evictOldest(): void {
	let oldestKey: string | null = null;
	let oldestTime = Number.POSITIVE_INFINITY;
	for (const [key, entry] of cache) {
		if (entry.cachedAt < oldestTime) {
			oldestTime = entry.cachedAt;
			oldestKey = key;
		}
	}
	if (oldestKey) {
		cache.delete(oldestKey);
	}
}
