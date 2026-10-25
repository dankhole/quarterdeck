import { forceParsing } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { type Tag, tags } from "@lezer/highlight";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceEditor } from "./source-editor";
import { quarterdeckHighlightStyle } from "./source-presentation";

function expectRenderedCategory(host: HTMLElement, text: string, tag: Tag): void {
	const expectedClass = quarterdeckHighlightStyle.style([tag]);
	expect(expectedClass).not.toBeNull();
	const spans = [...host.querySelectorAll(".cm-line span")];
	expect(
		spans.some((span) => span.textContent === text && span.classList.contains(expectedClass ?? "")),
		`${JSON.stringify(text)} should render with the editor's token category`,
	).toBe(true);
}

describe("SourceEditor C# highlighting wiring", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	it.each([
		{ language: "csharp", path: "Example.cs", readOnly: false },
		{ language: "", path: "Example.CS", readOnly: true },
	])("renders C# categories for $path (readOnly=$readOnly)", async ({ language, path, readOnly }) => {
		const value = 'public class Example { string Name = "demo"; int Count = 42; } // note';
		const onChange = vi.fn();
		await act(async () => {
			root.render(
				<SourceEditor
					path={path}
					language={language}
					value={value}
					readOnly={readOnly}
					wordWrap={false}
					onChange={onChange}
				/>,
			);
		});

		const editor = host.querySelector<HTMLElement>(".cm-editor");
		expect(editor).not.toBeNull();
		if (!editor) throw new Error("SourceEditor did not mount CodeMirror");
		const view = EditorView.findFromDOM(editor);
		expect(view).not.toBeNull();
		if (!view) throw new Error("The mounted editor has no EditorView");
		act(() => {
			expect(forceParsing(view, view.state.doc.length, 1_000)).toBe(true);
		});

		expectRenderedCategory(host, "public", tags.keyword);
		expectRenderedCategory(host, '"demo"', tags.string);
		expectRenderedCategory(host, "42", tags.number);
		expectRenderedCategory(host, "// note", tags.comment);
		expect(view.state.sliceDoc()).toBe(value);
		expect(onChange).not.toHaveBeenCalled();
	});
});
