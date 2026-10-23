import { resolve } from "node:path";

import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import type { RuntimeConfigState } from "./runtime-config-normalizers";

const FRESH_FOR_MS = 5 * 60_000;
const REFRESH_FAILURE_BACKOFF_MS = 30_000;
const MAX_CACHED_PROJECTS = 100;
const log = createTaggedLogger("agent-model-catalog-cache");

interface CachedCatalog<T> {
	data: T;
	refreshAfter: number;
}

/**
 * Runtime-owned picker metadata only; task launches still perform their own availability checks.
 * Config is loaded only to refresh, so a cached catalog never waits on config reads or file locks.
 */
export class AgentModelCatalogCache<T> {
	private readonly cached = new Map<string, CachedCatalog<T>>();
	private readonly pending = new Map<string, Promise<T>>();

	constructor(
		private readonly agentId: string,
		private readonly load: (config: RuntimeConfigState, cwd: string) => Promise<T>,
		private readonly now = Date.now,
	) {}

	async get(loadConfig: () => Promise<RuntimeConfigState>, cwd: string): Promise<T> {
		// Agents read project-local configuration, so catalogs cannot be shared across directories.
		const key = resolve(cwd);
		const cached = this.cached.get(key);
		if (!cached) return this.refresh(loadConfig, key);
		this.cached.delete(key);
		this.cached.set(key, cached);
		if (this.now() >= cached.refreshAfter) {
			void this.refresh(loadConfig, key).catch(() => {
				// Refresh owns logging and backoff; callers keep the last successful catalog.
			});
		}
		return cached.data;
	}

	private refresh(loadConfig: () => Promise<RuntimeConfigState>, key: string): Promise<T> {
		const pending = this.pending.get(key);
		if (pending) return pending;
		const request = loadConfig()
			.then((config) => this.load(config, key))
			.then((data) => {
				this.cached.delete(key);
				this.cached.set(key, { data, refreshAfter: this.now() + FRESH_FOR_MS });
				while (this.cached.size > MAX_CACHED_PROJECTS) {
					const oldest = this.cached.keys().next().value;
					if (oldest !== undefined) this.cached.delete(oldest);
				}
				return data;
			})
			.catch((error: unknown) => {
				const cached = this.cached.get(key);
				if (cached) cached.refreshAfter = this.now() + REFRESH_FAILURE_BACKOFF_MS;
				log.warn("agent model catalog refresh failed", {
					agentId: this.agentId,
					hasCachedCatalog: cached !== undefined,
					errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
				});
				throw error;
			})
			.finally(() => this.pending.delete(key));
		this.pending.set(key, request);
		return request;
	}
}
