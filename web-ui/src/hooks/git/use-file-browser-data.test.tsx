import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileTreePage } from "@/test-utils/file-tree";

const createEntryMock = vi.hoisted(() => vi.fn());
const renameEntryMock = vi.hoisted(() => vi.fn());
const deleteEntryMock = vi.hoisted(() => vi.fn());
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
		createEntryMock.mockReset();
		renameEntryMock.mockReset();
		deleteEntryMock.mockReset();
		getFileContentQueryMock.mockReset();
		saveFileContentMutateMock.mockReset();
		getRuntimeTrpcClientMock.mockReset();
		getRuntimeTrpcClientMock.mockReturnValue({
			project: {
				listFiles: { query: listFilesQueryMock },
				getFileContent: { query: getFileContentQueryMock },
				saveFileContent: { mutate: saveFileContentMutateMock },
				createWorkdirEntry: { mutate: createEntryMock },
				renameWorkdirEntry: { mutate: renameEntryMock },
				deleteWorkdirEntry: { mutate: deleteEntryMock },
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

		listFilesQueryMock.mockResolvedValueOnce(
			fileTreePage({
				files: ["src/home.ts"],
				directories: ["src"],
				mutable: true,
			}) satisfies RuntimeListFilesResponse,
		);

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

	it("exposes listing errors and recovers on polling without clearing the selected file content", async () => {
		vi.useFakeTimers();
		let latest: UseFileBrowserDataResult | undefined;
		const current = () => {
			if (!latest) throw new Error("No browser result");
			return latest;
		};
		const listing = fileTreePage({ files: ["src/home.ts"], directories: ["src"], mutable: true });
		const content = contentResponse("source", "hash");
		const error = new Error("File tree exceeds the 20,000-entry limit.");
		listFilesQueryMock.mockResolvedValue(listing);
		getFileContentQueryMock.mockResolvedValue(content);
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

		listFilesQueryMock.mockRejectedValue(error);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(current().fileListError).toBe(error);
		expect(current().files).toEqual(["src/home.ts"]);
		expect(current().canMutateEntries).toBe(false);
		expect(current().mutationBlockedReason).toBe(error.message);
		await expect(current().createEntry("new.ts", "file")).rejects.toThrow(error.message);
		expect(current().selectedPath).toBe("src/home.ts");
		expect(current().fileContent).toEqual(content);
		expect(current().isContentError).toBe(false);

		listFilesQueryMock.mockResolvedValue(listing);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(current().fileListError).toBeNull();
		expect(current().files).toEqual(["src/home.ts"]);
		expect(current().canMutateEntries).toBe(true);
		expect(current().mutationBlockedReason).toBeNull();
		expect(current().selectedPath).toBe("src/home.ts");
		expect(current().fileContent).toEqual(content);
	});

	it("hides an old scope's listing error immediately and ignores its late retry failure", async () => {
		vi.useFakeTimers();
		let latest: UseFileBrowserDataResult | undefined;
		const capture = (result: UseFileBrowserDataResult) => {
			latest = result;
		};
		const current = () => {
			if (!latest) throw new Error("No browser result");
			return latest;
		};
		listFilesQueryMock.mockRejectedValueOnce(new Error("Home tree exceeds the entry limit."));
		await act(async () => root.render(<HookHarness taskId={null} onResult={capture} />));
		expect(current().fileListError?.message).toBe("Home tree exceeds the entry limit.");

		const newScopeResults: UseFileBrowserDataResult[] = [];
		let resolveTask: (value: RuntimeListFilesResponse) => void = () => {
			throw new Error("Missing task request");
		};
		listFilesQueryMock.mockImplementation(
			() => new Promise<RuntimeListFilesResponse>((resolve) => (resolveTask = resolve)),
		);
		await act(async () =>
			root.render(
				<HookHarness
					taskId="listing-error-task"
					onResult={(result) => {
						capture(result);
						newScopeResults.push(result);
					}}
				/>,
			),
		);
		expect(newScopeResults.every((result) => result.fileListError === null)).toBe(true);
		expect(current().files).toBeNull();
		await act(async () => resolveTask(fileTreePage({ files: ["task.ts"], directories: [], mutable: true })));
		expect(current().fileListError).toBeNull();
		expect(current().files).toEqual(["task.ts"]);

		let rejectTask: (error: Error) => void = () => {
			throw new Error("Missing task retry");
		};
		listFilesQueryMock.mockImplementationOnce(
			() => new Promise<RuntimeListFilesResponse>((_resolve, reject) => (rejectTask = reject)),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		listFilesQueryMock.mockResolvedValue(fileTreePage({ files: ["home.ts"], directories: [], mutable: true }));
		await act(async () => root.render(<HookHarness taskId={null} onResult={capture} />));
		await act(async () => rejectTask(new Error("Retired task tree failed.")));
		expect(current().fileListError).toBeNull();
		expect(current().files).toEqual(["home.ts"]);
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

		listFilesQueryMock.mockResolvedValue(
			fileTreePage({
				files: ["src/home.ts"],
				directories: ["src"],
				mutable: true,
			}) satisfies RuntimeListFilesResponse,
		);
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

	it("uses authoritative dependency editability without applying a tree-membership mask", async () => {
		let latest: UseFileBrowserDataResult | undefined;
		const current = () => {
			if (!latest) throw new Error("No browser result");
			return latest;
		};
		listFilesQueryMock.mockResolvedValue(
			fileTreePage({ files: ["src/home.ts"], directories: ["src"], mutable: true }),
		);
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
		expect(current().selectedPath).toBe("missing.ts");
		expect(current().fileContent?.editable).toBe(true);

		const target = "node_modules/dependency/index.d.ts";
		getFileContentQueryMock.mockImplementation(async ({ path }: { path: string }) => ({
			...contentResponse("declaration", "hash"),
			editable: path !== target,
			...(path === target ? { editBlockedReason: "Dependency files are read-only." } : {}),
		}));
		saveFileContentMutateMock.mockRejectedValue(new Error("Dependency files are read-only."));
		await act(async () => current().onSelectNavigationTarget(target));
		expect(current().selectedPath).toBe(target);
		expect(current().fileContent).toMatchObject({ content: "declaration", editable: false });
		await act(async () => {
			await expect(current().reloadFileContent(target)).resolves.toMatchObject({ editable: false });
		});
		await expect(current().saveFileContent(target, "edited", "hash")).rejects.toThrow("read-only");
		expect(saveFileContentMutateMock).toHaveBeenCalledOnce();

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
		listFilesQueryMock.mockResolvedValue(
			fileTreePage({ files: ["src/home.ts"], directories: ["src"], mutable: true }),
		);
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

	it("preserves an ordinary selected file when a reset page does not contain it", async () => {
		vi.useFakeTimers();
		let latest: UseFileBrowserDataResult | undefined;
		const current = () => {
			if (!latest) throw new Error("No browser result");
			return latest;
		};
		listFilesQueryMock.mockResolvedValue(
			fileTreePage({ files: ["src/home.ts"], directories: ["src"], mutable: true }),
		);
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
		listFilesQueryMock.mockResolvedValue(fileTreePage({ files: [], directories: [], mutable: true }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(current().selectedPath).toBe("src/home.ts");
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
		listFilesQueryMock.mockResolvedValue(
			fileTreePage({ files: ["src/home.ts"], directories: ["src"], mutable: true }),
		);
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
		await act(async () => current().onSelectPath("unopened/snapshot.ts"));
		expect(current().selectedPath).toBe("unopened/snapshot.ts");
		await expect(current().saveFileContent("unopened/snapshot.ts", "edited", "hash")).rejects.toThrow("read-only");
	});
	it.each(["create", "rename", "delete"])(
		"applies successful %s receipts even when parent refresh fails",
		async (operation) => {
			let latest!: UseFileBrowserDataResult;
			listFilesQueryMock.mockResolvedValue(fileTreePage({ files: ["old.ts"] }));
			getFileContentQueryMock.mockResolvedValue({ ...contentResponse("source", "hash"), editable: true });
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
			await act(async () => latest.onSelectPath("old.ts"));
			const response = { path: operation === "delete" ? "old.ts" : "unopened/new.ts", kind: "file" as const };
			createEntryMock.mockResolvedValue(response);
			renameEntryMock.mockResolvedValue(response);
			deleteEntryMock.mockResolvedValue(response);
			listFilesQueryMock.mockRejectedValue(new Error("refresh offline"));
			await act(async () => {
				const result =
					operation === "create"
						? await latest.createEntry(response.path, "file")
						: operation === "rename"
							? await latest.renameEntry("old.ts", response.path, "file")
							: await latest.deleteEntry("old.ts", "file");
				expect(result).toEqual(response);
			});
			expect(latest.selectedPath).toBe(operation === "delete" ? null : response.path);
			if (operation !== "create") expect(latest.files).not.toContain("old.ts");
			if (operation !== "delete") {
				expect(latest.files).toContain(response.path);
				expect(latest.directories).toContain("unopened");
			}
			expect(latest.fileListError?.message).toBe("refresh offline");
		},
	);

	it("restores an unlisted path and keeps server-admitted search selections editable through toggle changes", async () => {
		let latest!: UseFileBrowserDataResult;
		setLastSelectedFileBrowserPath(
			createFileBrowserContentScopeKey({ projectId: "project-1", taskId: null }),
			"unopened/restored.ts",
		);
		listFilesQueryMock.mockResolvedValue(fileTreePage({ files: ["first.ts"] }));
		getFileContentQueryMock.mockResolvedValue({ ...contentResponse("source", "hash"), editable: true });
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
		expect(latest.selectedPath).toBe("unopened/restored.ts");
		expect(latest.fileContent?.editable).toBe(true);
		await act(async () => latest.onSelectPath("unopened/search.ts"));
		await act(async () => latest.setShowExcluded(true));
		expect(latest.selectedPath).toBe("unopened/search.ts");
		expect(latest.fileContent?.editable).toBe(true);
	});
	it("keeps unexpanded workspace navigation editable across toggle and enumeration reset", async () => {
		vi.useFakeTimers();
		let latest!: UseFileBrowserDataResult;
		listFilesQueryMock.mockResolvedValue(fileTreePage({ files: ["first.ts"] }));
		getFileContentQueryMock.mockResolvedValue({ ...contentResponse("workspace", "hash"), editable: true });
		saveFileContentMutateMock.mockResolvedValue({ ...contentResponse("edited", "next"), editable: true });
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
		await act(async () => latest.onSelectNavigationTarget("unexpanded/target.ts"));
		expect(latest.fileContent?.editable).toBe(true);
		await act(async () => latest.setShowExcluded(true));
		listFilesQueryMock.mockResolvedValue(fileTreePage({ snapshotId: "reset", files: [] }));
		await act(async () => vi.advanceTimersByTimeAsync(35_000));
		expect(latest.selectedPath).toBe("unexpanded/target.ts");
		expect(latest.fileContent?.editable).toBe(true);
		await act(async () => {
			await latest.saveFileContent("unexpanded/target.ts", "edited", "hash");
		});
		expect(saveFileContentMutateMock).toHaveBeenCalledOnce();
		await act(async () => latest.onSelectPath("unexpanded/target.ts"));
		expect(latest.fileContent?.editable).toBe(true);
	});

	it("ordinary selection clears obsolete navigation retirement admission", async () => {
		let latest!: UseFileBrowserDataResult;
		const identity = { projectId: "project-1", taskId: null };
		const key = createFileBrowserContentScopeKey(identity);
		registerFileEditorScope(key, identity);
		listFilesQueryMock.mockResolvedValue(fileTreePage());
		getFileContentQueryMock.mockResolvedValue({ ...contentResponse("workspace", "hash"), editable: true });
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
		await act(async () => latest.onSelectNavigationTarget("unexpanded/target.ts"));
		const staleSave = latest.saveFileContent;
		await act(async () => latest.onSelectPath("unexpanded/target.ts"));
		await act(async () => {
			retireFileEditorScopes({ projectId: "project-1" });
			registerFileEditorScope(key, identity);
		});
		expect(latest.selectedPath).toBe("unexpanded/target.ts");
		await expect(staleSave("unexpanded/target.ts", "edited", "hash")).rejects.toThrow("workspace changed");
		expect(saveFileContentMutateMock).not.toHaveBeenCalled();
	});
});
