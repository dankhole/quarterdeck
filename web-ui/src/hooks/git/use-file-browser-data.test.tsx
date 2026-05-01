import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listFilesQueryMock = vi.hoisted(() => vi.fn());
const getRuntimeTrpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: getRuntimeTrpcClientMock,
}));

import { type UseFileBrowserDataResult, useFileBrowserData } from "@/hooks/git/use-file-browser-data";
import type { RuntimeListFilesResponse } from "@/runtime/types";

function HookHarness({
	taskId,
	onResult,
}: {
	taskId: string | null;
	onResult: (result: UseFileBrowserDataResult) => void;
}): null {
	const result = useFileBrowserData({
		projectId: "project-1",
		taskId,
		baseRef: taskId ? "main" : undefined,
	});
	onResult(result);
	return null;
}

function pendingListFilesResponse(): Promise<RuntimeListFilesResponse> {
	return new Promise(() => {});
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
		getRuntimeTrpcClientMock.mockReset();
		getRuntimeTrpcClientMock.mockReturnValue({
			project: {
				listFiles: { query: listFilesQueryMock },
				getFileContent: { query: vi.fn() },
				saveFileContent: { mutate: vi.fn() },
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
});
