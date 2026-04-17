import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeProjectStateResponse } from "@/runtime/types";

interface PreloadCacheEntry {
	projectState: RuntimeProjectStateResponse;
	fetchedAt: number;
}

const PRELOAD_TTL_MS = 15_000;
const cache = new Map<string, PreloadCacheEntry>();
const inflight = new Set<string>();

/**
 * Fire-and-forget: fetches project state for the given project and caches it.
 * Deduplicates concurrent requests and respects a short TTL so stale data
 * is never served. Called on hover of a project row.
 */
export function preloadProjectState(projectId: string): void {
	const existing = cache.get(projectId);
	if (existing && Date.now() - existing.fetchedAt < PRELOAD_TTL_MS) {
		return;
	}
	if (inflight.has(projectId)) {
		return;
	}
	inflight.add(projectId);
	const client = getRuntimeTrpcClient(projectId);
	client.project.getState
		.query()
		.then((projectState) => {
			cache.set(projectId, { projectState, fetchedAt: Date.now() });
		})
		.catch(() => {
			// Preload is opportunistic — swallow errors silently.
		})
		.finally(() => {
			inflight.delete(projectId);
		});
}

/**
 * Returns and removes a preloaded project state snapshot for the given project.
 * Returns null if no entry exists or the entry has expired.
 */
export function consumeProjectPreload(projectId: string): RuntimeProjectStateResponse | null {
	const entry = cache.get(projectId);
	if (!entry) {
		return null;
	}
	cache.delete(projectId);
	if (Date.now() - entry.fetchedAt > PRELOAD_TTL_MS) {
		return null;
	}
	return entry.projectState;
}
