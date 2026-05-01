import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { detectSourceEditorLineSeparator } from "./source-editor";

describe("source editor line separators", () => {
	it("preserves CRLF when CodeMirror serializes editor state", () => {
		const content = "const value = 1;\r\nconst next = 2;\r\n";
		const state = EditorState.create({
			doc: content,
			extensions: [EditorState.lineSeparator.of(detectSourceEditorLineSeparator(content))],
		});

		expect(state.sliceDoc()).toBe(content);
	});

	it("defaults to LF for LF and newline-free documents", () => {
		expect(detectSourceEditorLineSeparator("const value = 1;\n")).toBe("\n");
		expect(detectSourceEditorLineSeparator("const value = 1;")).toBe("\n");
	});
});
