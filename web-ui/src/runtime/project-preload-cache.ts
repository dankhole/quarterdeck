import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeProjectStateResponse } from "@/runtime/types";

interface PreloadCacheEntry {
	projectState: RuntimeProjectStateResponse;
	fetchedAt: number;
}

const PRELOAD_TTL_MS = 15_000;
/** Cap total concurrent hover-preload fetches so a fast sweep across many
 * project rows cannot flood the runtime alongside the selected project's
 * own fetch. */
const MAX_CONCURRENT_PRELOADS = 3;
const cache = new Map<string, PreloadCacheEntry>();
const inflight = new Map<string, object>();

/** The exact project ID whose own stream/fetch is still hydrating, or `null`
 * when none is. Hover preload is purely opportunistic and must yield to that
 * one fetch — but only for that project; hovering any other project row must
 * keep working normally. */
let hydratingProjectId: string | null = null;

/** Call from project-sync state tracking so hover preload of this exact
 * project pauses while it is still loading. Pass `null` once hydration ends
 * (success, give-up deadline, or project switch). */
export function setSelectedProjectHydrating(projectId: string | null): void {
	hydratingProjectId = projectId;
}

/**
 * Fire-and-forget: fetches project state for the given project and caches it.
 * Deduplicates concurrent requests, caps total concurrency, and respects a
 * short TTL so stale data is never served. Called on hover of a project row.
 */
export function preloadProjectState(projectId: string): void {
	if (projectId === hydratingProjectId) {
		return;
	}
	const existing = cache.get(projectId);
	if (existing && Date.now() - existing.fetchedAt < PRELOAD_TTL_MS) {
		return;
	}
	if (inflight.has(projectId)) {
		return;
	}
	if (inflight.size >= MAX_CONCURRENT_PRELOADS) {
		return;
	}
	const request = {};
	inflight.set(projectId, request);
	const client = getRuntimeTrpcClient(projectId);
	client.project.getState
		.query()
		.then((projectState) => {
			if (inflight.get(projectId) !== request) return;
			cache.set(projectId, { projectState, fetchedAt: Date.now() });
		})
		.catch(() => {
			// Preload is opportunistic — swallow errors silently.
		})
		.finally(() => {
			if (inflight.get(projectId) === request) inflight.delete(projectId);
		});
}

/** Retire both stored data and its producer when a project's location changes. */
export function invalidateProjectPreload(projectId: string): void {
	cache.delete(projectId);
	inflight.delete(projectId);
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

/** Test-only: clear all module-level preload state (cache, in-flight
 * trackers, and the hydrating-project gate) so tests do not leak state
 * across cases or files. */
export function resetProjectPreloadCacheForTests(): void {
	cache.clear();
	inflight.clear();
	hydratingProjectId = null;
}
