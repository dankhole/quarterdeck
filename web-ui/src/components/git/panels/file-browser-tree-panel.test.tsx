import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileTreeDirectoryPages } from "@/hooks/git/file-tree-pages";
import { useFileBrowserData } from "@/hooks/git/use-file-browser-data";
import type { RuntimeListFilesRequest } from "@/runtime/types";
import { fileTreePage } from "@/test-utils/file-tree";
import { FileBrowserTreePanel } from "./file-browser-tree-panel";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: () => ({ project: { listFiles: { query } } }) }));
// jsdom has no scroll geometry. Keep the real panel, rendering its complete virtual projection.
vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getTotalSize: () => count * 28,
		getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 28 })),
	}),
}));

function Harness() {
	const data = useFileBrowserData({ projectId: "panel-project", taskId: null });
	const [expanded, setExpanded] = useState(new Set<string>());
	useEffect(() => data.setExpandedDirectories(expanded), [expanded, data.setExpandedDirectories]);
	return (
		<FileBrowserTreePanel
			files={data.files}
			directories={data.directories}
			selectedPath={null}
			onSelectPath={() => {}}
			expandedDirs={expanded}
			onExpandedDirsChange={setExpanded}
			directoryPages={data.directoryPages}
			showExcluded={data.showExcluded}
			onShowExcludedChange={data.setShowExcluded}
			onLoadDirectory={data.loadDirectory}
		/>
	);
}

describe("FileBrowserTreePanel", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		query.mockReset();
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	const button = (label: string) => {
		const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
		if (!found) throw new Error(`Missing ${label}`);
		return found;
	};
	it("renders root continuation, retained retry error, and reveal toggle even for empty pages", async () => {
		const load = vi.fn();
		const show = vi.fn();
		const render = async (pages: FileTreeDirectoryPages) =>
			act(async () =>
				root.render(
					<TooltipProvider>
						<FileBrowserTreePanel
							files={[]}
							selectedPath={null}
							onSelectPath={() => {}}
							expandedDirs={new Set()}
							onExpandedDirsChange={() => {}}
							directoryPages={pages}
							showExcluded={false}
							onShowExcludedChange={show}
							onLoadDirectory={load}
						/>
					</TooltipProvider>,
				),
			);
		await render({ "": { data: fileTreePage({ nextCursor: "more" }), loading: false, error: null } });
		expect(container.textContent).not.toContain("No files");
		await act(async () => button("Load more root").click());
		expect(load).toHaveBeenCalledWith("", true);
		await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
		expect(show).toHaveBeenCalledWith(true);
		await render({ "": { data: null, loading: true, error: new Error("offline") } });
		expect(container.textContent).toContain("offline");
		expect(button("Retry root").disabled).toBe(true);
		await render({ "": { data: null, loading: false, error: new Error("offline") } });
		await act(async () => button("Retry root").click());
		expect(load).toHaveBeenLastCalledWith("", false);
	});
	it("filters loaded paths without fetching and expand-loaded never recursively floods new directories", async () => {
		vi.useFakeTimers();
		query.mockImplementation(async ({ directory = "" }: RuntimeListFilesRequest) =>
			fileTreePage({
				directory,
				snapshotId: directory || "root",
				directories: [directory ? `${directory}/nested` : "src"],
				files: directory ? [`${directory}/needle.ts`] : [],
			}),
		);
		await act(async () =>
			root.render(
				<TooltipProvider>
					<Harness />
				</TooltipProvider>,
			),
		);
		await act(async () => button("Expand loaded folders").click());
		expect(query.mock.calls.map(([request]) => request.directory)).toEqual(["", "src"]);
		const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter loaded files"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "nested");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			await vi.advanceTimersByTimeAsync(200);
		});
		expect(query).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("nested");
		await act(async () => button("Expand loaded folders").click());
		expect(query.mock.calls.map(([request]) => request.directory)).toEqual(["", "src", "src/nested"]);
		expect(query).not.toHaveBeenCalledWith(expect.objectContaining({ directory: "src/nested/nested" }));
	});
	it("does not add or replace directory status rows during background refresh", async () => {
		const render = async (loading: boolean, nextCursor: string | null = null) =>
			act(async () =>
				root.render(
					<TooltipProvider>
						<FileBrowserTreePanel
							files={["src/file"]}
							directories={["src"]}
							selectedPath={null}
							onSelectPath={() => {}}
							expandedDirs={new Set(["src"])}
							onExpandedDirsChange={() => {}}
							directoryPages={{
								"": { data: fileTreePage({ directories: ["src"] }), loading, error: null },
								src: {
									data: fileTreePage({ directory: "src", files: ["src/file"], nextCursor }),
									loading,
									error: null,
								},
							}}
							showExcluded={false}
							onShowExcludedChange={() => {}}
							onLoadDirectory={async () => null}
						/>
					</TooltipProvider>,
				),
			);
		await render(false);
		const height = container.querySelector(".relative.w-full")?.getAttribute("style");
		await render(true);
		expect(container.querySelector(".relative.w-full")?.getAttribute("style")).toBe(height);
		expect(container.textContent).not.toContain("Loading");
		await render(false, "more");
		const continuationHeight = container.querySelector(".relative.w-full")?.getAttribute("style");
		await render(true, "more");
		expect(container.querySelector(".relative.w-full")?.getAttribute("style")).toBe(continuationHeight);
		expect(button("Load more src")).toBeDefined();
		expect(container.textContent).not.toContain("Loading");
	});
});
