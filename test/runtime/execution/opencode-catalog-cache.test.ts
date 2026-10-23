import { describe, expect, it, vi } from "vitest";

import { OpencodeCatalogCache } from "../../../src/config/opencode-catalog-cache";
import type { RuntimeOpencodeCatalogResponse } from "../../../src/core/opencode-catalog-contracts";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory";

function catalog(name: string): RuntimeOpencodeCatalogResponse {
	return {
		models: [{ id: `anthropic/${name}`, providerId: "anthropic", modelId: name }],
		agents: [{ name, mode: "primary" }],
	};
}

function fixture() {
	let now = 0;
	const load = vi.fn(async () => catalog("initial"));
	const cache = new OpencodeCatalogCache(load, () => now);
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

describe("opencode catalog cache", () => {
	it("shares concurrent cold requests and reuses fresh model and agent metadata", async () => {
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
		let complete!: (data: RuntimeOpencodeCatalogResponse) => void;
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
		await new OpencodeCatalogCache(f.load).get(f.config, "/project");
		expect(f.load).toHaveBeenCalledTimes(4);
	});

	it("accepts an authoritative empty catalog after refresh", async () => {
		const f = fixture();
		await f.cache.get(f.config, "/project");
		f.advance(300_000);
		f.load.mockResolvedValueOnce({ models: [], agents: [] });
		await f.cache.get(f.config, "/project");
		await settleRefresh();
		expect(await f.cache.get(f.config, "/project")).toEqual({ models: [], agents: [] });
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
