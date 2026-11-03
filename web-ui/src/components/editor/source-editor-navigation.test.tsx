import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorSelection, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceEditor, type SourceEditorHandle, type SourceEditorProps } from "./source-editor";

vi.mock("@/hooks/editor/use-source-language", () => ({ useSourceLanguage: () => null }));
const platform = vi.hoisted(() => ({ isMacPlatform: false }));
vi.mock("@/utils/platform", () => platform);

describe("SourceEditor navigation gestures and lexical occurrences", () => {
	let host: HTMLDivElement;
	let root: Root;
	let props: SourceEditorProps;
	const editorRef = createRef<SourceEditorHandle>();
	const definition = vi.fn();
	const references = vi.fn();
	const hover = vi.fn();

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		platform.isMacPlatform = false;
		document.getSelection()?.removeAllRanges();
		vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation(() => {});
		definition.mockReset();
		references.mockReset();
		hover.mockReset();
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		props = {
			path: "example.java",
			language: "java",
			value: "first();\r\n😀 market(); market(); marketplace();\r\n",
			readOnly: false,
			wordWrap: false,
			onChange: vi.fn(),
			actions: [
				{ id: "code-navigation-definition", label: "Go to Definition", onSelect: definition },
				{ id: "code-navigation-references", label: "Find References", onSelect: references },
				{ id: "code-navigation-hover", label: "Type Information", onSelect: hover },
			],
		};
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	async function render(next: Partial<SourceEditorProps> = {}): Promise<EditorView> {
		props = { ...props, ...next };
		await act(async () => root.render(<SourceEditor {...props} ref={editorRef} />));
		const editor = host.querySelector<HTMLElement>(".cm-editor");
		const view = editor && EditorView.findFromDOM(editor);
		if (!view) throw new Error("SourceEditor did not mount CodeMirror");
		return view;
	}

	async function openMenu(view: EditorView, position: number | null): Promise<void> {
		vi.spyOn(view, "posAtCoords").mockReturnValue(position);
		await act(async () => {
			view.contentDOM.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 40 }),
			);
		});
	}

	async function chooseDefinition(): Promise<void> {
		const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
			element.textContent?.startsWith("Go to Definition"),
		);
		expect(item?.querySelector("kbd")?.textContent).toBe("Ctrl+B");
		await act(async () => item!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	}

	function key(view: EditorView, init: KeyboardEventInit): KeyboardEvent {
		const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
		act(() => view.contentDOM.dispatchEvent(event));
		return event;
	}

	it("right-click targets the clicked UTF-16 position rather than the old caret", async () => {
		const view = await render();
		act(() => view.dispatch({ selection: { anchor: 1 } }));
		await openMenu(view, 14);
		await chooseDefinition();
		expect(definition).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				path: props.path,
				content: props.value,
				position: { line: 1, character: 5 },
				selection: expect.objectContaining({ from: 14, to: 14, text: "" }),
			}),
		);
		expect(props.onChange).not.toHaveBeenCalled();
	});

	it("preserves a right-clicked selection but navigates from the clicked symbol inside it", async () => {
		const view = await render();
		act(() => view.dispatch({ selection: { anchor: 12, head: 30 } }));
		const selection = view.state.selection;
		await openMenu(view, 14);
		expect(view.state.selection.eq(selection)).toBe(true);
		await chooseDefinition();
		expect(definition).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				position: { line: 1, character: 5 },
				selection: expect.objectContaining({ from: 12, to: 30, text: view.state.sliceDoc(12, 30) }),
			}),
		);
	});

	it("preserves multiple selections when right-clicking a secondary selection", async () => {
		const view = await render();
		act(() =>
			view.dispatch({
				selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(12, 18)]),
			}),
		);
		const selection = view.state.selection;
		await openMenu(view, 14);
		expect(view.state.selection.eq(selection)).toBe(true);
		await chooseDefinition();
		expect(definition).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ position: { line: 1, character: 5 } }),
		);
	});

	it("uses the caret for keyboard context menus without resolving pointer coordinates", async () => {
		const view = await render();
		act(() => view.dispatch({ selection: { anchor: 14 } }));
		const coords = vi.spyOn(view, "posAtCoords");
		await act(async () => view.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
		await chooseDefinition();
		expect(coords).not.toHaveBeenCalled();
		expect(definition).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ position: { line: 1, character: 5 } }),
		);
	});

	it("rejects unresolved pointer targets and a menu whose document changed", async () => {
		const view = await render();
		await openMenu(view, null);
		expect(document.querySelector('[role="menu"]')).toBeNull();
		vi.mocked(view.posAtCoords).mockReturnValue(14);
		await openMenu(view, 14);
		act(() => view.dispatch({ changes: { from: 0, insert: "// edited\r\n" } }));
		await chooseDefinition();
		expect(definition).not.toHaveBeenCalled();
	});

	it.each([false, true])("runs keyboard navigation without editing (readOnly=%s)", async (readOnly) => {
		const view = await render({ readOnly });
		act(() => {
			view.dispatch({ selection: { anchor: 14 } });
			view.focus();
		});
		if (readOnly) expect(view.contentDOM.tabIndex).toBe(0);
		expect(key(view, { key: "b", ctrlKey: true }).defaultPrevented).toBe(true);
		expect(key(view, { key: "F7", altKey: true }).defaultPrevented).toBe(true);
		expect(key(view, { key: "q", ctrlKey: true }).defaultPrevented).toBe(true);
		for (const action of [definition, references, hover]) {
			expect(action).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ position: { line: 1, character: 5 }, content: props.value }),
			);
		}
		expect(props.onChange).not.toHaveBeenCalled();
		expect(view.state.selection.main.head).toBe(14);
	});

	it("uses JetBrains macOS keyboard bindings without consuming the non-mac definition binding", async () => {
		platform.isMacPlatform = true;
		const view = await render({ readOnly: true });
		act(() => {
			view.dispatch({ selection: { anchor: 14 } });
			view.focus();
		});
		expect(key(view, { key: "b", metaKey: true }).defaultPrevented).toBe(true);
		expect(key(view, { key: "j", ctrlKey: true }).defaultPrevented).toBe(true);
		expect(definition).toHaveBeenCalledOnce();
		expect(hover).toHaveBeenCalledOnce();
		key(view, { key: "b", ctrlKey: true });
		expect(definition).toHaveBeenCalledOnce();
	});

	it("uses updated action availability without rebuilding the editor", async () => {
		const view = await render();
		expect(await render({ actions: props.actions?.map((action) => ({ ...action, disabled: true })) })).toBe(view);
		act(() => view.focus());
		expect(key(view, { key: "b", ctrlKey: true }).defaultPrevented).toBe(false);
		expect(key(view, { key: "F7", altKey: true }).defaultPrevented).toBe(false);
		expect(definition).not.toHaveBeenCalled();
		expect(references).not.toHaveBeenCalled();
	});

	it("offers pointer feedback and navigates only on the explicit modifier-click", async () => {
		const view = await render();
		vi.spyOn(view, "posAtCoords").mockReturnValue(14);
		act(() => {
			view.contentDOM.dispatchEvent(
				new MouseEvent("mousemove", { bubbles: true, clientX: 30, clientY: 40, ctrlKey: true }),
			);
		});
		expect(view.contentDOM.hasAttribute("data-definition-link")).toBe(true);
		const event = new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
			clientX: 30,
			clientY: 40,
			ctrlKey: true,
		});
		act(() => view.contentDOM.dispatchEvent(event));
		expect(event.defaultPrevented).toBe(true);
		expect(definition).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ position: { line: 1, character: 5 } }),
		);
		expect(view.contentDOM.hasAttribute("data-definition-link")).toBe(false);
		expect(view.state.selection.main.head).toBe(0);
		expect(props.onChange).not.toHaveBeenCalled();
	});

	it("leaves plain clicks, selection-modifier clicks, and secondary buttons to CodeMirror", async () => {
		const view = await render();
		const fallback = vi.fn(() => true);
		act(() =>
			view.dispatch({
				effects: StateEffect.appendConfig.of(EditorView.domEventHandlers({ mousedown: fallback })),
			}),
		);
		for (const modifiers of [
			{},
			{ ctrlKey: true, shiftKey: true },
			{ ctrlKey: true, altKey: true },
			{ button: 2, ctrlKey: true },
		]) {
			act(() =>
				view.contentDOM.dispatchEvent(
					new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...modifiers }),
				),
			);
		}
		expect(fallback).toHaveBeenCalledTimes(4);
		expect(definition).not.toHaveBeenCalled();
	});

	it("highlights the caret word and lexical whole-word occurrences, and clears in whitespace", async () => {
		const view = await render({ value: "market(); market(); marketplace();  " });
		act(() => view.dispatch({ selection: { anchor: 2 } }));
		expect([...host.querySelectorAll(".cm-selectionMatch")].map((element) => element.textContent)).toEqual([
			"market",
			"market",
		]);
		expect(host.querySelector(".cm-selectionMatch-main")?.textContent).toBe("market");
		act(() => view.dispatch({ selection: { anchor: view.state.doc.length - 1 } }));
		expect(host.querySelector(".cm-selectionMatch")).toBeNull();
	});

	it("reveals an exact preview range without stealing focus from its result list", async () => {
		const list = document.createElement("button");
		document.body.appendChild(list);
		list.focus();
		try {
			const view = await render({
				value: "market(); market();",
				readOnly: true,
				scrollToRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 16 } },
				focusOnScrollToRange: false,
			});
			expect(view.state.selection.main.from).toBe(10);
			expect(view.state.selection.main.to).toBe(16);
			expect(document.activeElement).toBe(list);
			expect(props.onChange).not.toHaveBeenCalled();
		} finally {
			list.remove();
		}
	});
	it("retains selection matches and search highlighting without changing the selection", async () => {
		const view = await render({ value: "market(); market(); marketplace();" });
		act(() => {
			view.dispatch({ selection: { anchor: 0, head: 6 } });
			view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "market" })) });
			editorRef.current?.openSearchPanel();
		});
		expect(view.state.selection.main.from).toBe(0);
		expect(view.state.selection.main.to).toBe(6);
		expect(host.querySelector(".cm-selectionMatch")?.textContent).toBe("market");
		expect(host.querySelector(".cm-searchMatch")).not.toBeNull();
		expect(props.onChange).not.toHaveBeenCalled();
	});
});
