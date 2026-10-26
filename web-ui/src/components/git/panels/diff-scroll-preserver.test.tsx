import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeWorkdirFileChange } from "@/runtime/types";
import { type DiffLineComment, DiffViewerPanel } from "./diff-viewer-panel";

vi.mock("react-hotkeys-hook", () => ({ useHotkeys: () => {} }));

const ROW_HEIGHT = 20;
const HEADER_HEIGHT = 32;
const FOOTER_HEIGHT = 24;
const VIEWPORT_TOP = 100;
const CLIENT_TOP = 2;
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const file = (path: string, current: string[], old: string[] = []): RuntimeWorkdirFileChange => ({
	path,
	status: "modified",
	additions: current.length,
	deletions: old.length,
	oldText: old.length ? text(old) : "",
	newText: current.length ? text(current) : "",
});

function rect(top: number, height: number): DOMRect {
	return { x: 0, y: top, width: 600, height, top, bottom: top + height, left: 0, right: 600, toJSON: () => ({}) };
}

/** Minimal flow layout, derived from committed DOM rather than the next fixture.
 * Hidden deferred chunks retain their estimated height; split cells share a row.
 * Every content rect includes scrollTop, so restoring an absolute scroll value
 * cannot accidentally pass as preserving the same intra-line viewport offset.
 */
function height(element: Element, cache: WeakMap<Element, number>): number {
	const cached = cache.get(element);
	if (cached !== undefined) return cached;
	const measured = measureHeight(element, cache);
	cache.set(element, measured);
	return measured;
}

function measureHeight(element: Element, cache: WeakMap<Element, number>): number {
	if (element.matches(".kb-diff-file-header")) return HEADER_HEIGHT;
	if (element.matches(".kb-diff-split-grid-row, [data-diff-line]")) return ROW_HEIGHT;
	if (element instanceof HTMLElement && element.style.height && !element.children.length) {
		return Number.parseFloat(element.style.height);
	}
	if (element.matches("style, svg")) return 0;
	return Array.from(element.children).reduce((sum, child) => sum + height(child, cache), 0);
}

function offsetWithin(parent: Element, target: Element, cache: WeakMap<Element, number>): number {
	let offset = 0;
	for (const child of parent.children) {
		if (child === target) return offset;
		if (child.contains(target)) {
			return offset + (child.matches(".kb-diff-split-grid-row") ? 0 : offsetWithin(child, target, cache));
		}
		offset += height(child, cache);
	}
	throw new Error("Geometry target is not inside its section");
}

describe("live DiffViewerPanel scroll preservation", () => {
	let host: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	const comments = new Map<string, DiffLineComment>();
	const onSelectedPathChange = vi.fn();
	const onCommentsChange = vi.fn();
	let mode: "unified" | "split";
	let pinnedHeaders: boolean;
	let geometryMutations: MutationObserver;
	let heightCache: WeakMap<Element, number>;

	function viewport(): HTMLDivElement {
		const element = host.querySelector<HTMLDivElement>("[data-diff-scroll-container]");
		if (!element) throw new Error("Missing real diff viewport");
		return element;
	}

	function section(path: string): HTMLElement {
		const element = Array.from(host.querySelectorAll<HTMLElement>("[data-diff-path]")).find(
			(candidate) => candidate.dataset.diffPath === path,
		);
		if (!element) throw new Error(`Missing section ${path}`);
		return element;
	}

	function row(path: string, line: number, side = "current"): HTMLElement {
		const element = section(path).querySelector<HTMLElement>(`[data-diff-line="${line}"][data-diff-side="${side}"]`);
		if (!element) throw new Error(`Missing ${side} row ${path}:${line}`);
		return element;
	}

	function relativeTop(element: HTMLElement): number {
		return element.getBoundingClientRect().top - VIEWPORT_TOP - CLIENT_TOP;
	}

	async function scrollTo(element: HTMLElement, offset = -7): Promise<void> {
		await act(async () => {
			viewport().scrollTop += relativeTop(element) - offset;
			viewport().dispatchEvent(new Event("scroll", { bubbles: true }));
		});
	}

	async function render(files: RuntimeWorkdirFileChange[], selectedPath: string | null = null, scope = "test") {
		await act(async () =>
			root.render(
				<DiffViewerPanel
					projectFiles={files}
					reviewScope={{
						repository: { projectId: scope, taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					selectedPath={selectedPath}
					onSelectedPathChange={onSelectedPathChange}
					comments={comments}
					onCommentsChange={onCommentsChange}
					viewMode={mode}
				/>,
			),
		);
	}

	beforeEach(() => {
		const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
		previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
		environment.IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal("IntersectionObserver", undefined);
		mode = "unified";
		pinnedHeaders = false;
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		heightCache = new WeakMap();
		// takeRecords below invalidates synchronously, including snapshot vs.
		// commit reads before observer callbacks have had a chance to run.
		geometryMutations = new MutationObserver(() => {
			heightCache = new WeakMap();
		});
		geometryMutations.observe(host, { childList: true, subtree: true, attributes: true });
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
			return this.hasAttribute("data-diff-scroll-container") ? 160 : 0;
		});
		vi.spyOn(HTMLElement.prototype, "clientTop", "get").mockImplementation(function (this: HTMLElement) {
			return this.hasAttribute("data-diff-scroll-container") ? CLIENT_TOP : 0;
		});
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (geometryMutations.takeRecords().length) heightCache = new WeakMap();
			if (this.hasAttribute("data-diff-scroll-container")) return rect(VIEWPORT_TOP, 160);
			const owner = this.closest<HTMLElement>("[data-diff-path]");
			const container = owner?.parentElement;
			if (!owner || !container) return rect(0, 0);
			let top = 12;
			for (const sibling of container.querySelectorAll("[data-diff-path]")) {
				if (sibling === owner) break;
				top += height(sibling, heightCache) + FOOTER_HEIGHT + 12;
			}
			if (this !== owner) top += offsetWithin(owner, this, heightCache);
			const naturalTop = VIEWPORT_TOP + CLIENT_TOP + top - container.scrollTop;
			return rect(
				pinnedHeaders && this.matches(".kb-diff-file-header")
					? Math.max(VIEWPORT_TOP + CLIENT_TOP, naturalTop)
					: naturalTop,
				this === owner ? height(owner, heightCache) + FOOTER_HEIGHT : height(this, heightCache),
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		geometryMutations.disconnect();
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it.each(["unified", "split"] as const)(
		"preserves current content and intra-line pixels after insertion in %s",
		async (viewMode) => {
			mode = viewMode;
			pinnedHeaders = true;
			const original = lines(12);
			// Split has removed and current cells at the same Y: current must win.
			const old = lines(12, "old");
			await render([file("a.ts", original, old)]);
			await scrollTo(row("a.ts", 6));
			// CSS sticky headers stay pinned after the natural header scrolls away.
			expect(relativeTop(section("a.ts"))).toBeLessThan(-HEADER_HEIGHT);
			expect(section("a.ts").querySelector(".kb-diff-file-header")!.getBoundingClientRect().bottom).toBeGreaterThan(
				VIEWPORT_TOP + CLIENT_TOP,
			);
			const previousScroll = viewport().scrollTop;
			await render([file("a.ts", ["inserted first", "inserted second", ...original], old)]);
			expect(row("a.ts", 8).textContent).toContain("line 6");
			expect(relativeTop(row("a.ts", 8))).toBe(-7);
			expect(viewport().scrollTop).toBe(previousScroll + 2 * ROW_HEIGHT);
		},
	);

	it("tracks removal above the row and changed preceding file heights/order", async () => {
		const original = lines(15);
		await render([file("b.ts", original), file("a.ts", lines(4, "previous"))]);
		await scrollTo(row("b.ts", 8), -9);
		await render([file("b.ts", original.slice(3)), file("a.ts", lines(11, "previous"))]);
		expect(row("b.ts", 5).textContent).toContain("line 8");
		expect(relativeTop(row("b.ts", 5))).toBe(-9);
		// The real caller sorts paths. Add a new path before the anchor and remove
		// the preceding one, rather than relying on input-array order.
		await render([file("b.ts", original.slice(3)), file("aa.ts", lines(2, "new previous"))]);
		expect(relativeTop(row("b.ts", 5))).toBe(-9);
	});

	it("keeps a removed-side row stable when only current content grows", async () => {
		const old = lines(14, "deleted");
		await render([file("a.ts", lines(5, "replacement"), old)]);
		await scrollTo(row("a.ts", 8, "removed"), -4);
		await render([file("a.ts", lines(10, "replacement"), old)]);
		expect(relativeTop(row("a.ts", 8, "removed"))).toBe(-4);
		expect(row("a.ts", 8, "removed").textContent).toContain("deleted 8");
	});

	it("follows removed content when it becomes restored current context", async () => {
		const base = lines(14);
		const previous = [...base.slice(0, 5), ...base.slice(6, 7), "nearby insertion", ...base.slice(7)];
		await render([file("a.ts", previous, base)]);
		await scrollTo(row("a.ts", 6, "removed"), -6);
		await render([file("a.ts", [...base.slice(0, 7), "nearby insertion", ...base.slice(7)], base)]);
		expect(section("a.ts").querySelector('[data-diff-line="6"][data-diff-side="removed"]')).toBeNull();
		expect(row("a.ts", 6).textContent).toContain("line 6");
		expect(relativeTop(row("a.ts", 6))).toBe(-6);
	});

	it("uses the following surviving neighbor when the anchor line is deleted", async () => {
		const original = lines(12);
		await render([file("a.ts", original)]);
		await scrollTo(row("a.ts", 6));
		await render([
			file(
				"a.ts",
				original.filter((_, i) => i !== 5),
			),
		]);
		expect(row("a.ts", 6).textContent).toContain("line 7");
		expect(relativeTop(row("a.ts", 6))).toBe(-7);
	});

	it("lets explicit selected-path navigation and comparison-scope changes win", async () => {
		const original = lines(14);
		await render([file("a.ts", original), file("b.ts", lines(10, "destination"))]);
		await scrollTo(row("a.ts", 8));
		const beforeScopeChange = viewport().scrollTop;
		await render(
			[file("a.ts", ["scope insertion", ...original]), file("b.ts", lines(10, "destination"))],
			null,
			"other-repository",
		);
		expect(viewport().scrollTop).toBe(beforeScopeChange);
		await scrollTo(row("a.ts", 8));
		await render(
			[
				file("a.ts", ["navigation insertion", "scope insertion", ...original]),
				file("b.ts", lines(10, "destination")),
			],
			"b.ts",
			"other-repository",
		);
		expect(relativeTop(section("b.ts"))).toBe(12);
	});

	it.each(["header", "footer"] as const)("preserves the %s edge when no content row intersects it", async (edge) => {
		await render([file("a.ts", lines(5)), file("b.ts", lines(6))]);
		if (edge === "header") {
			await scrollTo(section("b.ts"), -5);
		} else {
			const last = row("b.ts", 6);
			await scrollTo(last, -ROW_HEIGHT - 5);
		}
		const edgeTop = () =>
			edge === "header"
				? relativeTop(section("b.ts"))
				: section("b.ts").getBoundingClientRect().bottom - VIEWPORT_TOP - CLIENT_TOP;
		const previous = edgeTop();
		await render([file("a.ts", lines(9)), file("b.ts", lines(9))]);
		expect(edgeTop()).toBe(previous);
	});

	it("retains the neighboring file offset if the entire anchored file disappears", async () => {
		await render([file("a.ts", lines(5)), file("b.ts", lines(12)), file("c.ts", lines(10))]);
		await scrollTo(row("b.ts", 8));
		const neighborTop = relativeTop(section("c.ts"));
		await render([file("a.ts", lines(5)), file("c.ts", lines(10))]);
		expect(relativeTop(section("c.ts"))).toBe(neighborTop);
		expect(Number.isFinite(viewport().scrollTop)).toBe(true);
		await render([file("unrelated.ts", lines(3))]);
		expect(Number.isFinite(viewport().scrollTop)).toBe(true);
	});

	it("reveals a shifted deferred target chunk during commit without replaying it over later navigation", async () => {
		const observers: Array<{ callback: IntersectionObserverCallback; target?: Element }> = [];
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				entry: (typeof observers)[number];
				constructor(callback: IntersectionObserverCallback) {
					this.entry = { callback };
					observers.push(this.entry);
				}
				observe(target: Element) {
					this.entry.target = target;
				}
				disconnect() {}
			},
		);
		const original = lines(250);
		await render([file("a.ts", original), file("b.ts", lines(10, "destination"))]);
		expect(host.querySelectorAll("[data-diff-line]")).toHaveLength(10);
		const anchorChunk = observers[1]!;
		await act(async () =>
			anchorChunk.callback(
				[{ isIntersecting: true, target: anchorChunk.target } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			),
		);
		await scrollTo(row("a.ts", 120));
		// Move the anchor to a previously hidden chunk (120 -> 220). Do not
		// deliver another intersection: only commit-phase targeting can reveal it.
		const updated = [file("a.ts", [...lines(100, "inserted"), ...original]), file("b.ts", lines(10, "destination"))];
		await render(updated);
		expect(row("a.ts", 220).textContent).toContain("line 120");
		expect(relativeTop(row("a.ts", 220))).toBe(-7);
		expect(host.querySelectorAll("[data-diff-line]").length).toBeLessThan(300);
		expect(host.querySelector('[data-diff-scroll-pending="true"]')).toBeNull();
		await render(updated, "b.ts");
		expect(relativeTop(section("b.ts"))).toBe(12);
		await scrollTo(row("b.ts", 4), -3);
		const navigatedTop = viewport().scrollTop;
		// A later deferred reveal must not replay a stale pending anchor.
		const hidden = observers.find((observer) => observer.target?.isConnected && !observer.target.children.length);
		expect(hidden).toBeDefined();
		await act(async () =>
			hidden!.callback(
				[{ isIntersecting: true, target: hidden!.target } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			),
		);
		expect(relativeTop(row("b.ts", 4))).toBe(-3);
		// Revealing 80 estimated 21.2px rows as 20px rows changes prior height.
		expect(viewport().scrollTop - navigatedTop).toBeCloseTo(80 * (ROW_HEIGHT - 21.2));
	}, 15_000);
});
