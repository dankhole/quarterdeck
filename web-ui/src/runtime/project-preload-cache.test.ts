// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeProjectStateResponse } from "@/runtime/types";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";
import {
	consumeProjectPreload,
	invalidateProjectPreload,
	preloadProjectState,
	resetProjectPreloadCacheForTests,
	setSelectedProjectHydrating,
} from "./project-preload-cache";

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
	resetProjectPreloadCacheForTests();
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

describe("project preload concurrency and hydration pause", () => {
	it("caps total concurrent preload fetches across projects and resumes once a slot frees up", async () => {
		const requests = [deferred(), deferred(), deferred(), deferred()];
		query
			.mockReturnValueOnce(requests[0]?.promise)
			.mockReturnValueOnce(requests[1]?.promise)
			.mockReturnValueOnce(requests[2]?.promise)
			.mockReturnValueOnce(requests[3]?.promise);

		preloadProjectState("project-a");
		preloadProjectState("project-b");
		preloadProjectState("project-c");
		preloadProjectState("project-d");
		// The fourth hover preload is dropped outright: it never joined the
		// in-flight set, so it is not queued for later either.
		expect(query).toHaveBeenCalledTimes(3);

		requests[0]?.resolve(createTestProjectStateResponse({ repoPath: "/a" }));
		await requests[0]?.promise;

		await vi.waitFor(() => {
			preloadProjectState("project-d");
			expect(query).toHaveBeenCalledTimes(4);
		});
	});

	it("skips hover preload of exactly the hydrating project, but not other projects", () => {
		query.mockResolvedValue(createTestProjectStateResponse());
		setSelectedProjectHydrating("project-a");

		// The hydrating project's own hover preload yields to its own fetch.
		preloadProjectState("project-a");
		expect(query).not.toHaveBeenCalled();

		// Hovering any other project row must keep working normally — a single
		// stuck project must not disable preload fleet-wide.
		preloadProjectState("project-b");
		expect(query).toHaveBeenCalledTimes(1);

		setSelectedProjectHydrating(null);
		preloadProjectState("project-a");
		expect(query).toHaveBeenCalledTimes(2);
	});
});
