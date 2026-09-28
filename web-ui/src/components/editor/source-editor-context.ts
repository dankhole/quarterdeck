import type { EditorState } from "@codemirror/state";

export interface SourceEditorPosition {
	line: number;
	character: number;
}

export interface SourceEditorRange {
	start: SourceEditorPosition;
	end: SourceEditorPosition;
}

export interface SourceEditorActionContext {
	path: string;
	content: string;
	documentVersion: number;
	position: SourceEditorPosition;
	selection: { from: number; to: number; text: string; range: SourceEditorRange };
}

export interface SourceEditorAction {
	id: string;
	label: string;
	disabled?: boolean;
	onSelect: (context: SourceEditorActionContext) => void;
}

export function sourceEditorPosition(state: EditorState, offset: number): SourceEditorPosition {
	const line = state.doc.lineAt(offset);
	return { line: line.number - 1, character: offset - line.from };
}

export function sourceEditorOffset(state: EditorState, position: SourceEditorPosition): number {
	const line = state.doc.line(Math.max(1, Math.min(state.doc.lines, position.line + 1)));
	return line.from + Math.max(0, Math.min(line.length, position.character));
}

export function createSourceEditorActionContext(
	state: EditorState,
	path: string,
	documentVersion: number,
): SourceEditorActionContext {
	const selection = state.selection.main;
	return {
		path,
		content: state.sliceDoc(),
		documentVersion,
		position: sourceEditorPosition(state, selection.head),
		selection: {
			from: selection.from,
			to: selection.to,
			text: state.sliceDoc(selection.from, selection.to),
			range: {
				start: sourceEditorPosition(state, selection.from),
				end: sourceEditorPosition(state, selection.to),
			},
		},
	};
}
