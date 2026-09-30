import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeProjectStateResponse } from "@/runtime/types";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";
import { consumeProjectPreload, invalidateProjectPreload, preloadProjectState } from "./project-preload-cache";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: () => ({ project: { getState: { query } } }) }));

function deferred() {
	let resolve!: (state: RuntimeProjectStateResponse) => void;
	const promise = new Promise<RuntimeProjectStateResponse>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	invalidateProjectPreload("project-a");
	query.mockReset();
});

describe("project preload location changes", () => {
	it("fences old-path responses and preserves a replacement in-flight request", async () => {
		const oldRequest = deferred();
		const newRequest = deferred();
		query.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
		preloadProjectState("project-a");
		invalidateProjectPreload("project-a");
		preloadProjectState("project-a");
		oldRequest.resolve(createTestProjectStateResponse({ repoPath: "/old" }));
		await oldRequest.promise;
		await Promise.resolve();
		expect(consumeProjectPreload("project-a")).toBeNull();
		preloadProjectState("project-a");
		expect(query).toHaveBeenCalledTimes(2);
		newRequest.resolve(createTestProjectStateResponse({ repoPath: "/new" }));
		await newRequest.promise;
		expect(consumeProjectPreload("project-a")?.repoPath).toBe("/new");
	});
});
