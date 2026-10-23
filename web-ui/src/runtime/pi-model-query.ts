import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimePiModelsResponse } from "@/runtime/types";

const FRESH_FOR_MS = 5 * 60_000;
const MAX_PROJECTS = 100;
const catalogs = new Map<string, { data: RuntimePiModelsResponse; expires: number }>();
const pending = new Map<string, Promise<RuntimePiModelsResponse>>();

/** Picker metadata only, never launch authority. Scoped to the current browser and project. */
export function getCachedPiModels(projectId: string | null): RuntimePiModelsResponse | null {
	if (projectId === null) return null;
	const cached = catalogs.get(projectId);
	if (!cached) return null;
	if (cached.expires <= Date.now()) {
		catalogs.delete(projectId);
		return null;
	}
	return cached.data;
}

export function fetchPiModels(projectId: string): Promise<RuntimePiModelsResponse> {
	const cached = getCachedPiModels(projectId);
	if (cached) return Promise.resolve(cached);
	const existing = pending.get(projectId);
	if (existing) return existing;
	const request = getRuntimeTrpcClient(projectId)
		.runtime.piModels.query()
		.then((data) => {
			catalogs.delete(projectId);
			catalogs.set(projectId, { data, expires: Date.now() + FRESH_FOR_MS });
			while (catalogs.size > MAX_PROJECTS) {
				const oldest = catalogs.keys().next().value;
				if (oldest !== undefined) catalogs.delete(oldest);
			}
			return data;
		})
		.finally(() => pending.delete(projectId));
	pending.set(projectId, request);
	return request;
}
