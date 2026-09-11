import { resolve } from "node:path";

import { createTaggedLogger, normalizeDiagnosticErrorClass } from "../core";
import type { RuntimeCodexModelsResponse } from "../core/codex-model-contracts";
import { loadCodexModelCatalog } from "./codex-model-catalog";
import type { RuntimeConfigState } from "./runtime-config-normalizers";

const FRESH_FOR_MS = 5 * 60_000;
const REFRESH_FAILURE_BACKOFF_MS = 30_000;
const MAX_CACHED_PROJECTS = 100;
const log = createTaggedLogger("codex-model-catalog-cache");

interface CachedCatalog {
	data: RuntimeCodexModelsResponse;
	refreshAfter: number;
}

/** Runtime-owned picker metadata only; task launches still perform their own availability checks. */
export class CodexModelCatalogCache {
	private readonly cached = new Map<string, CachedCatalog>();
	private readonly pending = new Map<string, Promise<RuntimeCodexModelsResponse>>();

	constructor(
		private readonly load = loadCodexModelCatalog,
		private readonly now = Date.now,
	) {}

	async get(config: RuntimeConfigState, cwd: string): Promise<RuntimeCodexModelsResponse> {
		// Codex reads project-local configuration, so catalogs cannot be shared across directories.
		const key = resolve(cwd);
		const cached = this.cached.get(key);
		if (!cached) return this.refresh(config, key);
		this.cached.delete(key);
		this.cached.set(key, cached);
		if (this.now() >= cached.refreshAfter) {
			void this.refresh(config, key).catch(() => {
				// Refresh owns logging and backoff; callers keep the last successful catalog.
			});
		}
		return cached.data;
	}

	private refresh(config: RuntimeConfigState, key: string): Promise<RuntimeCodexModelsResponse> {
		const pending = this.pending.get(key);
		if (pending) return pending;
		const request = this.load(config, key)
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
				log.warn("Codex model catalog refresh failed", {
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
