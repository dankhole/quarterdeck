import { EditorState } from "@codemirror/state";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePatchToRows, ReadOnlyUnifiedDiff } from "@/components/shared/diff-renderer";
import { decorateDiffSymbolHtml } from "@/components/shared/diff-symbol-highlighting";
import { useEscapeHandler } from "@/hooks/app/use-escape-handler";
import { diffSymbolRanges } from "@/hooks/git/diff-symbol";
import type { CardSelection } from "@/types";
import { SplitDiff } from "./diff-split";
import { UnifiedDiff } from "./diff-unified";

const oldText = "market markets supermarket Market $market market_id\nconsume(market, 1);\nmarket.finish();";
const newText = "market markets supermarket Market $market market_id\nconsume(market, 2);\nmarket.finish();";
const selectedCard: CardSelection = {
	card: { id: "task", title: null, prompt: "Task", baseRef: "main", createdAt: 1, updatedAt: 1 },
	column: { id: "in_progress", title: "In Progress", cards: [] },
	allColumns: [],
};

describe.each(["split", "unified", "patch"] as const)("%s symbol occurrence clicks", (view) => {
	let container: HTMLDivElement;
	let root: Root;
	const addComment = vi.fn();
	const deselectTask = vi.fn();
	const closeGitHistory = vi.fn();
	function AppEscapeHarness({ children }: { children: ReactNode }): ReactNode {
		useEscapeHandler({ isGitHistoryOpen: false, closeGitHistory, selectedCard, setSelectedTaskId: deselectTask });
		return children;
	}
	const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
		environment.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		addComment.mockClear();
		deselectTask.mockClear();
		closeGitHistory.mockClear();
		window.getSelection()?.removeAllRanges();
		// jsdom has no layout. Give each character a 10px rectangle so the
		// tests exercise the real caret-offset and glyph hit-testing paths.
		Object.defineProperty(Range.prototype, "getClientRects", {
			configurable: true,
			value: function (this: Range) {
				const text = this.startContainer.parentElement?.closest(".kb-diff-text");
				const before = document.createRange();
				if (text) before.selectNodeContents(text);
				before.setEnd(this.startContainer, this.startOffset);
				const left = before.toString().length * 10;
				return [{ left, right: left + 10, top: 0, bottom: 20 }];
			},
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		Reflect.deleteProperty(Range.prototype, "getClientRects");
		Reflect.deleteProperty(document, "caretPositionFromPoint");
		environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	async function render(
		path = "Market.java",
		before = oldText,
		after = newText,
		options: { appEscape?: boolean; twoDiffs?: boolean; keyboardOwner?: boolean } = {},
	) {
		await act(async () => {
			let content: ReactNode;
			if (view === "patch") {
				const rows = parsePatchToRows(
					`@@ -40,3 +70,3 @@\n ${after.split("\n")[0]}\n-${before.split("\n")[1]}\n+${after.split("\n")[1]}\n ${after.split("\n")[2]}\n`,
				);
				content = <ReadOnlyUnifiedDiff path={path} rows={rows} />;
			} else {
				const Renderer = view === "split" ? SplitDiff : UnifiedDiff;
				content = (
					<Renderer
						path={path}
						oldText={before}
						newText={after}
						comments={new Map()}
						onAddComment={addComment}
						onUpdateComment={() => {}}
						onDeleteComment={() => {}}
					/>
				);
			}
			if (options.twoDiffs)
				content = (
					<>
						<div data-first-diff>{content}</div>
						<div data-second-diff>{content}</div>
					</>
				);
			if (options.keyboardOwner)
				content = (
					<div data-review-document="keyboard-test">
						<div tabIndex={0} role="region" aria-label="Code navigation owner">
							{content}
						</div>
					</div>
				);
			root.render(options.appEscape ? <AppEscapeHarness>{content}</AppEscapeHarness> : content);
		});
	}

	function lines() {
		return [...container.querySelectorAll<HTMLElement>(".kb-diff-text")];
	}

	function click(line: HTMLElement, offset: number, options: MouseEventInit = {}) {
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		let remaining = offset;
		let node = walker.nextNode();
		while (node && remaining > (node.textContent?.length ?? 0)) {
			remaining -= node.textContent?.length ?? 0;
			node = walker.nextNode();
		}
		Object.defineProperty(document, "caretPositionFromPoint", {
			configurable: true,
			value: () => ({ offsetNode: node!, offset: remaining }),
		});
		act(() =>
			(node?.parentElement ?? line).dispatchEvent(
				new MouseEvent("click", { bubbles: true, clientX: offset * 10 + 1, clientY: 1, ...options }),
			),
		);
	}

	it("highlights exact lexical occurrences across both sides without adding comments or retokenizing", async () => {
		await render();
		const original = container.textContent;
		const syntax = container.querySelectorAll(".kb-diff-text span:not([class^=kb-diff])").length;
		const added = container.querySelector(".kb-diff-segment-added")?.textContent;
		const highlight = vi.spyOn(EditorState, "create");
		click(lines()[0]!, 2);
		const occurrences = [...container.querySelectorAll(".kb-diff-symbol-occurrence")];
		expect(occurrences.length).toBe(view === "split" ? 6 : 4);
		expect(occurrences.every((span) => span.textContent === "market")).toBe(true);
		expect(container.querySelectorAll("[data-symbol-active]")).toHaveLength(1);
		expect(container.textContent).toBe(original);
		expect(container.querySelector(".kb-diff-segment-added")?.textContent).toBe(added);
		expect(syntax).toBeGreaterThan(0);
		expect(highlight).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it("clears on whitespace, punctuation, and Escape", async () => {
		await render();
		const line = lines()[0]!;
		for (const offset of [6, 14]) {
			click(line, 2);
			expect(container.querySelector(".kb-diff-symbol-occurrence")).not.toBeNull();
			click(line, offset);
			expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
		}
		click(line, 2);
		click(lines().find((entry) => entry.textContent?.startsWith("consume("))!, 7);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
		click(line, 2);
		act(() => line.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
		expect(container.querySelector("[data-symbol-active]")).toBeNull();
	});

	it("dismisses highlighting before the real app Escape handler and leaves the second Escape alone", async () => {
		// The app's window listener mounts before a click installs the document
		// listener. Exercise propagation ordering, not mock registration order.
		await render("Market.java", oldText, newText, { appEscape: true, keyboardOwner: true });
		const owner = container.querySelector<HTMLElement>('[aria-label="Code navigation owner"]')!;
		owner.focus();
		click(lines()[0]!, 2);
		expect(document.activeElement).toBe(owner);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).not.toBeNull();
		const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		act(() => owner.dispatchEvent(first));
		expect(first.defaultPrevented).toBe(true);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
		expect(deselectTask).not.toHaveBeenCalled();
		expect(closeGitHistory).not.toHaveBeenCalled();
		act(() => owner.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
		expect(deselectTask).toHaveBeenCalledExactlyOnceWith(null);
	});

	it("clears only the diff receiving Escape, not another highlighted diff", async () => {
		await render("Market.java", oldText, newText, { twoDiffs: true });
		const first = container.querySelector<HTMLElement>("[data-first-diff] .kb-diff-text")!;
		const second = container.querySelector<HTMLElement>("[data-second-diff] .kb-diff-text")!;
		click(first, 2);
		const unrelated = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		act(() => second.dispatchEvent(unrelated));
		expect(unrelated.defaultPrevented).toBe(false);
		expect(container.querySelector("[data-first-diff] .kb-diff-symbol-occurrence")).not.toBeNull();
		click(second, 2);
		expect(container.querySelector("[data-second-diff] .kb-diff-symbol-occurrence")).not.toBeNull();
		act(() => second.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
		expect(container.querySelector("[data-second-diff] .kb-diff-symbol-occurrence")).toBeNull();
		expect(container.querySelector("[data-first-diff] .kb-diff-symbol-occurrence")).not.toBeNull();
	});

	it("ignores already-handled and composing Escape without clearing or consuming unrelated events", async () => {
		await render();
		const line = lines()[0]!;
		click(line, 2);
		line.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
		act(() => line.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
		expect(container.querySelector(".kb-diff-symbol-occurrence")).not.toBeNull();
		const composing = new KeyboardEvent("keydown", {
			key: "Escape",
			isComposing: true,
			bubbles: true,
			cancelable: true,
		});
		act(() => line.dispatchEvent(composing));
		expect(composing.defaultPrevented).toBe(false);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).not.toBeNull();
		const outside = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		act(() => document.body.dispatchEvent(outside));
		expect(outside.defaultPrevented).toBe(false);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).not.toBeNull();
	});

	it("ignores native selections, drags, double clicks and modified clicks", async () => {
		await render();
		const line = lines()[0]!;
		const range = document.createRange();
		range.selectNodeContents(line);
		window.getSelection()?.addRange(range);
		click(line, 2);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
		expect(window.getSelection()?.toString()).toBe(line.textContent);
		window.getSelection()?.removeAllRanges();
		act(() => line.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 })));
		click(line, 2);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
		click(line, 2, { detail: 2 });
		click(line, 2, { ctrlKey: true });
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
		expect(addComment).not.toHaveBeenCalled();
	});

	it("lets plain and modifier code clicks bubble for code navigation without creating comments", async () => {
		await render();
		const bubble = vi.fn();
		container.addEventListener("click", bubble);
		const line = lines()[0]!;
		click(line, 2);
		click(line, 2, { ctrlKey: true });
		click(line, 2, { metaKey: true });
		expect(bubble).toHaveBeenCalledTimes(3);
		expect(addComment).not.toHaveBeenCalled();
		container.removeEventListener("click", bubble);
	});

	it("retains gutter comment behavior and does not decorate comment controls", async () => {
		await render();
		click(lines()[0]!, 2);
		const gutter = container.querySelector(".kb-diff-comment-gutter");
		if (view !== "patch") {
			expect(gutter).not.toBeNull();
			act(() => gutter!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			expect(addComment).toHaveBeenCalledTimes(1);
		}
		expect(container.querySelectorAll(".kb-diff-line-number .kb-diff-symbol-occurrence")).toHaveLength(0);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).not.toBeNull();
	});

	it("hits the trailing half of an identifier but not whitespace beyond EOL", async () => {
		await render();
		const line = lines()[0]!;
		// The nearest caret is AFTER the clicked final glyph.
		click(line, 6, { clientX: 59 });
		expect(container.querySelector(".kb-diff-symbol-occurrence")?.textContent).toBe("market");
		click(line, line.textContent!.length, { clientX: line.textContent!.length * 10 + 30 });
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
	});

	it("leaves deferred rows unrendered and decorates them when revealed", async () => {
		const reveal: (() => void)[] = [];
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(private callback: IntersectionObserverCallback) {}
				observe(target: Element) {
					reveal.push(() =>
						this.callback(
							[{ isIntersecting: true, target }] as IntersectionObserverEntry[],
							this as unknown as IntersectionObserver,
						),
					);
				}
				disconnect() {}
			},
		);
		const before = Array.from({ length: 220 }, (_, index) => `market.before(${index});`).join("\n");
		const after = Array.from({ length: 220 }, (_, index) => `market.after(${index});`).join("\n");
		await act(async () => {
			if (view === "patch") {
				const patch = `@@ -1,220 +1,220 @@\n${before
					.split("\n")
					.map((line) => `-${line}`)
					.join("\n")}\n${after
					.split("\n")
					.map((line) => `+${line}`)
					.join("\n")}\n`;
				root.render(<ReadOnlyUnifiedDiff path="large.unknown" rows={parsePatchToRows(patch)} />);
			} else {
				const Renderer = view === "split" ? SplitDiff : UnifiedDiff;
				root.render(
					<Renderer
						path="large.unknown"
						oldText={before}
						newText={after}
						comments={new Map()}
						onAddComment={addComment}
						onUpdateComment={() => {}}
						onDeleteComment={() => {}}
					/>,
				);
			}
		});
		expect(lines()).toHaveLength(0);
		act(() => reveal[0]!());
		const visible = lines().length;
		expect(visible).toBe(view === "split" ? 160 : 80);
		click(lines()[0]!, 2);
		expect(lines()).toHaveLength(visible);
		expect(container.querySelectorAll(".kb-diff-symbol-occurrence")).toHaveLength(visible);
		act(() => reveal[1]!());
		expect(lines()).toHaveLength(visible * 2);
		expect(container.querySelectorAll(".kb-diff-symbol-occurrence")).toHaveLength(visible * 2);
	});

	it("resets selection when the document or path changes", async () => {
		await render();
		click(lines()[0]!, 2);
		await render("Other.java");
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
		click(lines()[0]!, 2);
		await render("Other.java", oldText, `${newText}\n// update`);
		expect(container.querySelector(".kb-diff-symbol-occurrence")).toBeNull();
	});
});

describe("diff symbol HTML decoration", () => {
	it("preserves escaped text and syntax/intraline spans across identifier boundaries", () => {
		const html = '<span class="token">mar</span><span class="kb-diff-segment-added">ket</span> &lt;market&gt;';
		const result = decorateDiffSymbolHtml(html, diffSymbolRanges("market <market>", "market"));
		const element = document.createElement("div");
		element.innerHTML = result;
		expect(element.textContent).toBe("market <market>");
		expect(element.querySelectorAll(".kb-diff-symbol-occurrence")).toHaveLength(3);
		expect(element.querySelector(".token .kb-diff-symbol-occurrence")?.textContent).toBe("mar");
		expect(element.querySelector(".kb-diff-segment-added .kb-diff-symbol-occurrence")?.textContent).toBe("ket");
		expect(element.querySelector("market")).toBeNull();
	});
});
