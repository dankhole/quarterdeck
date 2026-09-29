import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitDiff } from "./diff-split";
import { UnifiedDiff } from "./diff-unified";
import type { DiffLineComment } from "./diff-viewer-utils";

describe.each([
	["unified", UnifiedDiff],
	["split", SplitDiff],
] as const)("%s diff context expansion", (_name, Renderer) => {
	const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	const observers: IntersectionObserverCallback[] = [];

	beforeEach(() => {
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		observers.length = 0;
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(callback: IntersectionObserverCallback) {
					observers.push(callback);
				}
				observe() {}
				disconnect() {}
			},
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		window.getSelection()?.removeAllRanges();
		vi.unstubAllGlobals();
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	async function renderDiff(lineCount: number, changedLines: number) {
		const oldLines = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`);
		const newLines = oldLines.map((line, index) => (index >= lineCount - changedLines ? `changed ${line}` : line));
		const comment: DiffLineComment = {
			filePath: "a.txt",
			lineNumber: lineCount,
			lineText: newLines[lineCount - 1]!,
			variant: "added",
			comment: "review note",
		};
		await act(async () =>
			root.render(
				<Renderer
					path="a.txt"
					oldText={oldLines.join("\n")}
					newText={newLines.join("\n")}
					comments={new Map([[`a.txt:added:${lineCount}`, comment]])}
					onAddComment={() => {}}
					onUpdateComment={() => {}}
					onDeleteComment={() => {}}
				/>,
			),
		);
		await act(async () => {
			for (const callback of observers)
				callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
		});
	}

	function findButton(text: string): HTMLButtonElement {
		const button = Array.from(container.querySelectorAll("button")).find((element) =>
			element.textContent?.includes(text),
		);
		expect(button).toBeDefined();
		return button!;
	}

	it("keeps the existing comment, caret and button focus when revealing and hiding preceding context", async () => {
		await renderDiff(100, 1);
		const comment = container.querySelector("textarea")!;
		comment.setSelectionRange(3, 7);
		for (const label of ["↑ 20", "Show all", "Hide", "↓ 20"]) {
			const button = findButton(label);
			button.focus();
			await act(async () => button.click());
			expect(container.querySelector("textarea") === comment).toBe(true);
			expect([comment.selectionStart, comment.selectionEnd]).toEqual([3, 7]);
			expect(document.activeElement === comment).toBe(false);
			if (label === "↑ 20" || label === "↓ 20") expect(document.activeElement === button).toBe(true);
		}
	});

	it.each(["↑", "↓"])(
		"keeps row selection and comment parents across %s context chunk and deferral boundaries",
		async (direction) => {
			await renderDiff(620, 300);
			const comment = container.querySelector("textarea")!;
			const commentParent = comment.parentElement;
			comment.setSelectionRange(3, 7);
			await act(async () => findButton(`${direction} 20`).click());
			const selectedText = direction === "↑" ? "line 310" : "line 10";
			const selectedRow = Array.from(container.querySelectorAll(".kb-diff-text")).find(
				(element) => element.textContent === selectedText,
			)!;
			const selectedParent = selectedRow.parentElement;
			const range = document.createRange();
			range.selectNodeContents(selectedRow);
			comment.blur();
			window.getSelection()!.removeAllRanges();
			window.getSelection()!.addRange(range);
			expect(window.getSelection()!.toString()).toBe(selectedText);
			for (let step = 0; step < 10; step += 1) {
				await act(async () => findButton(`${direction} 20`).click());
				expect(selectedRow.isConnected).toBe(true);
				expect(selectedRow.parentElement === selectedParent).toBe(true);
				expect(window.getSelection()!.toString()).toBe(selectedText);
				expect(container.querySelector("textarea") === comment).toBe(true);
				expect(comment.parentElement === commentParent).toBe(true);
				expect([comment.selectionStart, comment.selectionEnd]).toEqual([3, 7]);
			}
			await act(async () => findButton("Show all").click());
			expect(selectedRow.isConnected).toBe(true);
			expect(window.getSelection()!.toString()).toBe(selectedText);
		},
		// Repeated expansion of 620 rows can exceed the default timeout on shared CI runners.
		15_000,
	);
});
