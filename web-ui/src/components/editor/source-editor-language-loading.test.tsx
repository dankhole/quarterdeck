import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { LanguageDescription, type LanguageSupport, language as languageFacet } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceEditor, type SourceEditorHandle, type SourceEditorProps } from "./source-editor";
import { resolveSourceLanguage } from "./source-language-registry";

vi.mock("./source-language-registry", () => ({
	languageExtension: vi.fn(),
	loadSourceLanguage: vi.fn(),
	resolveSourceLanguage: vi.fn(),
}));

function deferredLanguage() {
	let resolve!: (support: LanguageSupport) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<LanguageSupport>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	const description = LanguageDescription.of({ name: "Deferred language", load: () => promise });
	return { description, resolve, reject };
}

describe("SourceEditor lazy language configuration", () => {
	let host: HTMLDivElement;
	let root: Root;
	let props: SourceEditorProps;
	const editorRef = createRef<SourceEditorHandle>();

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		document.getSelection()?.removeAllRanges();
		vi.mocked(resolveSourceLanguage).mockReset().mockReturnValue(null);
		// Layout measurement is a browser concern; jsdom does not implement
		// Range geometry. Keep the real editor and transactions without RAF layout.
		vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation(() => {});
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		props = {
			path: "example.js",
			language: "javascript",
			value: "const count = 1;\n",
			readOnly: false,
			wordWrap: false,
			onChange: vi.fn(),
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
		if (!editor) throw new Error("SourceEditor did not mount CodeMirror");
		const view = EditorView.findFromDOM(editor);
		if (!view) throw new Error("The mounted editor has no EditorView");
		return view;
	}

	it.each(["\n", "\r\n"])(
		"preserves unsaved edits, history, selection, focus, and %j on completion",
		async (separator) => {
			const pending = deferredLanguage();
			vi.mocked(resolveSourceLanguage).mockReturnValue(pending.description);
			const original = `const count = 1;${separator}const next = 2;${separator}`;
			const view = await render({ value: original });
			expect(view.state.facet(languageFacet)).toBeNull();
			expect(props.onChange).not.toHaveBeenCalled();
			const initialVersion = editorRef.current?.getActionContext()?.documentVersion;

			await act(async () => {
				view.dispatch({ changes: { from: 0, insert: `// unsaved${separator}` }, userEvent: "input.type" });
				view.dispatch({ selection: { anchor: 3, head: 7 } });
				view.focus();
			});
			const edited = view.state.sliceDoc();
			const selection = view.state.selection;
			expect(selection.main.anchor).toBe(3);
			expect(selection.main.head).toBe(7);
			const context = editorRef.current?.getActionContext();
			expect(context?.documentVersion).toBe((initialVersion ?? 0) + 1);
			expect(edited).toBe(`// unsaved${separator}${original}`);
			expect(props.onChange).toHaveBeenCalledExactlyOnceWith(edited);
			expect(undoDepth(view.state)).toBe(1);
			expect(view.hasFocus).toBe(true);
			// jsdom has no layout, but changing configuration must not reset the
			// existing scroller or its offsets even before a browser measurement.
			view.scrollDOM.scrollTop = 73;
			view.scrollDOM.scrollLeft = 19;
			const scrollDOM = view.scrollDOM;
			const destroy = vi.spyOn(view, "destroy");
			const support = javascript();

			await act(async () => pending.resolve(support));

			expect(EditorView.findFromDOM(view.dom)).toBe(view);
			expect(host.querySelector(".cm-editor")).toBe(view.dom);
			expect(destroy).not.toHaveBeenCalled();
			expect(view.state.facet(languageFacet)).toBe(support.language);
			expect(view.state.sliceDoc()).toBe(edited);
			expect(view.state.selection.toJSON()).toEqual(selection.toJSON());
			expect(view.hasFocus).toBe(true);
			expect(view.scrollDOM).toBe(scrollDOM);
			expect(view.scrollDOM.scrollTop).toBe(73);
			expect(view.scrollDOM.scrollLeft).toBe(19);
			expect(editorRef.current?.getActionContext()).toEqual(context);
			expect(props.onChange).toHaveBeenCalledTimes(1);
			expect(undoDepth(view.state)).toBe(1);
			act(() => {
				expect(undo(view)).toBe(true);
			});
			expect(view.state.sliceDoc()).toBe(original);
			expect(redoDepth(view.state)).toBe(1);
			act(() => {
				expect(redo(view)).toBe(true);
			});
			expect(view.state.sliceDoc()).toBe(edited);
		},
	);

	it("preserves redo history while changing languages on the same path", async () => {
		const initialSupport = javascript();
		const warmDescription = LanguageDescription.of({ name: "JavaScript", support: initialSupport });
		vi.mocked(resolveSourceLanguage).mockReturnValue(warmDescription);
		const view = await render();
		expect(view.state.facet(languageFacet)).toBe(initialSupport.language);
		act(() => {
			view.dispatch({ changes: { from: 0, insert: "// edit\n" }, userEvent: "input.type" });
			undo(view);
		});
		const context = editorRef.current?.getActionContext();
		const calls = vi.mocked(props.onChange).mock.calls.length;
		const pending = deferredLanguage();
		vi.mocked(resolveSourceLanguage).mockReturnValue(pending.description);

		expect(await render({ language: "css" })).toBe(view);
		expect(view.state.facet(languageFacet)).toBeNull();
		const support = css();
		await act(async () => pending.resolve(support));

		expect(view.state.facet(languageFacet)).toBe(support.language);
		expect(editorRef.current?.getActionContext()).toEqual(context);
		expect(props.onChange).toHaveBeenCalledTimes(calls);
		expect(redoDepth(view.state)).toBe(1);
		act(() => {
			expect(redo(view)).toBe(true);
		});
		expect(view.state.sliceDoc()).toBe(`// edit\n${props.value}`);
	});

	it.each(["unknown", "failure"])(
		"remains editable and emits no configuration changes for %s grammars",
		async (outcome) => {
			const pending = deferredLanguage();
			if (outcome === "failure") vi.mocked(resolveSourceLanguage).mockReturnValue(pending.description);
			const view = await render({ language: "unavailable", path: "file.unknown" });
			const context = editorRef.current?.getActionContext();
			await act(async () => {
				if (outcome === "failure") pending.reject(new Error("grammar unavailable"));
			});

			expect(host.querySelector(".cm-editor")).toBe(view.dom);
			expect(view.state.facet(languageFacet)).toBeNull();
			expect(editorRef.current?.getActionContext()).toEqual(context);
			expect(props.onChange).not.toHaveBeenCalled();
			expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
			act(() => view.dispatch({ changes: { from: 0, insert: "still editable\n" } }));
			expect(props.onChange).toHaveBeenCalledExactlyOnceWith(`still editable\n${props.value}`);
		},
	);

	it("rejects an obsolete path completion without reconfiguring the replacement view", async () => {
		const first = deferredLanguage();
		const second = deferredLanguage();
		vi.mocked(resolveSourceLanguage).mockImplementation((_language, path) =>
			path === "example.js" ? first.description : second.description,
		);
		const firstView = await render({ language: "" });
		const firstDestroy = vi.spyOn(firstView, "destroy");
		const secondView = await render({ path: "other.css", value: "body { color: red; }\n" });
		expect(secondView).not.toBe(firstView);
		expect(firstDestroy).toHaveBeenCalledOnce();
		const support = css();
		await act(async () => second.resolve(support));
		act(() => {
			secondView.dispatch({ changes: { from: 0, insert: "// second edit\n" } });
			secondView.dispatch({ selection: { anchor: 3 } });
			secondView.focus();
		});
		const context = editorRef.current?.getActionContext();
		const dispatch = vi.spyOn(secondView, "dispatch");
		const calls = vi.mocked(props.onChange).mock.calls.length;

		await act(async () => first.resolve(javascript()));

		expect(host.querySelector(".cm-editor")).toBe(secondView.dom);
		expect(secondView.state.facet(languageFacet)).toBe(support.language);
		expect(secondView.hasFocus).toBe(true);
		expect(editorRef.current?.getActionContext()).toEqual(context);
		expect(props.onChange).toHaveBeenCalledTimes(calls);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("ignores a grammar completion after unmount", async () => {
		const pending = deferredLanguage();
		vi.mocked(resolveSourceLanguage).mockReturnValue(pending.description);
		const view = await render();
		const dispatch = vi.spyOn(view, "dispatch");
		await act(async () => root.render(null));
		await act(async () => pending.resolve(javascript()));
		expect(dispatch).not.toHaveBeenCalled();
		expect(props.onChange).not.toHaveBeenCalled();
	});
});
