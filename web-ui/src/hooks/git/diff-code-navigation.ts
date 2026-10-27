import type { SourceEditorActionContext } from "@/components/editor/source-editor-context";
import type { ReviewDocument } from "./review-document";

export const DIFF_OLD_SIDE_UNAVAILABLE =
	"Code navigation is unavailable for the old/base side. Use the new WORKTREE side or open the live file in Files.";

export function diffCodeNavigationUnavailableReason(document: ReviewDocument): string | null {
	if (document.revisions.headSource !== "live-worktree")
		return "Code navigation is unavailable for historical revisions. Compare against WORKTREE or open the live file in Files.";
	if (document.content.kind !== "text" || !document.newPath)
		return "Code navigation requires a complete new-side WORKTREE text file.";
	return null;
}

/** Range text counts UTF-16 code units, including text in nested syntax/inline-diff spans. */
export function diffTextOffset(element: HTMLElement, node: Node, offset: number): number | null {
	if (!element.contains(node)) return null;
	try {
		const range = element.ownerDocument.createRange();
		range.selectNodeContents(element);
		range.setEnd(node, offset);
		return range.toString().length;
	} catch {
		return null;
	}
}

interface CaretDocument {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

export function diffPointerTextOffset(element: HTMLElement, x: number, y: number): number | null {
	const document: CaretDocument = element.ownerDocument;
	const caret = document.caretPositionFromPoint?.(x, y);
	if (caret) return diffTextOffset(element, caret.offsetNode, caret.offset);
	const range = document.caretRangeFromPoint?.(x, y);
	return range ? diffTextOffset(element, range.startContainer, range.startOffset) : null;
}

export function createDiffActionContext(
	document: ReviewDocument,
	lineNumber: number,
	character: number,
	documentVersion: number,
): SourceEditorActionContext | null {
	if (document.content.kind !== "text" || !document.newPath) return null;
	const content = document.content.newText;
	const lines = content.split("\n");
	const line = lines[lineNumber - 1];
	if (!Number.isInteger(lineNumber) || lineNumber < 1 || line === undefined) return null;
	const length = line.endsWith("\r") ? line.length - 1 : line.length;
	if (!Number.isInteger(character) || character < 0 || character > length) return null;
	const from = lines.slice(0, lineNumber - 1).reduce((offset, text) => offset + text.length + 1, 0) + character;
	const position = { line: lineNumber - 1, character };
	return {
		path: document.newPath,
		content,
		documentVersion,
		position,
		selection: { from, to: from, text: "", range: { start: position, end: position } },
	};
}
