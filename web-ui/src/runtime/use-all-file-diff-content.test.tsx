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
	priorityPaths,
	prefetchRemaining,
	backgroundPrefetchLimit,
	onResult,
}: {
	files: RuntimeWorkdirFileChange[];
	filesRevision: number;
	projectId?: string;
	priorityPaths?: readonly string[];
	prefetchRemaining?: boolean;
	backgroundPrefetchLimit?: number;
	onResult: (result: UseAllFileDiffContentResult) => void;
}): null {
	const result = useAllFileDiffContent({
		projectId,
		taskId: "task-1",
		baseRef: "main",
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
