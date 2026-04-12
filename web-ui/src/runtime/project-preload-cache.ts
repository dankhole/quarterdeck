import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceStateResponse } from "@/runtime/types";

interface PreloadCacheEntry {
	workspaceState: RuntimeWorkspaceStateResponse;
	fetchedAt: number;
}

const PRELOAD_TTL_MS = 15_000;
const cache = new Map<string, PreloadCacheEntry>();
const inflight = new Set<string>();

/**
 * Fire-and-forget: fetches workspace state for the given project and caches it.
 * Deduplicates concurrent requests and respects a short TTL so stale data
 * is never served. Called on hover of a project row.
 */
export function preloadProjectWorkspaceState(workspaceId: string): void {
	const existing = cache.get(workspaceId);
	if (existing && Date.now() - existing.fetchedAt < PRELOAD_TTL_MS) {
		return;
	}
	if (inflight.has(workspaceId)) {
		return;
	}
	inflight.add(workspaceId);
	const client = getRuntimeTrpcClient(workspaceId);
	client.workspace.getState
		.query()
		.then((workspaceState) => {
			cache.set(workspaceId, { workspaceState, fetchedAt: Date.now() });
		})
		.catch(() => {
			// Preload is opportunistic — swallow errors silently.
		})
		.finally(() => {
			inflight.delete(workspaceId);
		});
}

/**
 * Returns and removes a preloaded workspace state snapshot for the given project.
 * Returns null if no entry exists or the entry has expired.
 */
export function consumeProjectPreload(workspaceId: string): RuntimeWorkspaceStateResponse | null {
	const entry = cache.get(workspaceId);
	if (!entry) {
		return null;
	}
	cache.delete(workspaceId);
	if (Date.now() - entry.fetchedAt > PRELOAD_TTL_MS) {
		return null;
	}
	return entry.workspaceState;
}
