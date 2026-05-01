import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileEditorPanel } from "@/components/git/panels/file-editor-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileEditorDiscardPrompt } from "@/hooks/git";
import type { FileEditorAutosaveMode, FileEditorTab } from "@/hooks/git/file-editor-workspace";

const sourceEditorRenderMock = vi.hoisted(() => vi.fn());
const sourceEditorOpenSearchPanelMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

vi.mock("@/components/editor/source-editor", () => ({
	SourceEditor: forwardRef<
		{ openSearchPanel: () => void; focus: () => void },
		{
			path: string;
			value: string;
			readOnly: boolean;
			onChange: (value: string) => void;
			onSave?: () => void;
		}
	>(function SourceEditorMock(props, ref) {
		useImperativeHandle(ref, () => ({
			openSearchPanel: sourceEditorOpenSearchPanelMock,
			focus: vi.fn(),
		}));
		sourceEditorRenderMock(props);
		return (
			<textarea
				aria-label={`${props.path} source editor`}
				data-testid="source-editor"
				readOnly={props.readOnly}
				value={props.value}
				onChange={(event) => props.onChange(event.currentTarget.value)}
				onKeyDown={(event) => {
					if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
						event.preventDefault();
						props.onSave?.();
					}
				}}
			/>
		);
	}),
}));

function createTab(path: string, value: string): FileEditorTab {
	return {
		path,
		value,
		savedValue: value,
		contentHash: `hash-${path}`,
		language: "typescript",
		binary: false,
		truncated: false,
		editable: true,
		editBlockedReason: null,
		size: value.length,
		isSaving: false,
		error: null,
	};
}

describe("FileEditorPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let originalClipboard: Clipboard | undefined;
	let clipboardWriteText: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		localStorage.clear();
		sourceEditorRenderMock.mockReset();
		sourceEditorOpenSearchPanelMock.mockReset();
		showAppToastMock.mockReset();
		clipboardWriteText = vi.fn().mockResolvedValue(undefined);
		originalClipboard = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: clipboardWriteText },
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		localStorage.clear();
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: originalClipboard,
		});
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderPanel(input: {
		tabs?: readonly FileEditorTab[];
		activeTab?: FileEditorTab | null;
		activePath?: string | null;
		onCloseTab?: (path: string) => void;
		onCloseAllTabs?: () => void;
		onSaveAllTabs?: () => Promise<void>;
		hasDirtyTabs?: boolean;
		discardPrompt?: FileEditorDiscardPrompt | null;
		autosaveMode?: FileEditorAutosaveMode;
		onAutosaveFocusChange?: () => void;
	}): Promise<void> {
		const activeTab = input.activeTab ?? createTab("src/example.ts", "const one = 1;\n");
		const tabs = input.tabs ?? [activeTab];
		await act(async () => {
			root.render(
				<TooltipProvider>
					<FileEditorPanel
						tabs={tabs}
						activeTab={activeTab}
						activePath={input.activePath ?? activeTab?.path ?? null}
						isLoading={false}
						isError={false}
						isReadOnly={false}
						canEditActiveTab={activeTab?.editable ?? false}
						isActiveTabDirty={false}
						hasDirtyTabs={input.hasDirtyTabs ?? false}
						discardPrompt={input.discardPrompt ?? null}
						autosaveMode={input.autosaveMode ?? "off"}
						onSelectTab={() => {}}
						onCloseTab={input.onCloseTab ?? (() => {})}
						onChangeActiveContent={() => {}}
						onSaveActiveTab={async () => {}}
						onSaveAllTabs={input.onSaveAllTabs ?? (async () => {})}
						onCloseAllTabs={input.onCloseAllTabs ?? (() => {})}
						onAutosaveFocusChange={input.onAutosaveFocusChange ?? (() => {})}
						onReloadActiveTab={async () => {}}
						onCancelDiscardPrompt={() => {}}
						onConfirmDiscardPrompt={async () => {}}
					/>
				</TooltipProvider>,
			);
		});
	}

	it("copies the active tab content from the toolbar", async () => {
		const content = "const one = 1;\n";

		await renderPanel({ activeTab: createTab("src/example.ts", content) });

		const copyButton = container.querySelector('button[aria-label="Copy file contents"]');
		expect(copyButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			(copyButton as HTMLButtonElement).click();
			await Promise.resolve();
		});

		expect(clipboardWriteText).toHaveBeenCalledWith(content);
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "success",
			message: "File contents copied to clipboard",
		});
	});

	it("closes file tabs on middle mouse click", async () => {
		const onCloseTab = vi.fn();
		const first = createTab("src/first.ts", "const first = 1;\n");
		const second = createTab("src/second.ts", "const second = 2;\n");

		await renderPanel({
			tabs: [first, second],
			activeTab: first,
			activePath: first.path,
			onCloseTab,
		});

		const secondTabButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("second.ts"),
		);
		expect(secondTabButton).toBeInstanceOf(HTMLButtonElement);
		const tabRoot = secondTabButton?.parentElement;
		expect(tabRoot).toBeInstanceOf(HTMLDivElement);

		await act(async () => {
			tabRoot?.dispatchEvent(new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true }));
			tabRoot?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
		});

		expect(onCloseTab).toHaveBeenCalledWith("src/second.ts");
	});

	it("opens active file find and replace from the toolbar", async () => {
		await renderPanel({});

		const findButton = container.querySelector('button[aria-label="Find and replace in file"]');
		expect(findButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			(findButton as HTMLButtonElement).click();
		});

		expect(sourceEditorOpenSearchPanelMock).toHaveBeenCalledTimes(1);
	});

	it("runs save all and close all toolbar actions", async () => {
		const onSaveAllTabs = vi.fn().mockResolvedValue(undefined);
		const onCloseAllTabs = vi.fn();

		await renderPanel({ hasDirtyTabs: true, onSaveAllTabs, onCloseAllTabs });

		const saveAllButton = container.querySelector('button[aria-label="Save all files"]');
		const closeAllButton = container.querySelector('button[aria-label="Close all files"]');
		expect(saveAllButton).toBeInstanceOf(HTMLButtonElement);
		expect(closeAllButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			(saveAllButton as HTMLButtonElement).click();
			await Promise.resolve();
			(closeAllButton as HTMLButtonElement).click();
		});

		expect(onSaveAllTabs).toHaveBeenCalledTimes(1);
		expect(onCloseAllTabs).toHaveBeenCalledTimes(1);
	});

	it("disables close and reload controls while saves are in flight", async () => {
		const savingTab = {
			...createTab("src/saving.ts", "const one = 1;\n"),
			value: "const one = 2;\n",
			isSaving: true,
		};

		await renderPanel({
			tabs: [savingTab],
			activeTab: savingTab,
			activePath: savingTab.path,
			hasDirtyTabs: true,
		});

		const closeButton = container.querySelector('button[aria-label="Close src/saving.ts"]');
		const closeAllButton = container.querySelector('button[aria-label="Close all files"]');
		const reloadButton = container.querySelector('button[aria-label="Reload file"]');

		expect(closeButton).toBeInstanceOf(HTMLButtonElement);
		expect(closeAllButton).toBeInstanceOf(HTMLButtonElement);
		expect(reloadButton).toBeInstanceOf(HTMLButtonElement);
		expect((closeButton as HTMLButtonElement).disabled).toBe(true);
		expect((closeAllButton as HTMLButtonElement).disabled).toBe(true);
		expect((reloadButton as HTMLButtonElement).disabled).toBe(true);
	});

	it("requests autosave when focus leaves the editor panel in focus mode", async () => {
		const onAutosaveFocusChange = vi.fn();
		const outsideButton = document.createElement("button");
		document.body.appendChild(outsideButton);

		await renderPanel({ autosaveMode: "focus", onAutosaveFocusChange });

		const editor = container.querySelector('[data-testid="source-editor"]');
		expect(editor).toBeInstanceOf(HTMLTextAreaElement);

		await act(async () => {
			editor?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outsideButton }));
		});

		expect(onAutosaveFocusChange).toHaveBeenCalledTimes(1);
		outsideButton.remove();
	});

	it("does not request focus autosave while a discard prompt is open", async () => {
		const onAutosaveFocusChange = vi.fn();
		const outsideButton = document.createElement("button");
		document.body.appendChild(outsideButton);

		await renderPanel({
			autosaveMode: "focus",
			discardPrompt: { action: "close", path: "src/example.ts" },
			onAutosaveFocusChange,
		});

		const editor = container.querySelector('[data-testid="source-editor"]');
		expect(editor).toBeInstanceOf(HTMLTextAreaElement);

		await act(async () => {
			editor?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outsideButton }));
		});

		expect(onAutosaveFocusChange).not.toHaveBeenCalled();
		outsideButton.remove();
	});

	it("shows large editable files as read-only with the provided reason", async () => {
		const blockedReason = "File is larger than the 5 MB edit limit and is opened read-only.";
		const tab = {
			...createTab("src/large.ts", "const value = 1;\n"),
			editable: false,
			editBlockedReason: blockedReason,
		};

		await renderPanel({ activeTab: tab });

		expect(container.textContent).toContain("Read-only");
		expect(container.textContent).toContain(blockedReason);
		const editor = container.querySelector('textarea[aria-label="src/large.ts source editor"]');
		expect(editor).toBeInstanceOf(HTMLTextAreaElement);
		expect((editor as HTMLTextAreaElement).readOnly).toBe(true);
	});
});
