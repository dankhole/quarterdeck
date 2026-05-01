import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listFilesQueryMock = vi.hoisted(() => vi.fn());
const getFileContentQueryMock = vi.hoisted(() => vi.fn());
const saveFileContentMutateMock = vi.hoisted(() => vi.fn());
const getRuntimeTrpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: getRuntimeTrpcClientMock,
}));

import { type UseFileBrowserDataResult, useFileBrowserData } from "@/hooks/git/use-file-browser-data";
import type { RuntimeFileContentResponse, RuntimeListFilesResponse } from "@/runtime/types";

function HookHarness({
	taskId,
	enabled = true,
	onResult,
}: {
	taskId: string | null;
	enabled?: boolean;
	onResult: (result: UseFileBrowserDataResult) => void;
}): null {
	const result = useFileBrowserData({
		projectId: "project-1",
		taskId,
		baseRef: taskId ? "main" : undefined,
		enabled,
	});
	onResult(result);
	return null;
}

function pendingListFilesResponse(): Promise<RuntimeListFilesResponse> {
	return new Promise(() => {});
}

function contentResponse(content: string, hash: string): RuntimeFileContentResponse {
	return {
		content,
		language: "typescript",
		binary: false,
		size: content.length,
		truncated: false,
		contentHash: hash,
	};
}

describe("useFileBrowserData", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		localStorage.clear();
		listFilesQueryMock.mockReset();
		getFileContentQueryMock.mockReset();
		saveFileContentMutateMock.mockReset();
		getRuntimeTrpcClientMock.mockReset();
		getRuntimeTrpcClientMock.mockReturnValue({
			project: {
				listFiles: { query: listFilesQueryMock },
				getFileContent: { query: getFileContentQueryMock },
				saveFileContent: { mutate: saveFileContentMutateMock },
				createWorkdirEntry: { mutate: vi.fn() },
				renameWorkdirEntry: { mutate: vi.fn() },
				deleteWorkdirEntry: { mutate: vi.fn() },
			},
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		localStorage.clear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("hides stale file-list data and disables mutations while a new scope loads", async () => {
		let latest: UseFileBrowserDataResult | null = null;
		const getLatest = (): UseFileBrowserDataResult => {
			if (!latest) {
				throw new Error("Expected file browser data result.");
			}
			return latest;
		};

		listFilesQueryMock.mockResolvedValueOnce({
			files: ["src/home.ts"],
			directories: ["src"],
			mutable: true,
		} satisfies RuntimeListFilesResponse);

		await act(async () => {
			root.render(
				<HookHarness
					taskId={null}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(getLatest().files).toEqual(["src/home.ts"]);
		expect(getLatest().canMutateEntries).toBe(true);

		listFilesQueryMock.mockImplementation(() => pendingListFilesResponse());

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-1"
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
		});

		expect(getLatest().files).toBeNull();
		expect(getLatest().directories).toBeNull();
		expect(getLatest().canMutateEntries).toBe(false);
		await expect(getLatest().createEntry("src/home.ts", "file")).rejects.toThrow("Files are still loading.");
	});

	it("skips file-list loading and polling while disabled", async () => {
		vi.useFakeTimers();
		let latest: UseFileBrowserDataResult | null = null;
		const getLatest = (): UseFileBrowserDataResult => {
			if (!latest) {
				throw new Error("Expected file browser data result.");
			}
			return latest;
		};

		listFilesQueryMock.mockResolvedValue({
			files: ["src/home.ts"],
			directories: ["src"],
			mutable: true,
		} satisfies RuntimeListFilesResponse);
		getFileContentQueryMock.mockResolvedValue(contentResponse("const value = 1;\n", "hash-1"));
		saveFileContentMutateMock.mockResolvedValue(contentResponse("const value = 2;\n", "hash-2"));

		await act(async () => {
			root.render(
				<HookHarness
					taskId={null}
					enabled={false}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(listFilesQueryMock).not.toHaveBeenCalled();
		expect(getLatest().searchScope).toEqual({ taskId: null });
		expect(getLatest().canMutateEntries).toBe(false);
		await expect(getLatest().getFileContent("src/home.ts")).resolves.toBeNull();
		await expect(getLatest().reloadFileContent("src/home.ts")).resolves.toBeNull();
		await expect(getLatest().saveFileContent("src/home.ts", "const value = 2;\n", "hash-1")).rejects.toThrow(
			"Files view is not active.",
		);
		await expect(getLatest().createEntry("src/home.ts", "file")).rejects.toThrow("Files view is not active.");
		expect(getFileContentQueryMock).not.toHaveBeenCalled();
		expect(saveFileContentMutateMock).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(15_000);
			await Promise.resolve();
		});

		expect(listFilesQueryMock).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					taskId={null}
					enabled
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(listFilesQueryMock).toHaveBeenCalledTimes(1);
	});
});
