import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkdirSearchScope } from "./search-scope";
import { type UseTextSearchResult, useTextSearch } from "./use-text-search";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ project: { searchText: { query: search } } }),
}));
const response = {
	files: [{ path: "a.ts", matches: [{ line: 1, content: "needle" }] }],
	totalMatches: 1,
	truncated: false,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("useTextSearch comment filtering", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: UseTextSearchResult;
	function Harness({ scope, projectId }: { scope: WorkdirSearchScope; projectId: string | null }) {
		current = useTextSearch({ projectId, searchScope: scope, onSelect: vi.fn() });
		return null;
	}
	async function render(scope: WorkdirSearchScope = { taskId: null }, projectId: string | null = "p") {
		await act(async () => root.render(<Harness scope={scope} projectId={projectId} />));
	}
	async function start() {
		await act(async () => current.setQuery("needle"));
		await act(async () => {
			current.executeSearch();
		});
	}
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		search.mockReset();
		search.mockResolvedValue(response);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	it("defaults off and reruns the current query with acknowledgement, including empty results", async () => {
		await render();
		expect(current.ignoreComments).toBe(false);
		await start();
		expect(search).toHaveBeenLastCalledWith({ query: "needle", taskId: null, caseSensitive: false, isRegex: false });
		search.mockResolvedValue({ files: [], totalMatches: 0, truncated: false, ignoreComments: true });
		await act(async () => current.toggleIgnoreComments());
		expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: "needle", ignoreComments: true }));
		expect(current.results).toEqual([]);
		expect(current.error).toBeNull();
		search.mockResolvedValue(response);
		await act(async () => current.toggleIgnoreComments());
		expect(search.mock.lastCall![0]).not.toHaveProperty("ignoreComments");
		expect(current.totalMatches).toBe(1);
	});
	it.each(["", "n"])(
		"clears completed results and selection before toggling for ineligible query %j",
		async (query) => {
			search.mockResolvedValue({ ...response, truncated: true });
			await render();
			await start();
			await act(async () => current.setSelectedIndex(0));
			expect(current.totalMatches).toBe(1);
			await act(async () => current.setQuery(query));
			await act(async () => current.toggleIgnoreComments());
			expect(current.ignoreComments).toBe(true);
			expect(current.results).toEqual([]);
			expect(current.flatMatches).toEqual([]);
			expect(current.totalMatches).toBe(0);
			expect(current.truncated).toBe(false);
			expect(current.selectedIndex).toBe(-1);
			expect(current.error).toBeNull();
			expect(current.hasSearched).toBe(false);
			expect(current.isLoading).toBe(false);
			expect(search).toHaveBeenCalledTimes(1);
		},
	);
	it("clears an earlier error when the query becomes ineligible", async () => {
		search.mockRejectedValue(new Error("Search failed"));
		await render();
		await start();
		expect(current.error).toBe("Search failed");
		await act(async () => current.setQuery(""));
		await act(async () => current.toggleIgnoreComments());
		expect(current.error).toBeNull();
		expect(current.hasSearched).toBe(false);
		expect(search).toHaveBeenCalledTimes(1);
	});
	it.each(["success", "error"])("fences pending %s after clearing and toggling the query", async (outcome) => {
		let resolve!: (value: typeof response) => void;
		let reject!: (error: Error) => void;
		search.mockReturnValue(
			new Promise<typeof response>((done, fail) => {
				resolve = done;
				reject = fail;
			}),
		);
		await render();
		await start();
		expect(current.isLoading).toBe(true);
		await act(async () => {
			current.setQuery("");
			current.toggleIgnoreComments();
		});
		await act(async () => {
			if (outcome === "success") resolve(response);
			else reject(new Error("Late failure"));
		});
		expect(current.ignoreComments).toBe(true);
		expect(current.results).toEqual([]);
		expect(current.totalMatches).toBe(0);
		expect(current.selectedIndex).toBe(-1);
		expect(current.error).toBeNull();
		expect(current.hasSearched).toBe(false);
		expect(current.isLoading).toBe(false);
		expect(search).toHaveBeenCalledTimes(1);
	});

	it("retains a selected match when toggling and reruns the latest query when changed with the option", async () => {
		await render();
		await start();
		await act(async () => current.setSelectedIndex(0));
		search.mockResolvedValue({ ...response, ignoreComments: true });
		await act(async () => current.toggleIgnoreComments());
		expect(current.selectedIndex).toBe(0);
		await act(async () => {
			current.setQuery("latest");
			current.toggleIgnoreComments();
		});
		expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: "latest" }));
		expect(current.isLoading).toBe(false);
		expect(current.totalMatches).toBe(1);
	});
	it.each([undefined, false])(
		"rejects a missing/false acknowledgement (%s) rather than showing unfiltered files",
		async (ack) => {
			await render();
			await start();
			search.mockResolvedValue({ ...response, ignoreComments: ack });
			await act(async () => current.toggleIgnoreComments());
			expect(current.error).toMatch(/Upgrade.*runtime/);
			expect(current.results).toEqual([]);
			expect(current.totalMatches).toBe(0);
		},
	);
	it("replaces an in-flight search on toggle and fences late responses in both directions", async () => {
		const old = deferred<typeof response>();
		const filtered = deferred<typeof response & { ignoreComments: boolean }>();
		search.mockReturnValueOnce(old.promise).mockReturnValueOnce(filtered.promise);
		await render();
		await start();
		await act(async () => current.toggleIgnoreComments());
		expect(search).toHaveBeenCalledTimes(2);
		await act(async () => filtered.resolve({ ...response, ignoreComments: true }));
		await act(async () => old.resolve({ files: [], totalMatches: 0, truncated: false }));
		expect(current.totalMatches).toBe(1);
		const late = deferred<typeof response>();
		search.mockReturnValueOnce(late.promise);
		await act(async () => current.toggleIgnoreComments());
		search.mockResolvedValue({ ...response, ignoreComments: true });
		await act(async () => current.toggleIgnoreComments());
		await act(async () => late.resolve({ files: [], totalMatches: 0, truncated: false }));
		expect(current.totalMatches).toBe(1);
	});
	it.each(["task", "ref", "baseRef", "project", "query", "unmount"])(
		"fences a late request after %s changes",
		async (change) => {
			const late = deferred<typeof response>();
			search.mockReturnValueOnce(late.promise);
			await render();
			await start();
			if (change === "task") await render({ taskId: "other" });
			else if (change === "ref") await render({ taskId: null, ref: "main" });
			else if (change === "baseRef") await render({ taskId: null, baseRef: "main" });
			else if (change === "project") await render({ taskId: null }, "other");
			else if (change === "query") await act(async () => current.setQuery("changed"));
			else await act(async () => root.render(null));
			await act(async () => late.resolve(response));
			expect(current.totalMatches).toBe(0);
			expect(current.results).toEqual([]);
		},
	);
});
