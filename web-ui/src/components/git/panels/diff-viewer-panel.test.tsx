import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type DiffLineComment, DiffViewerPanel } from "@/components/git/panels/diff-viewer-panel";
import * as diffRenderer from "@/components/shared/diff-renderer";
import type { RuntimeWorkdirFileChange } from "@/runtime/types";
import * as diffViewerUtils from "./diff-viewer-utils";

function createRect(top: number, height = 24): DOMRect {
	return {
		x: 0,
		y: top,
		width: 600,
		height,
		top,
		right: 600,
		bottom: top + height,
		left: 0,
		toJSON: () => ({}),
	};
}

describe("DiffViewerPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it.each(["unified", "split"] as const)(
		"does not render unchanged %s file rows again on selection or another file load",
		async (viewMode) => {
			const rowSpy = vi.spyOn(diffRenderer, "DiffRowText");
			const files: RuntimeWorkdirFileChange[] = ["a", "b"].map((name) => ({
				path: `${name}.ts`,
				status: "modified",
				additions: 1,
				deletions: 1,
				oldText: `const ${name} = 1;`,
				newText: `const ${name} = 2;`,
			}));
			const comments = new Map<string, DiffLineComment>();
			const onCommentsChange = vi.fn();
			const onSelectedPathChange = vi.fn();
			const render = async (projectFiles: RuntimeWorkdirFileChange[], selectedPath: string) => {
				await act(async () =>
					root.render(
						<DiffViewerPanel
							reviewScope={{
								repository: { projectId: "test", taskId: null },
								revisions: { kind: "commit", base: "a", head: "b" },
							}}
							projectFiles={projectFiles}
							selectedPath={selectedPath}
							onSelectedPathChange={onSelectedPathChange}
							comments={comments}
							onCommentsChange={onCommentsChange}
							viewMode={viewMode}
						/>,
					),
				);
			};
			await render(files, "a.ts");
			expect(rowSpy).toHaveBeenCalled();
			rowSpy.mockClear();
			await render(files, "b.ts");
			expect(rowSpy).not.toHaveBeenCalled();
			await render([...files, { ...files[0]!, path: "c.ts", newText: "const c = 3;" }], "b.ts");
			expect(rowSpy).toHaveBeenCalledTimes(2);
			expect(container.textContent).toContain("const c = 3;");
			const addedRow = container.querySelector(".kb-diff-row-added");
			await act(async () => addedRow?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			expect([...onCommentsChange.mock.calls[0]![0].values()][0]).toMatchObject({
				filePath: "a.ts",
				lineText: "const a = 2;",
			});
		},
	);

	it("scrolls to the selected file using section position relative to the scroll container", async () => {
		const projectFiles: RuntimeWorkdirFileChange[] = [
			{
				path: "src/a.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const a = 1;\n",
				newText: "const a = 2;\n",
			},
			{
				path: "src/b.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: "const b = 1;\n",
				newText: "const b = 2;\n",
			},
		];
		const comments = new Map<string, DiffLineComment>();

		await act(async () => {
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "test", taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					projectFiles={projectFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		const sections = Array.from(container.querySelectorAll("section"));
		expect(sections).toHaveLength(2);

		const scrollContainer = sections[0]?.parentElement;
		expect(scrollContainer).toBeInstanceOf(HTMLDivElement);
		if (!(scrollContainer instanceof HTMLDivElement)) {
			throw new Error("Expected a diff scroll container.");
		}

		Object.defineProperty(scrollContainer, "scrollTop", {
			configurable: true,
			writable: true,
			value: 200,
		});
		Object.defineProperty(scrollContainer, "clientTop", {
			configurable: true,
			value: 1,
		});
		Object.defineProperty(sections[1]!, "offsetTop", {
			configurable: true,
			value: 620,
		});

		vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue(createRect(100));
		vi.spyOn(sections[0]!, "getBoundingClientRect").mockReturnValue(createRect(140));
		vi.spyOn(sections[1]!, "getBoundingClientRect").mockReturnValue(createRect(460));

		const originalGetComputedStyle = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
			if (element === scrollContainer) {
				return Object.assign({}, originalGetComputedStyle(element), { paddingTop: "12px" }) as CSSStyleDeclaration;
			}
			return originalGetComputedStyle(element);
		});

		await act(async () => {
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "test", taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					projectFiles={projectFiles}
					selectedPath="src/b.ts"
					onSelectedPathChange={() => {}}
					comments={comments}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(scrollContainer.scrollTop).toBe(547);
	});

	it("reports visible file paths when the diff panel scrolls", async () => {
		const projectFiles: RuntimeWorkdirFileChange[] = [
			{
				path: "src/a.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: null,
				newText: null,
			},
			{
				path: "src/b.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: null,
				newText: null,
			},
			{
				path: "src/c.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				oldText: null,
				newText: null,
			},
		];
		const onVisiblePathsChange = vi.fn();

		await act(async () => {
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "test", taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					projectFiles={projectFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					onVisiblePathsChange={onVisiblePathsChange}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
				/>,
			);
		});

		const sections = Array.from(container.querySelectorAll("section"));
		expect(sections).toHaveLength(3);
		const scrollContainer = sections[0]?.parentElement;
		expect(scrollContainer).toBeInstanceOf(HTMLDivElement);
		if (!(scrollContainer instanceof HTMLDivElement)) {
			throw new Error("Expected a diff scroll container.");
		}
		Object.defineProperty(scrollContainer, "clientHeight", {
			configurable: true,
			value: 240,
		});
		Object.defineProperty(scrollContainer, "scrollTop", {
			configurable: true,
			writable: true,
			value: 0,
		});
		vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue(createRect(100, 240));
		const sectionARect = vi.spyOn(sections[0]!, "getBoundingClientRect").mockReturnValue(createRect(120, 80));
		const sectionBRect = vi.spyOn(sections[1]!, "getBoundingClientRect").mockReturnValue(createRect(300, 80));
		const sectionCRect = vi.spyOn(sections[2]!, "getBoundingClientRect").mockReturnValue(createRect(900, 80));

		await act(async () => {
			scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		expect(onVisiblePathsChange).toHaveBeenLastCalledWith(["src/a.ts", "src/b.ts"]);

		sectionARect.mockReturnValue(createRect(-500, 80));
		sectionBRect.mockReturnValue(createRect(140, 80));
		sectionCRect.mockReturnValue(createRect(430, 80));

		await act(async () => {
			scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		expect(onVisiblePathsChange).toHaveBeenLastCalledWith(["src/b.ts", "src/c.ts"]);
	});

	it("renders replaced lines side by side in split view", async () => {
		const projectFiles: RuntimeWorkdirFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				oldText: "const value = 1;\n",
				newText: "const value = 2;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "test", taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					projectFiles={projectFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
					viewMode="split"
				/>,
			);
		});

		const splitRows = Array.from(container.querySelectorAll(".kb-diff-split-grid-row"));
		expect(splitRows).toHaveLength(1);
		expect(splitRows[0]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-row-added")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-split-cell-placeholder")).toBeNull();
	});

	it("renders uneven split replacements with an empty placeholder cell", async () => {
		const projectFiles: RuntimeWorkdirFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 2,
				oldText: "const first = 1;\nconst second = 2;\n",
				newText: "const value = 2;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "test", taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					projectFiles={projectFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
					viewMode="split"
				/>,
			);
		});

		const splitRows = Array.from(container.querySelectorAll(".kb-diff-split-grid-row"));
		expect(splitRows).toHaveLength(2);
		expect(splitRows[0]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[0]?.querySelector(".kb-diff-row-added")).toBeInstanceOf(HTMLDivElement);
		expect(splitRows[1]?.querySelector(".kb-diff-row-removed")).toBeInstanceOf(HTMLDivElement);
		const placeholderCell = splitRows[1]?.querySelector(".kb-diff-split-cell-right");
		expect(placeholderCell).toBeInstanceOf(HTMLDivElement);
		expect(placeholderCell?.classList.contains("kb-diff-split-cell-placeholder")).toBe(true);
		expect(placeholderCell?.childElementCount).toBe(0);
		expect(placeholderCell?.querySelector(".kb-diff-line-number")).toBeNull();
	});

	it("does not mark the last line changed when only the final newline differs", async () => {
		const projectFiles: RuntimeWorkdirFileChange[] = [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 0,
				deletions: 0,
				oldText: "const value = 1;",
				newText: "const value = 1;\n",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "test", taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					projectFiles={projectFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(container.querySelector(".kb-diff-row-added")).toBeNull();
		expect(container.querySelector(".kb-diff-row-removed")).toBeNull();
	});

	it("does not render diff rows for binary file paths", async () => {
		const projectFiles: RuntimeWorkdirFileChange[] = [
			{
				path: "assets/logo.png",
				status: "modified",
				additions: 0,
				deletions: 0,
				oldText: "not real image data",
				newText: "still not real image data",
			},
		];

		await act(async () => {
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "test", taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					projectFiles={projectFiles}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={new Map<string, DiffLineComment>()}
					onCommentsChange={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("assets/logo.png");
		expect(container.textContent).toContain("Binary");
		expect(container.querySelector(".kb-diff-row")).toBeNull();
	});

	const files: RuntimeWorkdirFileChange[] = [
		{ path: "a.ts", status: "modified", additions: 1, deletions: 1, oldText: "old a", newText: "new a" },
		{ path: "b.ts", status: "modified", additions: 1, deletions: 1, oldText: "old b", newText: "new b" },
	];
	const makeComment = (filePath = "a.ts", text = "Review this", editing = false): DiffLineComment => ({
		filePath,
		lineNumber: 1,
		lineText: filePath === "a.ts" ? "new a" : "new b",
		variant: "added",
		comment: text,
		editing,
	});
	const commentMap = (...comments: DiffLineComment[]) =>
		new Map(comments.map((comment) => [`${comment.filePath}:${comment.variant}:${comment.lineNumber}`, comment]));
	function ReviewHarness({
		initialComments = new Map(),
		projectFiles = files,
		onSend = async () => ({ ok: true }),
		viewMode = "unified",
	}: {
		initialComments?: Map<string, DiffLineComment>;
		projectFiles?: RuntimeWorkdirFileChange[] | null;
		onSend?: (text: string) => Promise<{ ok: boolean; message?: string }>;
		viewMode?: "unified" | "split";
	}) {
		const [comments, setComments] = useState(initialComments);
		return (
			<DiffViewerPanel
				reviewScope={{
					repository: { projectId: "test", taskId: null },
					revisions: { kind: "commit", base: "a", head: "b" },
				}}
				projectFiles={projectFiles}
				selectedPath={null}
				onSelectedPathChange={() => {}}
				comments={comments}
				onCommentsChange={setComments}
				onSendToTerminal={onSend}
				viewMode={viewMode}
			/>
		);
	}
	const button = (label: string) =>
		Array.from(document.querySelectorAll("button")).find(
			(element) => element.textContent?.replace(/Ctrl|Shift/g, "").trim() === label,
		);
	async function click(label: string) {
		const target = button(label);
		expect(target, label).toBeDefined();
		await act(async () => target?.click());
	}
	async function type(text: string) {
		const textarea = container.querySelector("textarea");
		expect(textarea).not.toBeNull();
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it.each(["unified", "split"] as const)(
		"saves locally, edits saved cards, preserves Cancel text, and deletes explicitly in %s",
		async (viewMode) => {
			const send = vi.fn(async () => ({ ok: true }));
			await act(async () => root.render(<ReviewHarness onSend={send} viewMode={viewMode} />));
			await act(async () =>
				container.querySelector(".kb-diff-row-added")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
			);
			expect(button("Add comment")?.disabled).toBe(true);
			const editor = container.querySelector("textarea")!;
			expect(editor.rows).toBeGreaterThanOrEqual(3);
			Object.defineProperty(editor, "scrollHeight", { configurable: true, value: 164 });
			await type("First line\nSecond line");
			expect(editor.style.height).toBe("164px");
			await click("Add comment");
			expect(send).not.toHaveBeenCalled();
			expect(container.querySelector("textarea")).toBeNull();
			expect(container.textContent).toContain("Unsent");
			expect(container.textContent).toContain("First line\nSecond line");
			await click("Edit");
			expect(button("Update comment")).toBeDefined();
			await type("Retained edit");
			await click("Cancel");
			expect(container.textContent).toContain("Retained edit");
			expect(container.querySelector("textarea")).toBeNull();
			await click("Delete");
			expect(container.textContent).not.toContain("Retained edit");
		},
	);

	it.each(["metaKey", "ctrlKey"] as const)(
		"saves with %s Enter without pasting and Escape only removes empty editors",
		async (modifier) => {
			const send = vi.fn(async () => ({ ok: true }));
			await act(async () =>
				root.render(<ReviewHarness initialComments={commentMap(makeComment("a.ts", "", true))} onSend={send} />),
			);
			await type("Keyboard draft");
			const key = new KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true, cancelable: true });
			await act(async () => container.querySelector("textarea")?.dispatchEvent(key));
			expect(key.defaultPrevented).toBe(true);
			expect(send).not.toHaveBeenCalled();
			expect(container.querySelector("textarea")).toBeNull();
			await click("Edit");
			await type("Keep on Escape");
			await act(async () =>
				container
					.querySelector("textarea")
					?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
			);
			expect(container.textContent).toContain("Keep on Escape");
			await click("Edit");
			await type(" ");
			await act(async () =>
				container
					.querySelector("textarea")
					?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
			);
			expect(container.querySelector("textarea")).toBeNull();
			expect(container.textContent).not.toContain("Unsent");
		},
	);

	it("builds one anchor lookup per file and never reparses or serializes file snapshots while typing", async () => {
		const buildRows = vi.spyOn(diffRenderer, "buildUnifiedDiffRows");
		const buildLookup = vi.spyOn(diffViewerUtils, "createDiffAnchorLookup");
		const comments = commentMap(makeComment("a.ts", "Editing", true), {
			...makeComment("a.ts", "Old side"),
			variant: "removed",
			lineText: "old a",
		});
		await act(async () => root.render(<ReviewHarness initialComments={comments} />));
		expect(buildRows).toHaveBeenCalledTimes(files.length);
		await type("First edit");
		await type("Second edit");
		await type("Third edit");
		expect(buildRows).toHaveBeenCalledTimes(files.length);
		expect(buildLookup).toHaveBeenCalledTimes(files.length);
	});

	it("has one final send, counts distinct files, and includes the latest open editor text", async () => {
		const send = vi.fn(async (_text: string) => ({ ok: true }));
		await act(async () =>
			root.render(
				<ReviewHarness
					initialComments={commentMap(makeComment(), makeComment("b.ts", "Second", true))}
					onSend={send}
				/>,
			),
		);
		expect(container.textContent).toContain("2 comments across 2 files");
		expect(container.querySelector(".kb-diff-comments-footer")?.textContent).not.toContain("Add");
		await type("Latest editor text");
		await click("Send all comments");
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toContain("> Latest editor text");
		expect(send.mock.calls[0]?.[0]).toContain("a.ts:1 | new a");
		expect(container.textContent).not.toContain("Unsent");
	});

	it("scopes the shifted final-send shortcut to this viewer and cancels its event", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		await act(async () => root.render(<ReviewHarness initialComments={commentMap(makeComment())} onSend={send} />));
		const otherEditor = document.createElement("textarea");
		document.body.appendChild(otherEditor);
		try {
			otherEditor.focus();
			const unrelated = new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				metaKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			await act(async () => otherEditor.dispatchEvent(unrelated));
			expect(unrelated.defaultPrevented).toBe(false);
			expect(send).not.toHaveBeenCalled();
			button("Send all comments")?.focus();
			const saveOnly = new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			});
			await act(async () => button("Send all comments")?.dispatchEvent(saveOnly));
			expect(send).not.toHaveBeenCalled();
			const key = new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				metaKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			await act(async () => button("Send all comments")?.dispatchEvent(key));
			expect(key.defaultPrevented).toBe(true);
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			otherEditor.remove();
		}
	});

	it.each(["metaKey", "ctrlKey"] as const)(
		"keeps focus after %s Enter so shifted Enter sends without refocusing",
		async (modifier) => {
			const send = vi.fn(async () => ({ ok: true }));
			await act(async () =>
				root.render(<ReviewHarness initialComments={commentMap(makeComment("a.ts", "", true))} onSend={send} />),
			);
			await type("Keyboard sequence");
			await act(async () =>
				container.querySelector("textarea")?.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Enter",
						code: "Enter",
						[modifier]: true,
						bubbles: true,
						cancelable: true,
					}),
				),
			);
			expect(document.activeElement?.textContent).toBe("Edit");
			await act(async () =>
				document.activeElement?.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Enter",
						code: "Enter",
						[modifier]: true,
						shiftKey: true,
						bubbles: true,
						cancelable: true,
					}),
				),
			);
			expect(send).toHaveBeenCalledTimes(1);
		},
	);

	it("does not steal focus when an already-saved draft mounts", async () => {
		const otherEditor = document.createElement("textarea");
		document.body.append(otherEditor);
		try {
			otherEditor.focus();
			await act(async () => root.render(<ReviewHarness initialComments={commentMap(makeComment())} />));
			expect(document.activeElement).toBe(otherEditor);
		} finally {
			otherEditor.remove();
		}
	});

	it("ignores composing and already-handled shortcut events, and never sends from clear confirmation", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		await act(async () =>
			root.render(<ReviewHarness initialComments={commentMap(makeComment("a.ts", "Draft", true))} onSend={send} />),
		);
		const textarea = container.querySelector("textarea")!;
		for (const shiftKey of [false, true]) {
			const composing = new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				metaKey: true,
				shiftKey,
				isComposing: true,
				bubbles: true,
				cancelable: true,
			});
			await act(async () => textarea.dispatchEvent(composing));
			expect(composing.defaultPrevented).toBe(false);
			const handled = new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				ctrlKey: true,
				shiftKey,
				bubbles: true,
				cancelable: true,
			});
			handled.preventDefault();
			await act(async () => textarea.dispatchEvent(handled));
		}
		expect(container.querySelector("textarea")).not.toBeNull();
		expect(send).not.toHaveBeenCalled();
		await click("Clear all");
		const keep = button("Keep comments")!;
		keep.focus();
		await act(async () =>
			keep.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					code: "Enter",
					ctrlKey: true,
					shiftKey: true,
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(send).not.toHaveBeenCalled();
		await click("Keep comments");
	});

	it("shows the aggregate payload limit and never truncates or splits oversized drafts", async () => {
		const send = vi.fn(async () => ({ ok: true }));
		const longComment = "x".repeat(4000);
		await act(async () =>
			root.render(
				<ReviewHarness
					initialComments={commentMap(makeComment("a.ts", longComment), makeComment("b.ts", longComment))}
					onSend={send}
				/>,
			),
		);
		expect(container.textContent).toContain("8,000 characters");
		expect(container.textContent).toContain("Nothing will be truncated or split");
		expect(button("Send all comments")?.disabled).toBe(true);
		await click("Send all comments");
		expect(send).not.toHaveBeenCalled();
	});

	it("disables final actions while pending and retains drafts with an inline send error", async () => {
		let finish!: (result: { ok: boolean; message?: string }) => void;
		const send = vi.fn(
			() =>
				new Promise<{ ok: boolean; message?: string }>((resolve) => {
					finish = resolve;
				}),
		);
		await act(async () => root.render(<ReviewHarness initialComments={commentMap(makeComment())} onSend={send} />));
		await click("Send all comments");
		expect(button("Sending…")?.disabled).toBe(true);
		expect(button("Clear all")?.disabled).toBe(true);
		await act(async () => finish({ ok: false, message: "Agent is unavailable" }));
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Agent is unavailable");
		expect(container.textContent).toContain("Review this");
	});

	it("requires confirmation to clear nonempty drafts, including a cancelled clear", async () => {
		await act(async () => root.render(<ReviewHarness initialComments={commentMap(makeComment())} />));
		await click("Clear all");
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
		await click("Keep comments");
		expect(container.textContent).toContain("Review this");
		await click("Clear all");
		await click("Clear all comments");
		expect(container.textContent).not.toContain("Review this");
	});

	it.each(["unified", "split"] as const)(
		"keeps changed anchors off mismatched %s rows and exposes original code",
		async (viewMode) => {
			const comment = makeComment();
			await act(async () =>
				root.render(
					<DiffViewerPanel
						reviewScope={{
							repository: { projectId: "test", taskId: null },
							revisions: { kind: "commit", base: "a", head: "b" },
						}}
						projectFiles={[{ ...files[0]!, newText: "replacement" }]}
						selectedPath={null}
						onSelectedPathChange={() => {}}
						comments={commentMap(comment)}
						onCommentsChange={() => {}}
						viewMode={viewMode}
					/>,
				),
			);
			expect(container.querySelector(".kb-diff-row-commented")).toBeNull();
			const detached = container.querySelector('[aria-label="Unanchored review drafts"]');
			expect(detached?.textContent).toContain("Outdated");
			expect(detached?.textContent).toContain("a.ts:1");
			expect(detached?.textContent).toContain("new a");
			expect(detached?.textContent).toContain("Review this");
		},
	);

	it.each(["unified", "split"] as const)(
		"keeps outdated and new same-address %s drafts independent",
		async (viewMode) => {
			const send = vi.fn(async (_text: string) => ({ ok: false, message: "Keep drafts" }));
			const original: RuntimeWorkdirFileChange[] = [
				{ ...files[0]!, oldText: "before\nsame\nsame", newText: "after\nsame\nsame" },
			];
			await act(async () =>
				root.render(<ReviewHarness projectFiles={original} viewMode={viewMode} onSend={send} />),
			);
			await act(async () =>
				container
					.querySelector('[data-diff-line="2"][data-code-navigation-side="new"]')
					?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
			);
			await type("Original repeated line");
			await click("Add comment");
			await act(async () =>
				root.render(
					<ReviewHarness
						projectFiles={[{ ...original[0]!, newText: "after\nsame\nsame\nchanged elsewhere" }]}
						viewMode={viewMode}
						onSend={send}
					/>,
				),
			);
			expect(container.querySelector(".kb-diff-row-commented")).toBeNull();
			const detached = () => container.querySelector('[aria-label="Unanchored review drafts"]')!;
			expect(detached().textContent).toContain("Original repeated line");
			await act(async () =>
				container
					.querySelector('[data-diff-line="2"][data-code-navigation-side="new"]')
					?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
			);
			expect(container.querySelectorAll(".kb-diff-inline-comment")).toHaveLength(2);
			await type("New repeated line");
			await click("Add comment");
			expect(container.querySelector(".kb-diff-row-commented")).not.toBeNull();
			await click("Send all comments");
			expect(send.mock.calls[0]?.[0]).toContain("> Original repeated line");
			expect(send.mock.calls[0]?.[0]).toContain("> New repeated line");
			const detachedButton = (label: string) =>
				Array.from(detached().querySelectorAll("button")).find((element) => element.textContent === label)!;
			await act(async () => detachedButton("Edit").click());
			await type("Edited original only");
			await click("Update comment");
			expect(detached().textContent).toContain("Edited original only");
			expect(container.querySelector('[data-diff-path="a.ts"]')?.textContent).toContain("New repeated line");
			await act(async () => detachedButton("Delete").click());
			expect(container.querySelector('[aria-label="Unanchored review drafts"]')).toBeNull();
			expect(container.textContent).toContain("New repeated line");
		},
	);

	it.each(["unified", "split"] as const)("reveals drafts within otherwise hidden %s context", async (viewMode) => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
		const comment: DiffLineComment = { ...makeComment(), lineNumber: 20, lineText: "line 20", variant: "context" };
		await act(async () =>
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "test", taskId: null },
						revisions: { kind: "commit", base: "a", head: "b" },
					}}
					projectFiles={[{ ...files[0]!, oldText: lines, newText: lines }]}
					selectedPath={null}
					onSelectedPathChange={() => {}}
					comments={commentMap(comment)}
					onCommentsChange={() => {}}
					viewMode={viewMode}
				/>,
			),
		);
		expect(container.querySelector(".kb-diff-row-commented")).not.toBeNull();
		expect(container.textContent).toContain("Unsent");
		expect(container.textContent).toContain("Review this");
	});

	it("warns to check the agent after uncertain delivery without losing drafts", async () => {
		await act(async () =>
			root.render(
				<ReviewHarness
					initialComments={commentMap(makeComment())}
					onSend={async () => {
						throw new Error("transport disconnected");
					}}
				/>,
			),
		);
		await click("Send all comments");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Check the agent before resending");
		expect(container.textContent).toContain("Review this");
	});

	it("treats files with missing content as unloaded even without loading metadata", async () => {
		await act(async () =>
			root.render(
				<ReviewHarness
					initialComments={commentMap(makeComment())}
					projectFiles={[{ ...files[0]!, oldText: null, newText: null }]}
				/>,
			),
		);
		expect(container.textContent).toContain("Waiting for diff");
		expect(container.textContent).not.toContain("Outdated —");
	});

	it("keeps removed-file drafts editable when there are no file groups", async () => {
		await act(async () =>
			root.render(<ReviewHarness initialComments={commentMap(makeComment())} projectFiles={[]} />),
		);
		expect(container.textContent).toContain("file no longer in this diff");
		expect(button("Send all comments")).toBeDefined();
		await click("Edit");
		await type("Still editable");
		await click("Update comment");
		expect(container.textContent).toContain("Still editable");
	});

	it("does not classify unloaded drafts as outdated and keeps collapsed drafts visible", async () => {
		await act(async () =>
			root.render(<ReviewHarness initialComments={commentMap(makeComment())} projectFiles={null} />),
		);
		expect(container.textContent).toContain("Waiting for diff");
		expect(container.textContent).not.toContain("Outdated —");
		await act(async () => root.render(<ReviewHarness initialComments={commentMap(makeComment())} />));
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.click());
		expect(container.querySelector('[aria-label="Unanchored review drafts"]')?.textContent).toContain(
			"File collapsed",
		);
		expect(container.textContent).toContain("Review this");
	});
});
