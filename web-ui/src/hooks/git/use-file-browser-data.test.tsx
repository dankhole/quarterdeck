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

import { createFileBrowserContentScopeKey } from "@/hooks/git/file-browser-scope";
import { setLastSelectedFileBrowserPath } from "@/hooks/git/file-browser-selection-cache";
import {
	clearCachedFileEditorTabs,
	registerFileEditorScope,
	retireFileEditorScopes,
} from "@/hooks/git/file-editor-cache";
import { type UseFileBrowserDataResult, useFileBrowserData } from "@/hooks/git/use-file-browser-data";
import type { RuntimeFileContentResponse, RuntimeListFilesResponse } from "@/runtime/types";

function HookHarness({
	taskId,
	browseRef,
	enabled = true,
	onResult,
}: {
	taskId: string | null;
	browseRef?: string;
	enabled?: boolean;
	onResult: (result: UseFileBrowserDataResult) => void;
}): null {
	const result = useFileBrowserData({
		projectId: "project-1",
		taskId,
		baseRef: taskId ? "main" : undefined,
		ref: browseRef,
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
		clearCachedFileEditorTabs();
		for (const ref of [undefined, "main"]) {
			setLastSelectedFileBrowserPath(
				createFileBrowserContentScopeKey({ projectId: "project-1", taskId: null, ref }),
				null,
			);
		}
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
		clearCachedFileEditorTabs();
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

	it("admits unlisted runtime navigation targets as read-only while clearing ordinary missing selections", async () => {
		let latest: UseFileBrowserDataResult | undefined;
		const current = () => {
			if (!latest) throw new Error("No browser result");
			return latest;
		};
		listFilesQueryMock.mockResolvedValue({ files: ["src/home.ts"], directories: ["src"], mutable: true });
		getFileContentQueryMock.mockResolvedValue({ ...contentResponse("declaration", "hash"), editable: true });
		await act(async () =>
			root.render(
				<HookHarness
					taskId={null}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			),
		);

		await act(async () => current().onSelectPath("missing.ts"));
		expect(current().selectedPath).toBeNull();

		const target = "node_modules/dependency/index.d.ts";
		await act(async () => current().onSelectNavigationTarget(target));
		expect(current().selectedPath).toBe(target);
		expect(current().fileContent).toMatchObject({ content: "declaration", editable: false });
		await act(async () => {
			await expect(current().reloadFileContent(target)).resolves.toMatchObject({ editable: false });
		});
		await expect(current().saveFileContent(target, "edited", "hash")).rejects.toThrow("read-only");
		expect(saveFileContentMutateMock).not.toHaveBeenCalled();

		await act(async () => current().onSelectPath("src/home.ts"));
		expect(current().fileContent?.editable).toBe(true);
		await act(async () => current().onSelectPath(target));
		expect(current().selectedPath).toBe(target);
		expect(current().fileContent?.editable).toBe(false);
	});

	it("expires navigation admission when the same workspace is retired and recreated", async () => {
		let latest: UseFileBrowserDataResult | undefined;
		const current = () => {
			if (!latest) throw new Error("No browser result");
			return latest;
		};
		const identity = { projectId: "project-1", taskId: null };
		const scopeKey = createFileBrowserContentScopeKey(identity);
		registerFileEditorScope(scopeKey, identity);
		listFilesQueryMock.mockResolvedValue({ files: ["src/home.ts"], directories: ["src"], mutable: true });
		getFileContentQueryMock.mockResolvedValue(contentResponse("declaration", "hash"));
		await act(async () =>
			root.render(
				<HookHarness
					taskId={null}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			),
		);
		const staleSelect = current().onSelectNavigationTarget;
		await act(async () => staleSelect("node_modules/dependency/index.d.ts"));
		expect(current().selectedPath).toBe("node_modules/dependency/index.d.ts");
		await act(async () => {
			retireFileEditorScopes({ projectId: "project-1" });
			registerFileEditorScope(scopeKey, identity);
		});
		expect(current().selectedPath).toBeNull();
		await act(async () => staleSelect("node_modules/dependency/index.d.ts"));
		expect(current().selectedPath).toBeNull();
		await act(async () => current().onSelectNavigationTarget("node_modules/dependency/index.d.ts"));
		expect(current().selectedPath).toBe("node_modules/dependency/index.d.ts");
	});

	it("clears an ordinary selected file when the next file listing removes it", async () => {
		vi.useFakeTimers();
		let latest: UseFileBrowserDataResult | undefined;
		const current = () => {
			if (!latest) throw new Error("No browser result");
			return latest;
		};
		listFilesQueryMock.mockResolvedValue({ files: ["src/home.ts"], directories: ["src"], mutable: true });
		getFileContentQueryMock.mockResolvedValue(contentResponse("source", "hash"));
		await act(async () =>
			root.render(
				<HookHarness
					taskId={null}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			),
		);
		await act(async () => current().onSelectPath("src/home.ts"));
		expect(current().selectedPath).toBe("src/home.ts");
		listFilesQueryMock.mockResolvedValue({ files: [], directories: [], mutable: true });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(current().selectedPath).toBeNull();
	});

	it("does not admit live navigation targets into another scope or a read-only ref", async () => {
		let latest: UseFileBrowserDataResult | undefined;
		const current = () => {
			if (!latest) throw new Error("No browser result");
			return latest;
		};
		const capture = (result: UseFileBrowserDataResult) => {
			latest = result;
		};
		listFilesQueryMock.mockResolvedValue({ files: ["src/home.ts"], directories: ["src"], mutable: true });
		getFileContentQueryMock.mockResolvedValue(contentResponse("declaration", "hash"));
		await act(async () => root.render(<HookHarness taskId={null} onResult={capture} />));
		const staleSelect = current().onSelectNavigationTarget;
		await act(async () => current().onSelectNavigationTarget("node_modules/dependency/index.d.ts"));
		await act(async () => root.render(<HookHarness taskId={null} browseRef="main" onResult={capture} />));
		await act(async () => {
			staleSelect("node_modules/dependency/index.d.ts");
			current().onSelectNavigationTarget("node_modules/dependency/index.d.ts");
		});
		expect(current().selectedPath).toBeNull();
		expect(current().isReadOnly).toBe(true);
		await act(async () => current().onSelectPath("src/home.ts"));
		expect(current().selectedPath).toBe("src/home.ts");
		await expect(current().saveFileContent("src/home.ts", "edited", "hash")).rejects.toThrow("read-only");
	});
});
