import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchTaskImageData,
	MAX_CACHED_TASK_IMAGE_CHARS,
	resetTaskImageDataCacheForTests,
	TASK_IMAGE_RETRY_DELAY_MS,
} from "@/runtime/task-image-query";

const { query, getRuntimeTrpcClient } = vi.hoisted(() => {
	const query = vi.fn();
	return { query, getRuntimeTrpcClient: vi.fn(() => ({ taskImages: { get: { query } } })) };
});
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient }));

const sha256 = "a".repeat(64);

describe("fetchTaskImageData", () => {
	beforeEach(() => {
		resetTaskImageDataCacheForTests();
		query.mockReset();
		getRuntimeTrpcClient.mockClear();
	});

	it("shares reads per project and hash", async () => {
		query.mockResolvedValue({ sha256, data: "YQ==" });
		const [first, second] = await Promise.all([
			fetchTaskImageData("project-1", sha256),
			fetchTaskImageData("project-1", sha256),
		]);
		expect([first, second]).toEqual(["YQ==", "YQ=="]);
		expect(query).toHaveBeenCalledTimes(1);

		await fetchTaskImageData("project-2", sha256);
		expect(getRuntimeTrpcClient).toHaveBeenLastCalledWith("project-2");
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("retries one transient failure and does not retain missing or failed reads", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			query
				.mockResolvedValueOnce(null)
				.mockRejectedValueOnce(new Error("offline"))
				.mockRejectedValueOnce(new Error("offline"))
				.mockRejectedValueOnce(new Error("blip"))
				.mockResolvedValueOnce({ sha256, data: "YQ==" });
			await expect(fetchTaskImageData("project-1", sha256)).resolves.toBeNull();

			const failed = expect(fetchTaskImageData("project-1", sha256)).rejects.toThrow("offline");
			await vi.advanceTimersByTimeAsync(TASK_IMAGE_RETRY_DELAY_MS);
			await failed;

			const recovered = fetchTaskImageData("project-1", sha256);
			await vi.advanceTimersByTimeAsync(TASK_IMAGE_RETRY_DELAY_MS);
			await expect(recovered).resolves.toBe("YQ==");
			expect(query).toHaveBeenCalledTimes(5);
		} finally {
			vi.useRealTimers();
		}
	});

	it("evicts the oldest resolved entries once retained base64 exceeds the byte bound", async () => {
		const large = "a".repeat(MAX_CACHED_TASK_IMAGE_CHARS / 2);
		query.mockImplementation(async () => ({ sha256, data: large }));
		await fetchTaskImageData("project-1", sha256);
		await fetchTaskImageData("project-2", sha256);
		await fetchTaskImageData("project-3", sha256);
		expect(query).toHaveBeenCalledTimes(3);

		// Three halves exceed the bound, so the oldest entry was dropped.
		await fetchTaskImageData("project-3", sha256);
		await fetchTaskImageData("project-2", sha256);
		expect(query).toHaveBeenCalledTimes(3);
		await fetchTaskImageData("project-1", sha256);
		expect(query).toHaveBeenCalledTimes(4);
	});

	it("evicts the oldest resolved entry once the cache exceeds the 48-entry bound", async () => {
		query.mockImplementation(async () => ({ sha256, data: "YQ==" }));
		for (let i = 0; i < 49; i++) {
			await fetchTaskImageData(`project-${i}`, sha256);
		}
		expect(query).toHaveBeenCalledTimes(49);

		// The oldest entry (project-0) was evicted once the bound was exceeded.
		await fetchTaskImageData("project-0", sha256);
		expect(query).toHaveBeenCalledTimes(50);

		// The most recently inserted entry is still cached.
		await fetchTaskImageData("project-48", sha256);
		expect(query).toHaveBeenCalledTimes(50);
	});

	it("does not evict an unresolved in-flight entry even past the 48-entry bound", async () => {
		const deferreds: Array<(value: { sha256: string; data: string } | null) => void> = [];
		query.mockImplementation(
			() =>
				new Promise((resolve) => {
					deferreds.push(resolve);
				}),
		);

		const pending = Array.from({ length: 49 }, (_, i) => fetchTaskImageData(`project-${i}`, sha256));
		expect(query).toHaveBeenCalledTimes(49);

		// None of the 49 in-flight reads have settled, so the bound (48) is
		// temporarily exceeded. The oldest (project-0) must not be dropped out
		// from under its original caller: re-requesting it while still pending
		// must share the exact same promise rather than issuing a duplicate fetch.
		const pendingZeroAgain = fetchTaskImageData("project-0", sha256);
		expect(query).toHaveBeenCalledTimes(49);
		expect(pendingZeroAgain).toBe(pending[0]);

		for (const resolve of deferreds) resolve({ sha256, data: "YQ==" });
		await Promise.all(pending);
	});
});
