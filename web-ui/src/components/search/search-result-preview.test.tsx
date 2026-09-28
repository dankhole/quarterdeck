import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceEditorProps } from "@/components/editor/source-editor";
import type { RuntimeFileContentResponse } from "@/runtime/types";
import { FileFinderOverlay } from "./file-finder-overlay";
import { SearchResultPreview } from "./search-result-preview";
import { TextSearchOverlay } from "./text-search-overlay";

const { getContent, searchFiles, searchText, editor } = vi.hoisted(() => ({
	getContent: vi.fn(),
	searchFiles: vi.fn(),
	searchText: vi.fn(),
	editor: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			getFileContent: { query: getContent },
			searchFiles: { query: searchFiles },
			searchText: { query: searchText },
		},
	}),
}));
vi.mock("@/components/editor/source-editor", () => ({
	SourceEditor: (props: SourceEditorProps) => {
		editor(props);
		return <pre data-testid="preview-source">{props.value}</pre>;
	},
}));
const scope = { taskId: null };
function content(text: string): RuntimeFileContentResponse {
	return { content: text, binary: false, language: "typescript", size: text.length, truncated: false };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
describe("search preview", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		vi.clearAllMocks();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		getContent.mockResolvedValue(content("preview"));
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), configurable: true });
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	it("fences stale responses and aborts when path or scope changes", async () => {
		const old = deferred<RuntimeFileContentResponse>();
		getContent.mockReturnValueOnce(old.promise);
		await act(async () => root.render(<SearchResultPreview projectId="p" searchScope={scope} path="old.ts" />));
		const signal = getContent.mock.calls[0]?.[1].signal as AbortSignal;
		await act(async () =>
			root.render(
				<SearchResultPreview
					projectId="p"
					searchScope={{ taskId: "task", baseRef: "main", ref: "feature" }}
					path="new.ts"
					line={42}
				/>,
			),
		);
		expect(signal.aborted).toBe(true);
		expect(getContent).toHaveBeenLastCalledWith(
			{ taskId: "task", baseRef: "main", ref: "feature", path: "new.ts" },
			expect.anything(),
		);
		await act(async () => old.resolve(content("stale")));
		expect(container.textContent).not.toContain("stale");
		expect(editor).toHaveBeenLastCalledWith(
			expect.objectContaining({ path: "new.ts", scrollToLine: 42, readOnly: true }),
		);
	});
	it("shows bounded, binary, and failed preview states", async () => {
		getContent.mockResolvedValueOnce({ ...content("partial"), truncated: true });
		await act(async () => root.render(<SearchResultPreview projectId="p" searchScope={scope} path="big.ts" />));
		expect(container.textContent).toContain("Preview truncated");
		getContent.mockResolvedValueOnce({ ...content(""), binary: true });
		await act(async () => root.render(<SearchResultPreview projectId="p" searchScope={scope} path="image.png" />));
		expect(container.textContent).toContain("Binary file");
		getContent.mockRejectedValueOnce(new Error("missing"));
		await act(async () => root.render(<SearchResultPreview projectId="p" searchScope={scope} path="missing.ts" />));
		expect(container.textContent).toContain("Unable to load preview");
	});
	async function type(input: HTMLInputElement, value: string) {
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	async function key(input: HTMLInputElement, value: string) {
		await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
	}
	it("previews file keyboard and hover highlights without navigating or stealing focus", async () => {
		vi.useFakeTimers();
		searchFiles.mockResolvedValue({
			files: [
				{ name: "a.ts", path: "a.ts" },
				{ name: "b.ts", path: "b.ts" },
			],
		});
		const onSelect = vi.fn();
		await act(async () =>
			root.render(<FileFinderOverlay projectId="p" searchScope={scope} onSelect={onSelect} onDismiss={() => {}} />),
		);
		const input = container.querySelector("input")!;
		await type(input, "ts");
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({ path: "a.ts" }));
		await key(input, "ArrowDown");
		expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({ path: "b.ts" }));
		expect(document.activeElement).toBe(input);
		expect(onSelect).not.toHaveBeenCalled();
		const first = [...container.querySelectorAll("span")].find((node) => node.textContent === "a.ts")!;
		await act(async () => first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({ path: "a.ts" }));
		await key(input, "Enter");
		expect(onSelect).toHaveBeenCalledWith("a.ts");
		await act(async () =>
			root.render(
				<FileFinderOverlay projectId="other" searchScope={scope} onSelect={onSelect} onDismiss={() => {}} />,
			),
		);
		expect(container.querySelector("input")?.value).toBe("");
		expect(container.querySelector('[data-testid="preview-source"]')).toBeNull();
	});
	it("discards an old file search during the next query's debounce", async () => {
		vi.useFakeTimers();
		const old = deferred<{ files: { name: string; path: string }[] }>();
		searchFiles.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ files: [] });
		await act(async () =>
			root.render(<FileFinderOverlay projectId="p" searchScope={scope} onSelect={() => {}} onDismiss={() => {}} />),
		);
		const input = container.querySelector("input")!;
		await type(input, "old");
		await act(async () => vi.advanceTimersByTimeAsync(150));
		await type(input, "new");
		await act(async () => old.resolve({ files: [{ path: "old.ts", name: "old.ts" }] }));
		expect(container.textContent).not.toContain("old.ts");
		expect(getContent).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(150));
	});

	it("centers text matches and only navigates on confirmation", async () => {
		searchText.mockResolvedValue({
			files: [
				{
					path: "a.ts",
					matches: [
						{ line: 12, content: "needle" },
						{ line: 30, content: "needle" },
					],
				},
			],
			totalMatches: 2,
			truncated: false,
		});
		const onSelect = vi.fn();
		await act(async () =>
			root.render(<TextSearchOverlay projectId="p" searchScope={scope} onSelect={onSelect} onDismiss={() => {}} />),
		);
		const input = container.querySelector("input")!;
		await type(input, "needle");
		await key(input, "Enter");
		await key(input, "ArrowDown");
		expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({ scrollToLine: 12, readOnly: true }));
		await key(input, "ArrowDown");
		expect(editor).toHaveBeenLastCalledWith(expect.objectContaining({ scrollToLine: 30 }));
		expect(getContent).toHaveBeenCalledTimes(1);
		expect(onSelect).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(input);
		await key(input, "Enter");
		expect(onSelect).toHaveBeenCalledWith("a.ts", 30);
	});
});
