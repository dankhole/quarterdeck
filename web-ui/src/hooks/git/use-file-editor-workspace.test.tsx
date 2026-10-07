import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showAppToastMock = vi.hoisted(() => vi.fn());
const flushRecoveryMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));
vi.mock("./desktop-file-editor-recovery", () => ({
	flushDesktopFileEditorRecovery: flushRecoveryMock,
}));

import {
	getCachedFileEditorTabs,
	getFileEditorDrafts,
	registerFileEditorScope,
	retireFileEditorScopes,
} from "@/hooks/git/file-editor-cache";
import {
	clearCachedFileEditorTabs,
	createFileEditorTab,
	FILE_EDITOR_AUTOSAVE_DELAY_MS,
	setCachedFileEditorTabs,
	updateFileEditorTabValue,
} from "@/hooks/git/file-editor-workspace";
import {
	type UseFileEditorWorkspaceInput,
	type UseFileEditorWorkspaceResult,
	useFileEditorDirtyUnloadGuard,
	useFileEditorWorkspace,
} from "@/hooks/git/use-file-editor-workspace";
import type { RuntimeFileContentResponse } from "@/runtime/types";

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

function HookHarness({
	input,
	onResult,
}: {
	input: UseFileEditorWorkspaceInput;
	onResult: (result: UseFileEditorWorkspaceResult) => void;
}): null {
	const result = useFileEditorWorkspace(input);
	onResult(result);
	return null;
}

function UnloadGuardHarness(): null {
	useFileEditorDirtyUnloadGuard();
	return null;
}

describe("useFileEditorWorkspace", () => {
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
		clearCachedFileEditorTabs();
		showAppToastMock.mockReset();
		flushRecoveryMock.mockReset().mockResolvedValue(true);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		clearCachedFileEditorTabs();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function createInput(overrides: Partial<UseFileEditorWorkspaceInput> = {}): UseFileEditorWorkspaceInput {
		return {
			scopeKey: "project-1:task-1",
			selectedPath: "src/app.ts",
			fileContent: contentResponse("const value = 1;\n", "hash-1"),
			isContentLoading: false,
			isContentError: false,
			isReadOnly: false,
			autosaveMode: "off",
			onSelectPath: () => {},
			onCloseFile: () => {},
			reloadFileContent: async () => contentResponse("const value = 2;\n", "hash-2"),
			saveFileContent: async (_path, content) => contentResponse(content, "hash-saved"),
			...overrides,
		};
	}

	async function mountWorkspace(overrides: Partial<UseFileEditorWorkspaceInput> = {}) {
		let latest: UseFileEditorWorkspaceResult | undefined;
		await act(async () => {
			root.render(
				<HookHarness
					input={createInput(overrides)}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
		});
		return () => {
			if (!latest) throw new Error("Expected file editor workspace result.");
			return latest;
		};
	}

	it("marks source saved before a delayed recovery ACK, preserving newer typing and serializing Save gestures", async () => {
		let acknowledge: (ready: boolean) => void = () => {};
		const recovery = new Promise<boolean>((resolve) => {
			acknowledge = resolve;
		});
		flushRecoveryMock.mockImplementationOnce(() => {
			expect(getCachedFileEditorTabs("project-1:task-1")[0]).toMatchObject({
				savedValue: "first draft",
				value: "first draft",
				isSaving: false,
				contentHash: "hash-saved",
			});
			return recovery;
		});
		const saveFileContent = vi.fn(async (_path: string, content: string) => contentResponse(content, "hash-saved"));
		const current = await mountWorkspace({ saveFileContent });
		await act(async () => {
			current().handleChangeActiveContent("first draft");
		});
		let pending = Promise.resolve();
		await act(async () => {
			pending = current().handleSaveActiveTab();
		});
		expect(flushRecoveryMock).toHaveBeenCalledOnce();
		expect(current().activeTab).toMatchObject({ savedValue: "first draft", isSaving: false, error: null });
		expect(showAppToastMock).not.toHaveBeenCalled();
		await act(async () => {
			current().handleChangeActiveContent("newer draft while storage pending");
		});
		expect(current().isActiveTabDirty).toBe(true);
		await act(async () => {
			await current().handleSaveActiveTab();
		});
		expect(saveFileContent).toHaveBeenCalledOnce();
		await act(async () => {
			acknowledge(true);
			await pending;
		});
		expect(current().activeTab).toMatchObject({
			value: "newer draft while storage pending",
			savedValue: "first draft",
			contentHash: "hash-saved",
			isSaving: false,
		});
		expect(current().isActiveTabDirty).toBe(true);
		expect(showAppToastMock).toHaveBeenCalledExactlyOnceWith({
			intent: "success",
			message: "File saved.",
			timeout: 2500,
		});
		await act(async () => {
			await current().handleSaveActiveTab();
		});
		expect(saveFileContent).toHaveBeenLastCalledWith("src/app.ts", "newer draft while storage pending", "hash-saved");
		expect(current().isActiveTabDirty).toBe(false);
	});

	it.each(["false", "rejected"])(
		"reports source success separately when recovery is %s without rewriting the file",
		async (outcome) => {
			if (outcome === "false") flushRecoveryMock.mockResolvedValue(false);
			else flushRecoveryMock.mockRejectedValue(new Error("storage failed"));
			const saveFileContent = vi.fn(async (_path: string, content: string) =>
				contentResponse(content, "saved-hash"),
			);
			const current = await mountWorkspace({ saveFileContent });
			await act(async () => {
				current().handleChangeActiveContent("source saved");
			});
			await act(async () => {
				await current().handleSaveActiveTab();
			});
			expect(current().activeTab).toMatchObject({
				savedValue: "source saved",
				value: "source saved",
				isSaving: false,
				error: null,
				contentHash: "saved-hash",
			});
			expect(current().isActiveTabDirty).toBe(false);
			expect(showAppToastMock).toHaveBeenCalledExactlyOnceWith({
				intent: "warning",
				message: expect.stringMatching(
					/File saved, but its recovery update.*Choose Retry recovery, or save a copy/,
				),
				timeout: 7000,
			});
			await act(async () => {
				await current().handleSaveActiveTab();
			});
			expect(saveFileContent).toHaveBeenCalledOnce();
			expect(flushRecoveryMock).toHaveBeenCalledOnce();
		},
	);

	it("source failure retains dirty text and skips recovery success acknowledgement", async () => {
		const current = await mountWorkspace({
			saveFileContent: async () => {
				throw new Error("source conflict");
			},
		});
		await act(async () => {
			current().handleChangeActiveContent("dirty source");
		});
		await act(async () => {
			await current().handleSaveActiveTab();
		});
		expect(current().activeTab).toMatchObject({
			value: "dirty source",
			savedValue: "const value = 1;\n",
			error: "source conflict",
			isSaving: false,
		});
		expect(flushRecoveryMock).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledExactlyOnceWith({
			intent: "danger",
			message: "source conflict",
			timeout: 7000,
		});
	});

	it("Save All retains a recovery warning after a later file succeeds and separately counts a source failure", async () => {
		flushRecoveryMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const saveFileContent = vi.fn(async (path: string, content: string) => {
			if (path === "src/failure.ts") throw new Error("source conflict");
			return contentResponse(content, `saved-${path}`);
		});
		const current = await mountWorkspace({ saveFileContent });
		await act(async () => {
			setCachedFileEditorTabs(
				"project-1:task-1",
				["src/app.ts", "src/other.ts", "src/failure.ts"].map((path) => ({
					...createFileEditorTab(path, contentResponse("original", `original-${path}`)),
					value: `draft-${path}`,
				})),
			);
		});
		await act(async () => {
			await current().handleSaveAllTabs();
		});
		expect(saveFileContent).toHaveBeenCalledTimes(3);
		expect(flushRecoveryMock).toHaveBeenCalledTimes(2);
		expect(current().tabs.filter((tab) => tab.error === null && tab.value === tab.savedValue)).toHaveLength(2);
		expect(current().tabs.find((tab) => tab.path === "src/failure.ts")).toMatchObject({
			value: "draft-src/failure.ts",
			savedValue: "original",
			error: "source conflict",
		});
		expect(showAppToastMock).toHaveBeenLastCalledWith({
			intent: "warning",
			message:
				"2 files saved, but recovery updates could not all be confirmed. 1 file could not be saved. Choose Retry recovery, or save a copy of your drafts.",
			timeout: 7000,
		});
		expect(showAppToastMock.mock.calls.some(([toast]) => toast.intent === "success")).toBe(false);
	});

	it("Save All waits for the final recovery ACK before aggregate success", async () => {
		let acknowledge: (ready: boolean) => void = () => {};
		flushRecoveryMock.mockResolvedValueOnce(true).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					acknowledge = resolve;
				}),
		);
		const current = await mountWorkspace();
		await act(async () => {
			setCachedFileEditorTabs(
				"project-1:task-1",
				["src/app.ts", "src/other.ts"].map((path) => ({
					...createFileEditorTab(path, contentResponse("original", "original-hash")),
					value: "draft",
				})),
			);
		});
		let pending = Promise.resolve();
		await act(async () => {
			pending = current().handleSaveAllTabs();
		});
		expect(flushRecoveryMock).toHaveBeenCalledTimes(2);
		expect(current().hasDirtyTabs).toBe(false);
		expect(current().tabs.every((tab) => !tab.isSaving)).toBe(true);
		expect(showAppToastMock).not.toHaveBeenCalled();
		await act(async () => {
			acknowledge(true);
			await pending;
		});
		expect(showAppToastMock).toHaveBeenCalledExactlyOnceWith({
			intent: "success",
			message: "2 files saved.",
			timeout: 2500,
		});
	});

	it("autosave recovery failures do not create repeated toast or source retry loops", async () => {
		flushRecoveryMock.mockResolvedValue(false);
		const saveFileContent = vi.fn(async (_path: string, content: string) => contentResponse(content, "saved-hash"));
		const current = await mountWorkspace({ autosaveMode: "focus", saveFileContent });
		for (const value of ["first", "second"]) {
			await act(async () => {
				current().handleChangeActiveContent(value);
			});
			await act(async () => {
				current().handleAutosaveFocusChange();
			});
			await act(async () => {
				current().handleAutosaveFocusChange();
			});
		}
		expect(saveFileContent).toHaveBeenCalledTimes(2);
		expect(flushRecoveryMock).toHaveBeenCalledTimes(2);
		expect(current().isActiveTabDirty).toBe(false);
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("keeps newer edits when saving across scope switches and fences retired scope completions", async () => {
		let finishSave: (content: RuntimeFileContentResponse) => void = () => {};
		const saving = new Promise<RuntimeFileContentResponse>((resolve) => {
			finishSave = resolve;
		});
		let latest: UseFileEditorWorkspaceResult | null = null;
		const current = () => {
			if (!latest) throw new Error("No workspace");
			return latest;
		};
		const scope = { projectId: "p1", taskId: "t1", taskCreatedAt: 1 };
		await act(async () => {
			root.render(
				<HookHarness
					input={createInput({ scope, saveFileContent: async () => saving })}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
		});
		await act(async () => {
			current().handleChangeActiveContent("original draft");
		});
		let pending: Promise<void> = Promise.resolve();
		await act(async () => {
			pending = current().handleSaveActiveTab();
		});
		await act(async () => {
			retireFileEditorScopes({ projectId: "p1" });
		});
		expect(current().tabs).toEqual([]);
		await act(async () => {
			registerFileEditorScope("project-1:task-1", scope);
			setCachedFileEditorTabs("project-1:task-1", [
				{
					...createFileEditorTab("src/app.ts", contentResponse("restored disk", "new-hash")),
					value: "original draft",
				},
			]);
		});
		await act(async () => {
			finishSave(contentResponse("original draft", "old-save-hash"));
			await pending;
		});
		expect(getCachedFileEditorTabs("project-1:task-1")[0]).toMatchObject({
			value: "original draft",
			savedValue: "restored disk",
			contentHash: "new-hash",
		});
		expect(getFileEditorDrafts("detached")[0]?.tab.value).toBe("original draft");
	});

	it("suppresses focus autosave while a discard prompt is active", async () => {
		const saveFileContent = vi.fn(async (_path: string, content: string) => contentResponse(content, "hash-saved"));
		let latest: UseFileEditorWorkspaceResult | null = null;
		const getLatest = (): UseFileEditorWorkspaceResult => {
			if (!latest) {
				throw new Error("Expected file editor workspace result.");
			}
			return latest;
		};

		await act(async () => {
			root.render(
				<HookHarness
					input={createInput({ autosaveMode: "focus", saveFileContent })}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
		});

		await act(async () => {
			getLatest().handleChangeActiveContent("const value = 3;\n");
		});
		await act(async () => {
			getLatest().handleCloseTab("src/app.ts");
		});

		expect(getLatest().discardPrompt).toEqual({ action: "close", path: "src/app.ts" });

		await act(async () => {
			getLatest().handleAutosaveFocusChange();
			await Promise.resolve();
		});

		expect(saveFileContent).not.toHaveBeenCalled();
	});

	it.each(["delay", "focus"] as const)(
		"requires explicit Save for recovered text when autosave is %s",
		async (autosaveMode) => {
			vi.useFakeTimers();
			try {
				const saveFileContent = vi.fn(async (_path: string, content: string) =>
					contentResponse(content, "saved-hash"),
				);
				let latest: UseFileEditorWorkspaceResult | null = null;
				const current = (): UseFileEditorWorkspaceResult => {
					if (!latest) throw new Error("No workspace");
					return latest;
				};
				await act(async () => {
					root.render(
						<HookHarness
							input={createInput({ autosaveMode, saveFileContent })}
							onResult={(result) => {
								latest = result;
							}}
						/>,
					);
				});
				await act(async () => {
					setCachedFileEditorTabs("project-1:task-1", [
						{
							...createFileEditorTab("src/app.ts", contentResponse("original", "original-hash")),
							value: "recovered draft",
							recoveryRequiresSave: true,
						},
					]);
				});
				await act(async () => {
					current().handleAutosaveFocusChange();
					vi.advanceTimersByTime(FILE_EDITOR_AUTOSAVE_DELAY_MS * 2);
					await Promise.resolve();
				});
				expect(saveFileContent).not.toHaveBeenCalled();
				await act(async () => {
					await current().handleSaveActiveTab();
				});
				expect(saveFileContent).toHaveBeenCalledExactlyOnceWith("src/app.ts", "recovered draft", "original-hash");
				expect(getCachedFileEditorTabs("project-1:task-1")[0]).toMatchObject({
					savedValue: "recovered draft",
					recoveryRequiresSave: false,
				});
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("delay-autosaves a dirty tab after switching to another clean tab", async () => {
		vi.useFakeTimers();
		try {
			const saveFileContent = vi.fn(async (path: string, content: string) =>
				contentResponse(content, `hash-saved-${path}`),
			);
			let latest: UseFileEditorWorkspaceResult | null = null;
			const captureResult = (result: UseFileEditorWorkspaceResult) => {
				latest = result;
			};
			const getLatest = (): UseFileEditorWorkspaceResult => {
				if (!latest) {
					throw new Error("Expected file editor workspace result.");
				}
				return latest;
			};

			await act(async () => {
				root.render(
					<HookHarness input={createInput({ autosaveMode: "delay", saveFileContent })} onResult={captureResult} />,
				);
			});

			await act(async () => {
				getLatest().handleChangeActiveContent("const value = 3;\n");
			});

			await act(async () => {
				root.render(
					<HookHarness
						input={createInput({
							selectedPath: "src/other.ts",
							fileContent: contentResponse("const other = 1;\n", "hash-other"),
							autosaveMode: "delay",
							saveFileContent,
						})}
						onResult={captureResult}
					/>,
				);
			});

			expect(saveFileContent).not.toHaveBeenCalled();

			await act(async () => {
				vi.advanceTimersByTime(FILE_EDITOR_AUTOSAVE_DELAY_MS);
				await Promise.resolve();
			});

			expect(saveFileContent).toHaveBeenCalledWith("src/app.ts", "const value = 3;\n", "hash-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("blocks close and reload actions while a tab save is in flight", async () => {
		const reloadFileContent = vi.fn(async () => contentResponse("const value = 2;\n", "hash-2"));
		const onCloseFile = vi.fn();
		const savingTab = {
			...createFileEditorTab("src/app.ts", contentResponse("const value = 1;\n", "hash-1")),
			value: "const value = 3;\n",
			isSaving: true,
		};
		setCachedFileEditorTabs("project-1:task-1", [savingTab]);
		let latest: UseFileEditorWorkspaceResult | null = null;
		const getLatest = (): UseFileEditorWorkspaceResult => {
			if (!latest) {
				throw new Error("Expected file editor workspace result.");
			}
			return latest;
		};

		await act(async () => {
			root.render(
				<HookHarness
					input={createInput({ reloadFileContent, onCloseFile })}
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
		});

		await act(async () => {
			getLatest().handleCloseTab("src/app.ts");
		});
		await act(async () => {
			await getLatest().handleReloadActiveTab();
		});

		expect(getLatest().discardPrompt).toBeNull();
		expect(onCloseFile).not.toHaveBeenCalled();
		expect(reloadFileContent).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "warning",
			message: "Wait for the file save to finish before closing it.",
			timeout: 4000,
		});
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "warning",
			message: "Wait for the file save to finish before reloading it.",
			timeout: 4000,
		});
	});

	it("prevents page unload when dirty tabs remain in the editor cache", async () => {
		const dirtyTab = updateFileEditorTabValue(
			[createFileEditorTab("src/app.ts", contentResponse("old", "hash-1"))],
			"src/app.ts",
			"local edit",
		)[0]!;
		setCachedFileEditorTabs("project-1:task-1", [dirtyTab]);

		await act(async () => {
			root.render(<UnloadGuardHarness />);
		});

		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
	});

	it("allows page unload when cached editor tabs are clean", async () => {
		setCachedFileEditorTabs("project-1:task-1", [
			createFileEditorTab("src/app.ts", contentResponse("clean", "hash-1")),
		]);

		await act(async () => {
			root.render(<UnloadGuardHarness />);
		});

		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
	});
});
