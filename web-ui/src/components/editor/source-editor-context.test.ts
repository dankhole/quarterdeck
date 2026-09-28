import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createSourceEditorActionContext, sourceEditorOffset } from "./source-editor-context";

describe("source editor action context", () => {
	it("captures unsaved text, revision and zero-based UTF-16 coordinates with CRLF", () => {
		const state = EditorState.create({
			doc: "// draft\r\nconst emoji = '😀';\r\n",
			extensions: EditorState.lineSeparator.of("\r\n"),
			selection: { anchor: 9, head: 26 },
		});
		const context = createSourceEditorActionContext(state, "src/example.ts", 7);
		expect(context.content).toBe("// draft\r\nconst emoji = '😀';\r\n");
		expect(context.documentVersion).toBe(7);
		expect(context.position).toEqual({ line: 1, character: 17 });
		expect(context.selection.text).toBe("const emoji = '😀");
		expect(context.selection.range.start).toEqual({ line: 1, character: 0 });
	});
	it("clamps result ranges to the loaded document", () => {
		const state = EditorState.create({ doc: "one\nsecond" });
		expect(sourceEditorOffset(state, { line: 1, character: 2 })).toBe(6);
		expect(sourceEditorOffset(state, { line: 30, character: 100 })).toBe(10);
	});
});
