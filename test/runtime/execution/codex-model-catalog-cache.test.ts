import { describe, expect, it, vi } from "vitest";

import { CodexModelCatalogCache } from "../../../src/config/codex-model-catalog-cache";
import type { RuntimeCodexModelsResponse } from "../../../src/core/codex-model-contracts";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

function catalog(name: string): RuntimeCodexModelsResponse {
	return {
		models: [
			{
				id: name,
				model: name,
				displayName: name,
				isDefault: true,
				defaultReasoningEffort: "low",
				supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
			},
		],
	};
}

function fixture() {
	let now = 0;
	const load = vi.fn(async () => catalog("initial"));
	const cache = new CodexModelCatalogCache(load, () => now);
	const config = createTestRuntimeConfigState();
	return {
		cache,
		load,
		config,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

async function settleRefresh(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Codex model catalog cache", () => {
	it("shares concurrent cold requests and reuses fresh model and effort metadata", async () => {
		const f = fixture();
		const results = await Promise.all([f.cache.get(f.config, "/project"), f.cache.get(f.config, "/project")]);
		expect(results).toEqual([catalog("initial"), catalog("initial")]);
		f.advance(299_999);
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("initial"));
		expect(f.load).toHaveBeenCalledOnce();
	});

	it("returns stale choices without waiting and replaces them after one shared refresh", async () => {
		const f = fixture();
		await f.cache.get(f.config, "/project");
		f.advance(300_000);
		let complete!: (data: RuntimeCodexModelsResponse) => void;
		f.load.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("initial"));
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("initial"));
		expect(f.load).toHaveBeenCalledTimes(2);
		complete(catalog("updated"));
		await settleRefresh();
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("updated"));
	});

	it("retains successful metadata after a refresh failure and retries after the cooldown", async () => {
		const f = fixture();
		await f.cache.get(f.config, "/project");
		f.advance(300_000);
		f.load.mockRejectedValueOnce(new Error("temporary timeout"));
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("initial"));
		await settleRefresh();
		f.advance(29_999);
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("initial"));
		expect(f.load).toHaveBeenCalledTimes(2);
		f.advance(1);
		f.load.mockResolvedValueOnce(catalog("recovered"));
		await f.cache.get(f.config, "/project");
		await settleRefresh();
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("recovered"));
	});

	it("does not cache initial failures or share catalogs across projects or runtime owners", async () => {
		const f = fixture();
		f.load.mockRejectedValueOnce(new Error("unavailable"));
		await expect(f.cache.get(f.config, "/project")).rejects.toThrow("unavailable");
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("initial"));
		f.load.mockResolvedValueOnce(catalog("other"));
		expect(await f.cache.get(f.config, "/other")).toEqual(catalog("other"));
		expect(await f.cache.get(f.config, "/project")).toEqual(catalog("initial"));
		await new CodexModelCatalogCache(f.load).get(f.config, "/project");
		expect(f.load).toHaveBeenCalledTimes(4);
	});

	it("accepts an authoritative empty catalog after refresh", async () => {
		const f = fixture();
		await f.cache.get(f.config, "/project");
		f.advance(300_000);
		f.load.mockResolvedValueOnce({ models: [] });
		await f.cache.get(f.config, "/project");
		await settleRefresh();
		expect(await f.cache.get(f.config, "/project")).toEqual({ models: [] });
	});

	it("bounds retained projects and evicts the least recently used catalog", async () => {
		const f = fixture();
		for (let index = 0; index < 100; index += 1) await f.cache.get(f.config, `/project-${index}`);
		await f.cache.get(f.config, "/project-0");
		await f.cache.get(f.config, "/project-100");
		await f.cache.get(f.config, "/project-0");
		expect(f.load).toHaveBeenCalledTimes(101);
		await f.cache.get(f.config, "/project-1");
		expect(f.load).toHaveBeenCalledTimes(102);
	});
});
