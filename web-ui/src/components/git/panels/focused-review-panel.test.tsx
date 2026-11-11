import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeWorkdirFileChange } from "@/runtime/types";
import { DiffViewerPanel, type DiffViewerPanelProps } from "./diff-viewer-panel";

const modified = (
	path: string,
	oldText = "old\nkeep\nlast",
	newText = "new\nkeep\nfinal",
): RuntimeWorkdirFileChange => ({ path, status: "modified", oldText, newText, additions: 2, deletions: 2 });
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const scope = {
	repository: { projectId: "test", taskId: null },
	revisions: { kind: "compare" as const, base: "a", head: "b" },
};

describe("focused review presentation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousAct: boolean | undefined;
	let props: DiffViewerPanelProps;
	beforeEach(() => {
		previousAct = actGlobal.IS_REACT_ACT_ENVIRONMENT;
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		props = {
			presentation: "focused",
			reviewScope: scope,
			projectFiles: [modified("a.ts"), modified("b.ts")],
			selectedPath: "a.ts",
			onSelectedPathChange: vi.fn(),
			comments: new Map(),
			onCommentsChange: vi.fn(),
		};
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		actGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
	});
	const render = async (overrides: Partial<DiffViewerPanelProps> = {}) => {
		props = { ...props, ...overrides };
		await act(async () => root.render(<DiffViewerPanel {...props} />));
	};
	const button = (label: string) => {
		const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
		if (!element) throw new Error(`Missing ${label}`);
		return element;
	};
	const click = async (label: string) => act(async () => button(label).click());
	const setLayout = async (layout: "unified" | "split" | "resulting") => {
		const select = container.querySelector<HTMLSelectElement>('select[aria-label="Diff layout"]')!;
		await act(async () => {
			select.value = layout;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
	};

	it("renders one file, bounds navigation and owns layout selection", async () => {
		const visible = vi.fn();
		function Controlled() {
			const [selectedPath, onSelectedPathChange] = useState("a.ts");
			return (
				<DiffViewerPanel
					{...props}
					selectedPath={selectedPath}
					onSelectedPathChange={onSelectedPathChange}
					onVisiblePathsChange={visible}
				/>
			);
		}
		await act(async () => root.render(<Controlled />));
		expect(container.querySelector<HTMLSelectElement>('select[aria-label="Diff layout"]')?.value).toBe("unified");
		expect(container.querySelectorAll("[data-diff-path]")).toHaveLength(1);
		expect(container.textContent).toContain("File 1 of 2");
		expect(container.textContent).toContain("Difference 1 of 2");
		expect(button("Previous file").disabled).toBe(true);
		expect(button("Previous difference").disabled).toBe(true);
		await click("Next difference");
		expect(container.textContent).toContain("Difference 2 of 2");
		expect(button("Next difference").disabled).toBe(true);
		const marked = Array.from(container.querySelectorAll('[data-current-difference="true"]'));
		expect(marked).toHaveLength(2);
		expect(marked[0]?.textContent).toContain("last");
		const select = container.querySelector<HTMLSelectElement>('select[aria-label="Diff layout"]')!;
		await act(async () => {
			select.value = "split";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(container.querySelector(".kb-diff-split-grid-shell")).not.toBeNull();
		expect(container.textContent).toContain("Difference 2 of 2");
		await click("Next file");
		expect(container.querySelector("[data-diff-path]")?.getAttribute("data-diff-path")).toBe("b.ts");
		expect(container.textContent).toContain("Difference 1 of 2");
		expect(button("Next file").disabled).toBe(true);
		expect(visible.mock.calls.map(([paths]) => paths)).toEqual([["a.ts"], ["b.ts"]]);
	});

	it.each(["compare", "working-copy"] as const)(
		"keeps resulting-file navigation and selection independent of %s comparison semantics",
		async (kind) => {
			const reviewScope = {
				...scope,
				revisions:
					kind === "working-copy"
						? { kind, base: "HEAD", head: "WORKTREE", headSource: "live-worktree" as const }
						: { kind, base: "main", head: "feature", mode: "three_dot" as const },
			};
			await render({
				reviewScope,
				projectFiles: [modified("a.ts", "old\nkeep\ndelete\nkeep too\nlast", "new\nkeep\nkeep too\n")],
			});
			await click("Next difference");
			expect(container.textContent).toContain("Difference 2 of 3");
			const documentKey = container.querySelector("[data-review-document]")?.getAttribute("data-review-document");
			await setLayout("resulting");
			expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("resulting");
			expect(container.textContent).toContain("Difference 2 of 3");
			expect(container.querySelector("[data-review-document]")?.getAttribute("data-review-document")).toBe(
				documentKey,
			);
			expect(
				container.querySelector('[data-diff-side="removed"][data-diff-line="3"][data-current-difference="true"]'),
			).not.toBeNull();
			await click("Next difference");
			expect(container.textContent).toContain("Difference 3 of 3");
			expect(button("Next difference").disabled).toBe(true);
			expect(
				container.querySelector('[data-diff-side="removed"][data-diff-line="5"][data-current-difference="true"]'),
			).not.toBeNull();
			await click("Previous difference");
			await click("Previous difference");
			expect(container.textContent).toContain("Difference 1 of 3");
			expect(button("Previous difference").disabled).toBe(true);
			expect(
				container.querySelector('[data-diff-side="removed"][data-diff-line="1"][data-current-difference="true"]'),
			).not.toBeNull();
			await setLayout("unified");
			expect(container.textContent).toContain("Difference 1 of 3");
			expect(props.onSelectedPathChange).not.toHaveBeenCalled();
			expect(props.onCommentsChange).not.toHaveBeenCalled();
		},
	);

	it("preserves a valid hunk and viewport through unchanged refreshes; resets refs", async () => {
		await render();
		await click("Next difference");
		const scroller = container.querySelector<HTMLElement>("[data-diff-scroll-container]")!;
		scroller.scrollTop = 123;
		await render({
			projectFiles: [modified("a.ts"), modified("b.ts")],
			reviewScope: { ...scope, revisions: { ...scope.revisions, version: 2 } },
		});
		expect(container.textContent).toContain("Difference 2 of 2");
		expect(scroller.scrollTop).toBe(123);
		await render({ projectFiles: [modified("a.ts", "prefix\nold\nkeep\nlast", "prefix\nnew\nkeep\nfinal")] });
		expect(container.textContent).toContain("Difference 2 of 2");
		expect(container.querySelector('[data-current-difference="true"]')?.getAttribute("data-diff-line")).toBe("4");
		await render({ reviewScope: { ...scope, revisions: { ...scope.revisions, head: "c" } } });
		expect(container.textContent).toContain("Difference 1 of 2");
		await render({ projectFiles: [modified("a.ts", "prefix\nold\nkeep", "prefix\nnew\nkeep")] });
		expect(container.textContent).toContain("Difference 1 of 1");
	});

	it("reconciles a removed selected file to its nearest surviving slot", async () => {
		await render({ projectFiles: [modified("a.ts"), modified("b.ts"), modified("c.ts")], selectedPath: "b.ts" });
		await render({ projectFiles: [modified("a.ts"), modified("c.ts")] });
		expect(props.onSelectedPathChange).toHaveBeenCalledWith("c.ts");
		expect(container.querySelector("[data-diff-path]")?.getAttribute("data-diff-path")).toBe("c.ts");
	});

	it("keeps binary, empty, rename-only, loading and unavailable files navigable with honest counts", async () => {
		await render({ selectedPath: "image.png", projectFiles: [modified("image.png")] });
		expect(container.textContent).toContain("Binary file");
		expect(container.textContent).toContain("Difference 0 of 0");
		await render({ selectedPath: "empty.ts", projectFiles: [modified("empty.ts", "", "")] });
		expect(container.textContent).toContain("No textual differences");
		await render({
			selectedPath: "renamed.ts",
			projectFiles: [{ ...modified("renamed.ts", "same", "same"), status: "renamed", previousPath: "old.ts" }],
		});
		expect(container.textContent).toContain("Renamed from old.ts");
		expect(container.textContent).toContain("Difference 0 of 0");
		await render({
			selectedPath: "a.ts",
			projectFiles: [modified("a.ts", undefined, undefined)].map((file) => ({
				...file,
				oldText: null,
				newText: null,
			})),
		});
		expect(container.textContent).toContain("Loading diff");
		expect(container.textContent).toContain("Differences pending");
		await render({ fileLoadingState: { loaded: new Set(["a.ts"]), loading: new Set() } });
		expect(container.textContent).toContain("Diff content is unavailable");
		expect(container.textContent).toContain("Differences unavailable");
		expect(button("Next difference").disabled).toBe(true);
		await render({ projectFiles: [] });
		expect(container.textContent).toContain("File 0 of 0");
		expect(container.textContent).toContain("No changes to display");
		await render({ projectFiles: null });
		expect(container.textContent).toContain("Loading changes");
	});

	it.each(["inline", "focused"] as const)(
		"shows initial and stale fetch errors in %s without endless skeletons",
		async (presentation) => {
			await render({
				presentation,
				projectFiles: [{ ...modified("a.ts"), oldText: null, newText: null }],
				fileLoadingState: { loaded: new Set(), loading: new Set(), errors: new Map([["a.ts", "Request failed"]]) },
			});
			expect(container.textContent).toContain("Could not load diff");
			expect(container.textContent).toContain("Request failed");
			expect(container.querySelector(".kb-skeleton")).toBeNull();
			expect(container.querySelector(".kb-diff-row")).toBeNull();
			if (presentation === "focused") expect(container.textContent).toContain("Differences unavailable");
			await render({
				projectFiles: [modified("a.ts")],
				fileLoadingState: {
					loaded: new Set(["a.ts"]),
					loading: new Set(),
					errors: new Map([["a.ts", "Request failed"]]),
				},
			});
			expect(container.textContent).toContain("Showing previously loaded content");
			expect(container.querySelector(".kb-diff-row-added")?.textContent).toContain("new");
			await render({ fileLoadingState: { loaded: new Set(["a.ts"]), loading: new Set() } });
			expect(container.textContent).not.toContain("Request failed");
		},
	);

	it("keeps deletion-only EOF differences visible on the old side", async () => {
		await render({ projectFiles: [modified("a.ts", "keep\ndeleted", "keep\n")] });
		expect(container.textContent).toContain("Difference 1 of 1");
		expect(
			container.querySelector('[data-current-difference="true"][data-diff-side="removed"][data-diff-line="2"]')
				?.textContent,
		).toContain("deleted");
	});

	it("ignores incoming comments and mutation callbacks, including send hotkeys", async () => {
		const mutate = vi.fn();
		await render({
			comments: new Map([
				[
					"draft",
					{ filePath: "a.ts", lineNumber: 1, variant: "added", lineText: "new", comment: "Draft must survive" },
				],
			]),
			onCommentsChange: mutate,
			onRollbackFile: mutate,
			onSendToTerminal: mutate,
		});
		await setLayout("resulting");
		expect(container.textContent).not.toContain("Draft must survive");
		expect(container.textContent).not.toContain("Send all comments");
		expect(container.querySelector(".kb-diff-comment-gutter")).toBeNull();
		await act(async () => {
			container.querySelector(".kb-diff-line-number")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			container
				.querySelector("[data-focused-review]")
				?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true }),
				);
		});
		expect(mutate).not.toHaveBeenCalled();
	});

	it("supports scoped keyboard stepping without stealing form controls", async () => {
		await render();
		await act(async () =>
			container
				.querySelector("[data-diff-scroll-container]")
				?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })),
		);
		expect(container.textContent).toContain("Difference 2 of 2");
		await act(async () =>
			container
				.querySelector("select")
				?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true })),
		);
		expect(container.textContent).toContain("Difference 2 of 2");
		await act(async () =>
			container
				.querySelector("[data-diff-scroll-container]")
				?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })),
		);
		expect(props.onSelectedPathChange).toHaveBeenCalledWith("b.ts");
	});

	it("reveals offscreen deferred old-side anchors, cancels superseded jumps, and switches layouts", async () => {
		const observe = vi.fn();
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe = observe;
				disconnect = vi.fn();
				unobserve = vi.fn();
			},
		);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const scroll = container.querySelector<HTMLElement>("[data-diff-scroll-container]")?.scrollTop ?? 0;
			const top = this.hasAttribute("data-diff-line") ? Number(this.dataset.diffLine) * 22 - scroll : 0;
			return {
				top,
				bottom: top + 22,
				left: 0,
				right: 600,
				x: 0,
				y: top,
				width: 600,
				height: 22,
				toJSON: () => ({}),
			};
		});
		const oldLines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
		const nextLines = oldLines.map((line, index) => ([0, 250, 499].includes(index) ? `changed ${index + 1}` : line));
		await render({ projectFiles: [modified("a.ts", oldLines.join("\n"), nextLines.join("\n"))] });
		expect(observe).toHaveBeenCalled();
		expect(container.querySelector('[data-diff-line="251"]')).toBeNull();
		await click("Next difference");
		expect(container.querySelector('[data-diff-side="removed"][data-diff-line="251"]')).not.toBeNull();
		const scroller = container.querySelector<HTMLElement>("[data-diff-scroll-container]")!;
		expect(scroller.scrollTop).toBeGreaterThan(5000);
		await click("Previous difference");
		await act(async () => {
			button("Next difference").click();
			button("Next difference").click();
		});
		expect(container.textContent).toContain("Difference 3 of 3");
		expect(scroller.scrollTop).toBeGreaterThan(10000);
		const select = container.querySelector<HTMLSelectElement>("select")!;
		await act(async () => {
			select.value = "split";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(
			container.querySelector('[data-diff-side="removed"][data-diff-line="500"][data-current-difference="true"]'),
		).not.toBeNull();
		expect(scroller.scrollTop).toBeGreaterThan(10000);
		await setLayout("resulting");
		expect(
			container.querySelector('[data-diff-side="removed"][data-diff-line="500"][data-current-difference="true"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("Difference 3 of 3");
		expect(scroller.scrollTop).toBeGreaterThan(10000);
		await click("Previous difference");
		expect(
			container.querySelector('[data-diff-side="removed"][data-diff-line="251"][data-current-difference="true"]'),
		).not.toBeNull();
		expect(scroller.scrollTop).toBeGreaterThan(5000);
	});
});
