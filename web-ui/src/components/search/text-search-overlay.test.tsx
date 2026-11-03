import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSearchOverlay } from "./text-search-overlay";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ project: { searchText: { query: search } } }),
}));
vi.mock("./search-result-preview", () => ({ SearchResultPreview: () => null }));

describe("TextSearchOverlay", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		search.mockReset();
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	async function render() {
		await act(async () =>
			root.render(
				<TextSearchOverlay projectId="p" searchScope={{ taskId: null }} onSelect={vi.fn()} onDismiss={vi.fn()} />,
			),
		);
	}
	async function startSearch() {
		const input = container.querySelector("input")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "needle");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
	}
	it("offers an optional local toggle and reruns an empty search without moving focus or closing", async () => {
		search.mockResolvedValue({ files: [], totalMatches: 0, truncated: false, ignoreComments: true });
		await render();
		const toggle = container.querySelector<HTMLButtonElement>("[aria-pressed]")!;
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		expect(toggle.title).toContain("recognized comment syntax");
		expect(toggle.title).toContain("Unknown languages are retained");
		await startSearch();
		expect(container.textContent).toContain("No results found");
		toggle.focus();
		await act(async () => toggle.click());
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(document.activeElement).toBe(toggle);
		expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: "needle", ignoreComments: true }));
	});
	it("highlights only surviving UTF-16 ranges on a mixed code/comment line", async () => {
		const content = 'const label = "🦆"; needle(); // needle';
		const start = content.indexOf("needle");
		search.mockResolvedValue({
			files: [
				{ path: "mixed.ts", matches: [{ line: 1, content, ranges: [{ start, end: start + "needle".length }] }] },
			],
			totalMatches: 1,
			truncated: false,
			ignoreComments: true,
		});
		await render();
		await act(async () => container.querySelector<HTMLButtonElement>("[aria-pressed]")!.click());
		await startSearch();
		const highlights = container.querySelectorAll(".text-amber-200");
		expect(Array.from(highlights, (span) => span.textContent)).toEqual(["needle"]);
		expect(container.textContent).toContain(content);
		expect(highlights[0]!.nextSibling?.textContent).toBe("(); // needle");
	});
	it("keeps legacy highlighting for rows without server ranges", async () => {
		search.mockResolvedValue({
			files: [{ path: "mixed.ts", matches: [{ line: 1, content: "needle(); // needle" }] }],
			totalMatches: 1,
			truncated: false,
		});
		await render();
		await startSearch();
		expect(container.querySelectorAll(".text-amber-200")).toHaveLength(2);
	});

	it("explains an old runtime rather than showing an unfiltered response or claiming no matches", async () => {
		search.mockResolvedValue({ files: [], totalMatches: 0, truncated: false });
		await render();
		await act(async () => container.querySelector<HTMLButtonElement>("[aria-pressed]")!.click());
		await startSearch();
		expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Upgrade.*runtime/);
		expect(container.textContent).not.toContain("No results found");
	});
});
