import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPiModels, getCachedPiModels } from "@/runtime/pi-model-query";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { piModels: { query } } }),
}));
const catalog = { models: [{ provider: "alpha", id: "model" }] };

afterEach(() => {
	vi.useRealTimers();
	query.mockReset();
});

describe("Pi picker metadata cache", () => {
	it("reuses successful discovery per project for five minutes", async () => {
		vi.useFakeTimers();
		query.mockResolvedValue(catalog);
		expect(getCachedPiModels("cache-project")).toBeNull();
		await fetchPiModels("cache-project");
		expect(getCachedPiModels("cache-project")).toEqual(catalog);
		await fetchPiModels("cache-project");
		expect(query).toHaveBeenCalledTimes(1);
		await fetchPiModels("other-project");
		expect(query).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(5 * 60_000);
		expect(getCachedPiModels("cache-project")).toBeNull();
		await fetchPiModels("cache-project");
		expect(query).toHaveBeenCalledTimes(3);
	});
	it("coalesces pending discovery and retries failures", async () => {
		query.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(catalog);
		const first = fetchPiModels("retry-project");
		expect(fetchPiModels("retry-project")).toBe(first);
		await expect(first).rejects.toThrow("Unavailable");
		expect(getCachedPiModels("retry-project")).toBeNull();
		expect(await fetchPiModels("retry-project")).toEqual(catalog);
		expect(query).toHaveBeenCalledTimes(2);
	});
	it("bounds successful catalogs to 100 projects", async () => {
		query.mockResolvedValue(catalog);
		for (let index = 0; index <= 100; index++) await fetchPiModels(`bounded-${index}`);
		expect(getCachedPiModels("bounded-0")).toBeNull();
		expect(getCachedPiModels("bounded-100")).toEqual(catalog);
	});
});
