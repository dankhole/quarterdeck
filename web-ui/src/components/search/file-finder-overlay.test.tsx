import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileFinderOverlay } from "./file-finder-overlay";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ project: { searchFiles: { query: search } } }),
}));
vi.mock("./search-result-preview", () => ({ SearchResultPreview: () => null }));

describe("FileFinderOverlay", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.useFakeTimers();
		search.mockReset();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it("discloses incomplete empty scans instead of claiming no files exist", async () => {
		search.mockResolvedValue({ query: "needle", files: [], truncated: true });
		await act(async () =>
			root.render(
				<FileFinderOverlay
					projectId="project"
					searchScope={{ taskId: null }}
					onSelect={() => {}}
					onDismiss={() => {}}
				/>,
			),
		);
		const input = container.querySelector("input")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "needle");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => vi.advanceTimersByTimeAsync(200));
		expect(search).toHaveBeenCalledWith({ taskId: null, query: "needle", limit: 50 });
		expect(container.textContent).toContain("Partial results");
		expect(container.textContent).toContain("No matches in the scanned files");
		expect(container.textContent).not.toContain("No files found");
	});
});
