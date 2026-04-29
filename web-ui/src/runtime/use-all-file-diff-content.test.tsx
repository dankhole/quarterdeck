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
	onResult,
}: {
	files: RuntimeWorkdirFileChange[];
	filesRevision: number;
	onResult: (result: UseAllFileDiffContentResult) => void;
}): null {
	const result = useAllFileDiffContent({
		projectId: "project-1",
		taskId: "task-1",
		baseRef: "main",
		mode: "working_copy",
		files,
		filesRevision,
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

	it("preserves cached diff content when a background refresh fails", async () => {
		getFileDiffQueryMock
			.mockResolvedValueOnce(createDiff("old a\n", "new a\n"))
			.mockRejectedValueOnce(new Error("boom"));

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts")]}
					filesRevision={1}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(1);
			expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new a\n");
		});

		const firstEnrichedFiles = latestResult?.enrichedFiles;
		const firstFile = firstEnrichedFiles?.[0];

		await act(async () => {
			root.render(
				<HookHarness
					files={[createFile("src/a.ts", "src/a.ts:2")]}
					filesRevision={2}
					onResult={(result) => {
						latestResult = result;
					}}
				/>,
			);
		});
		await waitForExpectation(() => {
			expect(getFileDiffQueryMock).toHaveBeenCalledTimes(2);
		});

		expect(latestResult?.enrichedFiles).toBe(firstEnrichedFiles);
		expect(latestResult?.enrichedFiles?.[0]).toBe(firstFile);
		expect(latestResult?.enrichedFiles?.[0]?.newText).toBe("new a\n");
	});
});
