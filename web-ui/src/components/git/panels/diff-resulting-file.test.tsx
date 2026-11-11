import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewDocumentDiff } from "@/components/editor/review-document-diff";
import { DiffScrollTargetContext } from "@/components/shared/diff-scroll-target";
import { createReviewDocument } from "@/hooks/git/review-document";
import { ResultingFileDiff, type ResultingFileDiffProps } from "./diff-resulting-file";
import { commentKey, createDiffAnchorLookup, type DiffLineComment } from "./diff-viewer-utils";

describe("ResultingFileDiff", () => {
	let host: HTMLDivElement;
	let root: Root;
	let props: ResultingFileDiffProps;
	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		props = {
			path: "file.ts",
			oldText: "const before = 0;\nconst value = 1;\nconst after = 0;\n",
			newText: "const before = 0;\nconst value = 2;\nconst after = 0;\n",
			comments: new Map(),
			onAddComment: vi.fn(),
			onUpdateComment: vi.fn(),
			onDeleteComment: vi.fn(),
		};
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});
	async function render(overrides: Partial<ResultingFileDiffProps> = {}) {
		props = { ...props, ...overrides };
		await act(async () => root.render(<ResultingFileDiff {...props} />));
	}
	function marker(): HTMLButtonElement {
		return host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
	}
	async function click(element: Element) {
		await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	}

	it("starts with full new source and a blue marker; only clicking toggles old/new rows", async () => {
		const lookup = createDiffAnchorLookup(props.oldText, props.newText);
		const removed = lookup.rows.find((row) => row.variant === "removed")!;
		await render({ currentHunkRows: new Set([removed.key]) });
		expect(host.querySelectorAll(".kb-diff-row")).toHaveLength(3);
		expect(host.textContent).not.toContain("const value = 1;");
		expect(host.querySelector(".kb-diff-text")?.innerHTML).toContain("<span");
		expect(host.querySelector(".kb-diff-segment-added")).toBeNull();
		expect(marker().className).toContain("border-status-blue");
		expect(marker().getAttribute("aria-expanded")).toBe("false");
		const closedAnchor = host.querySelector('[data-diff-side="removed"][data-diff-line="2"]')!;
		expect(closedAnchor.getAttribute("data-current-difference")).toBe("true");
		expect(closedAnchor.closest(".kb-diff-row")).toBeNull();
		await act(async () => marker().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		expect(marker().getAttribute("aria-expanded")).toBe("false");
		const current = host.querySelector('[data-diff-side="current"][data-diff-line="2"]');
		await click(marker());
		expect(marker().getAttribute("aria-expanded")).toBe("true");
		expect(host.querySelector('[data-diff-side="removed"]')?.getAttribute("data-code-navigation-side")).toBe("old");
		expect(host.querySelector('[data-diff-side="current"][data-diff-line="2"]')).toBe(current);
		expect(host.querySelector(".kb-diff-segment-added")).not.toBeNull();
		expect(props.onAddComment).not.toHaveBeenCalled();
		await click(marker());
		expect(host.textContent).not.toContain("const value = 1;");
	});

	it("keeps old and new drafts visible and stable across toggles, using exact anchors", async () => {
		const revision = createDiffAnchorLookup(props.oldText, props.newText).revision;
		const comments = new Map<string, DiffLineComment>([
			[
				"old-draft",
				{
					filePath: "file.ts",
					lineNumber: 2,
					lineText: "const value = 1;",
					variant: "removed",
					comment: "Old draft",
					anchorRevision: revision,
				},
			],
			[
				"new-draft",
				{
					filePath: "file.ts",
					lineNumber: 2,
					lineText: "const value = 2;",
					variant: "added",
					comment: "New draft",
					anchorRevision: revision,
				},
			],
		]);
		await render({ comments });
		const drafts = [...host.querySelectorAll("textarea")];
		expect(drafts.map((node) => node.value)).toEqual(["Old draft", "New draft"]);
		await click(marker());
		expect([...host.querySelectorAll("textarea")]).toEqual(drafts);
		await click(marker());
		expect([...host.querySelectorAll("textarea")]).toEqual(drafts);
		await render({ comments: new Map() });
		await click(host.querySelector('[data-diff-side="current"][data-diff-line="2"] .kb-diff-line-number')!);
		expect(props.onAddComment).toHaveBeenCalledWith("file.ts", 2, "const value = 2;", "added", revision);
		await click(marker());
		await click(host.querySelector('[data-diff-side="removed"] .kb-diff-line-number')!);
		expect(props.onAddComment).toHaveBeenLastCalledWith("file.ts", 2, "const value = 1;", "removed", revision);
	});

	it.each([
		["deletion", "old\nkeep\n", "keep\n"],
		["replacement", "old\nkeep\n", "new\nkeep\n"],
	])(
		"returns focus to a surviving %s marker when a focused removed-row marker closes",
		async (_kind, oldText, newText) => {
			await render({ oldText, newText });
			const survivor = marker();
			survivor.focus();
			await click(survivor);
			expect(document.activeElement).toBe(survivor);
			const removedMarker = host.querySelector<HTMLButtonElement>('[data-diff-side="removed"] button')!;
			removedMarker.focus();
			const focus = vi.spyOn(survivor, "focus");
			// A native button's keyboard activation dispatches a click, just like this.
			await click(removedMarker);
			expect(document.activeElement).toBe(survivor);
			expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
			expect(survivor.getAttribute("aria-expanded")).toBe("false");
			expect(removedMarker.isConnected).toBe(false);
			expect(props.onAddComment).not.toHaveBeenCalled();
			focus.mockClear();
			await click(survivor);
			await click(survivor);
			expect(document.activeElement).toBe(survivor);
			expect(focus).not.toHaveBeenCalled();
		},
	);

	it.each([
		["old\nkeep\n", "keep\n"],
		["old\nkeep\n", "new\nkeep\n"],
	])("does not steal focus when an unfocused removed marker is clicked", async (oldText, newText) => {
		await render({ oldText, newText });
		await click(marker());
		const removedMarker = host.querySelector<HTMLButtonElement>('[data-diff-side="removed"] button')!;
		const other = document.createElement("button");
		host.append(other);
		other.focus();
		const focus = vi.spyOn(marker(), "focus");
		await click(removedMarker);
		expect(document.activeElement).toBe(other);
		expect(focus).not.toHaveBeenCalled();
		expect(props.onAddComment).not.toHaveBeenCalled();
	});

	it("allows read-only expansion without comment capabilities or drafts", async () => {
		await render({
			readOnlyReview: true,
			comments: new Map([
				[
					commentKey("file.ts", 2, "added"),
					{
						filePath: "file.ts",
						lineNumber: 2,
						lineText: "const value = 2;",
						variant: "added",
						comment: "hidden",
					},
				],
			]),
		});
		await click(marker());
		expect(host.textContent).toContain("const value = 1;");
		expect(host.querySelector("textarea")).toBeNull();
		expect(host.querySelector(".kb-diff-comment-gutter")).toBeNull();
		await click(host.querySelector(".kb-diff-line-number")!);
		expect(props.onAddComment).not.toHaveBeenCalled();
	});

	it.each([
		[null, "added\n", "addition", "green"],
		["deleted\nkeep\n", "keep\n", "deletion", "red"],
		["keep\ndeleted\n", "keep\n", "deletion", "red"],
		["deleted\n", "", "deletion", "red"],
	] as const)("retains accessible %s → %s markers", async (oldText, newText, kind, color) => {
		await render({ oldText, newText });
		expect(marker().getAttribute("aria-label")).toContain(kind);
		expect(marker().className).toContain(`border-status-${color}`);
		await click(marker());
		expect(marker().getAttribute("aria-expanded")).toBe("true");
	});

	it.each(["focus", "selection"] as const)(
		"preserves unchanged source %s on refresh with the same document identity",
		async (mode) => {
			const review = createReviewDocument(
				{
					repository: { projectId: "p", taskId: null },
					revisions: { kind: "working-copy", base: "HEAD", head: "worktree" },
				},
				{ path: props.path },
				{ kind: "text", oldText: props.oldText, newText: props.newText },
			);
			await act(async () =>
				root.render(<ReviewDocumentDiff document={review} viewMode="resulting" interactions={props} />),
			);
			const unchangedMarker = marker();
			const source = host.querySelector('[data-diff-side="current"][data-diff-line="1"] .kb-diff-text')!;
			const selection = document.getSelection()!;
			if (mode === "focus") unchangedMarker.focus();
			else {
				selection.removeAllRanges();
				const range = document.createRange();
				range.selectNodeContents(source);
				selection.addRange(range);
			}
			const selectedText = selection.toString();
			const anchorNode = selection.anchorNode;
			await act(async () =>
				root.render(
					<ReviewDocumentDiff
						document={{
							...review,
							content: {
								kind: "text",
								oldText: props.oldText,
								newText: `${props.newText}const unrelated = 3;\n`,
							},
						}}
						viewMode="resulting"
						interactions={props}
					/>,
				),
			);
			expect(marker()).toBe(unchangedMarker);
			expect(host.querySelector('[data-diff-side="current"][data-diff-line="1"] .kb-diff-text')).toBe(source);
			if (mode === "focus") expect(document.activeElement).toBe(unchangedMarker);
			else {
				expect(selection.toString()).toBe(selectedText);
				expect(selection.anchorNode).toBe(anchorNode);
				selection.removeAllRanges();
			}
		},
	);

	it("resets expansion and stale drafts on content refresh, not unrelated rerenders", async () => {
		await render();
		await click(marker());
		await render({ comments: new Map() });
		expect(marker().getAttribute("aria-expanded")).toBe("true");
		await render({ newText: props.newText.replace("= 2", "= 3") });
		expect(marker().getAttribute("aria-expanded")).toBe("false");
		expect(host.querySelector('[data-code-navigation-side="old"]')).toBeNull();
	});

	it("reveals a deferred removed-side target without opening its replacement", async () => {
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		const oldText = Array.from({ length: 400 }, (_, index) => `old ${index}\nkeep ${index}`).join("\n");
		const newText = oldText.replaceAll("old ", "new ");
		await act(async () =>
			root.render(
				<DiffScrollTargetContext.Provider
					value={{ current: { path: "file.ts", side: "removed", lineNumber: 601 } }}
				>
					<ResultingFileDiff {...props} oldText={oldText} newText={newText} />
				</DiffScrollTargetContext.Provider>,
			),
		);
		expect(host.querySelector('[data-diff-side="removed"][data-diff-line="601"]')).not.toBeNull();
		expect(host.querySelector('[data-code-navigation-side="old"]')).toBeNull();
		expect(
			[...host.querySelectorAll("button[aria-expanded]")].every(
				(button) => button.getAttribute("aria-expanded") === "false",
			),
		).toBe(true);
	});
});
