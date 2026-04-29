import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileContentViewer } from "@/components/git/panels/file-content-viewer";
import { TooltipProvider } from "@/components/ui/tooltip";

const showAppToastMock = vi.hoisted(() => vi.fn());
const virtualizerMeasureMock = vi.hoisted(() => vi.fn());
const virtualizerScrollToIndexMock = vi.hoisted(() => vi.fn());
const virtualizerMeasureElementMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: (options: { count: number; estimateSize: () => number }) => ({
		getTotalSize: () => options.count * options.estimateSize(),
		getVirtualItems: () =>
			Array.from({ length: options.count }, (_, index) => ({
				index,
				key: index,
				start: index * options.estimateSize(),
			})),
		measure: virtualizerMeasureMock,
		measureElement: virtualizerMeasureElementMock,
		scrollToIndex: virtualizerScrollToIndexMock,
	}),
}));

describe("FileContentViewer", () => {
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
		showAppToastMock.mockReset();
		virtualizerMeasureMock.mockReset();
		virtualizerScrollToIndexMock.mockReset();
		virtualizerMeasureElementMock.mockReset();
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

	async function renderViewer(content: string): Promise<void> {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<FileContentViewer
						content={content}
						binary={false}
						truncated={false}
						isLoading={false}
						isError={false}
						filePath="src/example.ts"
					/>
				</TooltipProvider>,
			);
		});
	}

	function getSourceTextarea(): HTMLTextAreaElement {
		const textarea = container.querySelector('textarea[aria-label="src/example.ts content"]');
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
		return textarea as HTMLTextAreaElement;
	}

	it("keeps the full source text in a selectable file-scoped text layer", async () => {
		const content = "const one = 1;\nconst two = 2;\n";

		await renderViewer(content);

		const textarea = getSourceTextarea();
		expect(textarea.value).toBe(content);
		expect(textarea.readOnly).toBe(true);
		expect(textarea.dataset.wordWrap).toBe("true");
	});

	it("selects the current file content for Cmd+A inside the source pane", async () => {
		const content = "const one = 1;\nconst two = 2;\n";

		await renderViewer(content);

		const textarea = getSourceTextarea();
		textarea.focus();
		textarea.setSelectionRange(6, 9);

		const event = new KeyboardEvent("keydown", {
			key: "a",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			textarea.dispatchEvent(event);
		});

		expect(event.defaultPrevented).toBe(true);
		expect(textarea.selectionStart).toBe(0);
		expect(textarea.selectionEnd).toBe(content.length);
	});

	it("copies the loaded file content from the toolbar", async () => {
		const content = "const one = 1;\n";

		await renderViewer(content);

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

	it("remeasures virtual rows when word wrap is disabled", async () => {
		const content = "const longLine = 'this is a long line that wraps in source mode';\n";

		await renderViewer(content);
		virtualizerMeasureMock.mockClear();

		const wrapButton = container.querySelector('button[aria-label="Disable word wrap"]');
		expect(wrapButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			(wrapButton as HTMLButtonElement).click();
		});

		expect(getSourceTextarea().dataset.wordWrap).toBe("false");
		expect(virtualizerMeasureMock).toHaveBeenCalled();
	});
});
