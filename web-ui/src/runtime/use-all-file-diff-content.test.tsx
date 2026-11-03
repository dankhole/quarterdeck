import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeFileDiffResponse, RuntimeWorkdirFileChange } from "@/runtime/types";
import { type UseAllFileDiffContentResult, useAllFileDiffContent } from "@/runtime/use-all-file-diff-content";

const getFileDiffQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			getFileDiff: {
				query: getFileDiffQueryMock,
			},
		},
	}),
}));

const BASE_FILE: Omit<RuntimeWorkdirFileChange, "path"> = {
	status: "modified",
	additions: 1,
	deletions: 1,
	oldText: null,
	newText: null,
};

function createFile(path: string, contentRevision = `${path}:1`): RuntimeWorkdirFileChange {
	return { ...BASE_FILE, path, contentRevision };
}

function createDiff(oldText: string, newText: string): RuntimeFileDiffResponse {
	return { path: "", oldText, newText };
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function getRequestedPaths(): string[] {
	return getFileDiffQueryMock.mock.calls.map(([input]) => (input as { path: string }).path);
}

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForExpectation(assertion: () => void): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await act(async () => {
				await flushAsync();
			});
		}
	}
	throw lastError;
}

function HookHarness({
	files,
	filesRevision,
	projectId = "project-1",
	taskId = "task-1",
	baseRef = "main",
	priorityPaths,
	prefetchRemaining,
	backgroundPrefetchLimit,
	onResult,
}: {
	files: RuntimeWorkdirFileChange[];
	filesRevision: number;
	projectId?: string;
	taskId?: string;
	baseRef?: string;
	priorityPaths?: readonly string[];
	prefetchRemaining?: boolean;
	backgroundPrefetchLimit?: number;
	onResult: (result: UseAllFileDiffContentResult) => void;
}): null {
	const result = useAllFileDiffContent({
		projectId,
		taskId,
		baseRef,
		mode: "working_copy",
		files,
		filesRevision,
		priorityPaths,
		prefetchRemaining,
		backgroundPrefetchLimit,
	});
	onResult(result);
	return null;
}

describe("useAllFileDiffContent", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let latestResult: UseAllFileDiffContentResult | null;

	beforeEach(() => {
		getFileDiffQueryMock.mockReset();
		latestResult = null;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderHarness(props: Omit<Parameters<typeof HookHarness>[0], "onResult">): Promise<void> {
		await act(async () => {
			root.render(
				<HookHarness
					{...props}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
			await flushAsync();
		});
	}

	it("distinguishes initial failures from successfully fetched empty content without automatic retry", async () => {
		getFileDiffQueryMock
			.mockRejectedValueOnce(new Error("diff unavailable"))
			.mockResolvedValueOnce({ path: "src/empty.ts", oldText: null, newText: null });
		const props = {
			files: [createFile("src/failed.ts"), createFile("src/empty.ts")],
			filesRevision: 1,
			priorityPaths: ["src/failed.ts", "src/empty.ts"],
			prefetchRemaining: false,
		};

		await renderHarness(props);
		expect(latestResult?.fileLoadingState.errors?.get("src/failed.ts")).toBe("diff unavailable");
		expect(latestResult?.fileLoadingState.loaded.has("src/failed.ts")).toBe(false);
		expect(latestResult?.fileLoadingState.loaded.has("src/empty.ts")).toBe(true);
		expect(latestResult?.fileLoadingState.errors?.has("src/empty.ts")).toBe(false);
		expect(latestResult?.fileLoadingState.loading.size).toBe(0);
		expect(latestResult?.enrichedFiles?.map((file) => file.newText)).toEqual([null, null]);

		await renderHarness(props);
		expect(getFileDiffQueryMock).toHaveBeenCalledTimes(2);
	});

	it("clears an initial failure after a later source revision succeeds", async () => {
		getFileDiffQueryMock
			.mockRejectedValueOnce("transport closed")
			.mockResolvedValueOnce(createDiff("old\n", "recovered\n"));
		const props = { files: [createFile("src/a.ts")], filesRevision: 1, priorityPaths: ["src/a.ts"] };

		await renderHarness(props);
		expect(latestResult?.fileLoadingState.errors?.get("src/a.ts")).toBe("Failed to load file diff.");

		await renderHarness({ ...props, filesRevision: 2 });
		expect(getFileDiffQueryMock).toHaveBeenCalledTimes(2);
		expect(latestResult?.fileLoadingState.errors?.size).toBe(0);
		expect(latestResult?.fileLoadingState.loaded.has("src/a.ts")).toBe(true);
		expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("recovered\n");
	});

	it("removes failed paths from error state when files are removed", async () => {
		getFileDiffQueryMock.mockRejectedValue(new Error("unavailable"));
		await renderHarness({ files: [createFile("src/a.ts"), createFile("src/b.ts")], filesRevision: 1 });
		expect(latestResult?.fileLoadingState.errors?.size).toBe(2);

		await renderHarness({ files: [createFile("src/b.ts")], filesRevision: 2, prefetchRemaining: false });
		expect(Array.from(latestResult?.fileLoadingState.errors?.keys() ?? [])).toEqual(["src/b.ts"]);

		await renderHarness({ files: [], filesRevision: 3 });
		expect(latestResult?.fileLoadingState.errors?.size).toBe(0);
	});

	it.each(["projectId", "taskId", "baseRef"] as const)(
		"clears errors and cached content when %s changes with the same files array",
		async (contextField) => {
			getFileDiffQueryMock
				.mockResolvedValueOnce(createDiff("old cached\n", "cached\n"))
				.mockRejectedValueOnce(new Error("refresh unavailable"));
			const props = {
				files: [createFile("src/a.ts", "revision-1")],
				filesRevision: 1,
				priorityPaths: ["src/a.ts"],
			};
			await renderHarness(props);
			const changedFiles = [createFile("src/a.ts", "revision-2")];
			await renderHarness({ ...props, files: changedFiles, filesRevision: 2 });
			expect(latestResult?.fileLoadingState.errors?.get("src/a.ts")).toBe("refresh unavailable");
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("cached\n");

			const pending = createDeferred<RuntimeFileDiffResponse>();
			getFileDiffQueryMock.mockReturnValueOnce(pending.promise);
			await renderHarness({ ...props, files: changedFiles, filesRevision: 2, [contextField]: "new-context" });
			expect(latestResult?.fileLoadingState.errors?.size).toBe(0);
			expect(latestResult?.fileLoadingState.loaded.size).toBe(0);
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBeNull();

			await act(async () => {
				pending.resolve(createDiff("old new context\n", "new context\n"));
				await flushAsync();
			});
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new context\n");
		},
	);

	it.each(["context", "revision", "removal"] as const)("ignores stale failures after a %s change", async (change) => {
		const stale = createDeferred<RuntimeFileDiffResponse>();
		getFileDiffQueryMock
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValueOnce(createDiff("old current\n", "current\n"));
		const props = { files: [createFile("src/a.ts")], filesRevision: 1, priorityPaths: ["src/a.ts", "src/b.ts"] };
		await renderHarness(props);
		await renderHarness({
			...props,
			...(change === "context" ? { taskId: "new-task" } : {}),
			...(change === "revision" ? { files: [createFile("src/a.ts", "revision-2")], filesRevision: 2 } : {}),
			...(change === "removal" ? { files: [createFile("src/b.ts")], filesRevision: 2 } : {}),
		});
		expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("current\n");

		await act(async () => {
			stale.reject(new Error("stale failure"));
			await flushAsync();
		});
		expect(latestResult?.fileLoadingState.errors?.size).toBe(0);
		expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("current\n");
	});

	it("fetches the selected priority path before non-selected paths", async () => {
		getFileDiffQueryMock.mockImplementation((input: { path: string }) =>
			Promise.resolve(createDiff(`old ${input.path}\n`, `new ${input.path}\n`)),
		);

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/selected.ts"), createFile("src/c.ts")]}
					filesRevision={1}
					priorityPaths={["src/selected.ts"]}
					backgroundPrefetchLimit={2}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});

		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(3);
		});
		expect(getRequestedPaths()).toEqual(["src/selected.ts", "src/a.ts", "src/c.ts"]);
		expect(latestResult?.enrichedFiles?.find((file) => file.path === "src/selected.ts")?.newText).toBe(
			"new src/selected.ts\n",
		);
	});

	it("fetches visible priority paths before bounded background paths", async () => {
		getFileDiffQueryMock.mockImplementation((input: { path: string }) =>
			Promise.resolve(createDiff(`old ${input.path}\n`, `new ${input.path}\n`)),
		);

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts"), createFile("src/c.ts"), createFile("src/d.ts")]}
					filesRevision={1}
					priorityPaths={["src/c.ts", "src/b.ts"]}
					backgroundPrefetchLimit={2}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});

		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(4);
		});
		expect(getRequestedPaths()).toEqual(["src/c.ts", "src/b.ts", "src/a.ts", "src/d.ts"]);
	});

	it("does not require non-priority files before the first meaningful render", async () => {
		let resolveSelected: ((value: RuntimeFileDiffResponse) => void) | null = null;
		getFileDiffQueryMock.mockImplementation(
			() =>
				new Promise<RuntimeFileDiffResponse>((resolve) => {
					resolveSelected = resolve;
				}),
		);

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/selected.ts"), createFile("src/c.ts")]}
					filesRevision={1}
					priorityPaths={["src/selected.ts"]}
					prefetchRemaining={false}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});

		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(1);
			expect(latestResult?.enrichedFiles).toHaveLength(3);
		});
		expect(getRequestedPaths()).toEqual(["src/selected.ts"]);
		expect(latestResult?.enrichedFiles?.find((file) => file.path === "src/a.ts")?.newText).toBeNull();
		expect(latestResult?.enrichedFiles?.find((file) => file.path === "src/c.ts")?.newText).toBeNull();

		await act(async () => {
			resolveSelected?.(createDiff("old selected\n", "new selected\n"));
			await flushAsync();
		});

		expect(latestResult?.enrichedFiles?.find((file) => file.path === "src/selected.ts")?.newText).toBe(
			"new selected\n",
		);
		expect(getFileDiffQueryMock).toHaveBeenCalledTimes(1);
	});

	it("ignores stale diff responses after the file context changes", async () => {
		let resolveStale: ((value: RuntimeFileDiffResponse) => void) | null = null;
		getFileDiffQueryMock.mockImplementation((input: { path: string }) => {
			if (input.path === "src/a.ts") {
				return new Promise<RuntimeFileDiffResponse>((resolve) => {
					resolveStale = resolve;
				});
			}
			return Promise.resolve(createDiff("old b\n", "new b\n"));
		});

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts")]}
					filesRevision={1}
					priorityPaths={["src/a.ts"]}
					prefetchRemaining={false}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getRequestedPaths()).toEqual(["src/a.ts"]);
		});

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/b.ts")]}
					filesRevision={2}
					priorityPaths={["src/b.ts"]}
					prefetchRemaining={false}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getRequestedPaths()).toEqual(["src/a.ts", "src/b.ts"]);
			expect(latestResult?.enrichedFiles?.[0]?.path).toBe("src/b.ts");
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new b\n");
		});

		await act(async () => {
			resolveStale?.(createDiff("old a\n", "stale a\n"));
			await flushAsync();
		});

		expect(latestResult?.enrichedFiles).toHaveLength(1);
		expect(latestResult?.enrichedFiles?.[0]?.path).toBe("src/b.ts");
		expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new b\n");
	});

	it("keeps enriched file references when only the response revision changes", async () => {
		getFileDiffQueryMock.mockResolvedValue(createDiff("old a\n", "new a\n"));
		const firstFiles = [createFile("src/a.ts")];

		await act(async () => {
			root.render(
				<HookHarness
					files={firstFiles}
					filesRevision={1}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(1);
			expect(latestResult?.enrichedFiles?.[0]?.oldText).toBe("old a\n");
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new a\n");
		});

		const firstEnrichedFiles = latestResult?.enrichedFiles;

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts")]}
					filesRevision={2}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(1);
		});

		expect(latestResult?.enrichedFiles).toBe(firstEnrichedFiles);
		expect(latestResult?.enrichedFiles?.[0]).toBe(firstEnrichedFiles?.[0]);
	});

	it("replaces only the file entry whose fetched diff text changed", async () => {
		getFileDiffQueryMock
			.mockResolvedValueOnce(createDiff("old a\n", "new a\n"))
			.mockResolvedValueOnce(createDiff("old b\n", "new b\n"))
			.mockResolvedValueOnce(createDiff("old b\n", "newer b\n"));

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts")]}
					filesRevision={1}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(2);
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new a\n");
			expect(latestResult?.enrichedFiles?.[1]?.newText).toBe("new b\n");
		});

		const firstEnrichedFiles = latestResult?.enrichedFiles;
		const firstA = firstEnrichedFiles?.[0];
		const firstB = firstEnrichedFiles?.[1];

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts", "src/b.ts:2")]}
					filesRevision={2}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(3);
			expect(latestResult?.enrichedFiles?.[1]?.newText).toBe("newer b\n");
		});

		expect(latestResult?.enrichedFiles).not.toBe(firstEnrichedFiles);
		expect(latestResult?.enrichedFiles?.[0]).toBe(firstA);
		expect(latestResult?.enrichedFiles?.[1]).not.toBe(firstB);
		expect(latestResult?.enrichedFiles?.[1]?.newText).toBe("newer b\n");
	});

	it("preserves cached diff content when a background prefetch refresh fails", async () => {
		getFileDiffQueryMock
			.mockResolvedValueOnce(createDiff("old a\n", "new a\n"))
			.mockResolvedValueOnce(createDiff("old b\n", "new b\n"))
			.mockRejectedValueOnce(new Error("boom"));

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts")]}
					filesRevision={1}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(2);
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new a\n");
			expect(latestResult?.enrichedFiles?.[1]?.newText).toBe("new b\n");
		});

		const firstEnrichedFiles = latestResult?.enrichedFiles;
		const firstA = firstEnrichedFiles?.[0];
		const firstB = firstEnrichedFiles?.[1];

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts", "src/b.ts:2")]}
					filesRevision={2}
					priorityPaths={["src/a.ts"]}
					backgroundPrefetchLimit={1}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(3);
		});

		expect(latestResult?.enrichedFiles).toBe(firstEnrichedFiles);
		expect(latestResult?.enrichedFiles?.[0]).toBe(firstA);
		expect(latestResult?.enrichedFiles?.[1]).toBe(firstB);
		expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new a\n");
		expect(latestResult?.enrichedFiles?.[1]?.newText).toBe("new b\n");
		expect(latestResult?.fileLoadingState.errors?.get("src/b.ts")).toBe("boom");
		expect(latestResult?.fileLoadingState.loaded.has("src/b.ts")).toBe(true);

		getFileDiffQueryMock.mockResolvedValueOnce(createDiff("old b\n", "recovered b\n"));
		await renderHarness({
			files: [createFile("src/a.ts"), createFile("src/b.ts", "src/b.ts:3")],
			filesRevision: 3,
			priorityPaths: ["src/b.ts"],
			prefetchRemaining: false,
		});
		expect(latestResult?.fileLoadingState.errors?.size).toBe(0);
		expect(latestResult?.enrichedFiles?.[1]?.newText).toBe("recovered b\n");
	});

	it("retries an uncached background prefetch failure when the file becomes priority", async () => {
		const backgroundPrefetch = createDeferred<RuntimeFileDiffResponse>();
		getFileDiffQueryMock
			.mockResolvedValueOnce(createDiff("old a\n", "new a\n"))
			.mockReturnValueOnce(backgroundPrefetch.promise)
			.mockResolvedValueOnce(createDiff("old b\n", "new b after retry\n"));

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts")]}
					filesRevision={1}
					priorityPaths={["src/a.ts"]}
					backgroundPrefetchLimit={1}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getRequestedPaths()).toEqual(["src/a.ts", "src/b.ts"]);
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new a\n");
		});

		await act(async () => {
			backgroundPrefetch.reject(new Error("background boom"));
			await flushAsync();
		});
		expect(latestResult?.enrichedFiles?.[1]?.newText).toBeNull();
		expect(latestResult?.fileLoadingState.loaded.has("src/b.ts")).toBe(false);
		expect(latestResult?.fileLoadingState.errors?.get("src/b.ts")).toBe("background boom");

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts")]}
					filesRevision={1}
					priorityPaths={["src/b.ts"]}
					backgroundPrefetchLimit={1}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});

		await waitForExpectation(() => {
			expect(getRequestedPaths()).toEqual(["src/a.ts", "src/b.ts", "src/b.ts"]);
			expect(latestResult?.enrichedFiles?.[1]?.newText).toBe("new b after retry\n");
			expect(latestResult?.fileLoadingState.errors?.has("src/b.ts")).toBe(false);
		});
	});

	it("reuses in-flight diff requests when priority changes restart fetching", async () => {
		const firstDiff = createDeferred<RuntimeFileDiffResponse>();
		getFileDiffQueryMock.mockImplementation((input: { path: string }) => {
			if (input.path === "src/a.ts") {
				return firstDiff.promise;
			}
			return Promise.resolve(createDiff("old b\n", "new b\n"));
		});

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts")]}
					filesRevision={1}
					priorityPaths={["src/a.ts"]}
					prefetchRemaining={false}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getRequestedPaths()).toEqual(["src/a.ts"]);
			expect(latestResult?.fileLoadingState.loading.has("src/a.ts")).toBe(true);
		});

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts"), createFile("src/b.ts")]}
					filesRevision={1}
					priorityPaths={["src/b.ts", "src/a.ts"]}
					prefetchRemaining={false}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getRequestedPaths()).toEqual(["src/a.ts", "src/b.ts"]);
			expect(latestResult?.enrichedFiles?.[1]?.newText).toBe("new b\n");
		});

		await act(async () => {
			firstDiff.resolve(createDiff("old a\n", "new a\n"));
			await flushAsync();
		});

		await waitForExpectation(() => {
			expect(getRequestedPaths()).toEqual(["src/a.ts", "src/b.ts"]);
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new a\n");
		});
	});
});
