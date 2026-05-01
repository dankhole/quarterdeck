import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

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
