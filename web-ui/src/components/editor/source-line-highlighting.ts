import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import {
	createHighlightedLineCache,
	type HighlightedLineCache,
	MAX_SYNC_HIGHLIGHT_LINE_LENGTH,
	resolvePrismGrammar,
	resolvePrismLanguage,
} from "@/components/shared/syntax-highlighting";
import { languageExtension, quarterdeckHighlightStyle } from "./source-presentation";

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Review rows use the Files editor's parser and palette. Unsupported editor languages retain Prism support. */
export function createSourceLineCache(path: string): HighlightedLineCache {
	const language = resolvePrismLanguage(path);
	const extension = languageExtension(language ?? "", path);
	if (!extension) {
		return createHighlightedLineCache(resolvePrismGrammar(language), language);
	}
	const lines = new Map<string, string | null>();
	return {
		get(line) {
			if (line.length > MAX_SYNC_HIGHLIGHT_LINE_LENGTH) return null;
			if (lines.has(line)) return lines.get(line) ?? null;
			const state = EditorState.create({ doc: line, extensions: extension });
			let offset = 0;
			let html = "";
			highlightTree(syntaxTree(state), quarterdeckHighlightStyle, (from, to, classes) => {
				html += escapeHtml(line.slice(offset, from));
				html += `<span class="${classes}">${escapeHtml(line.slice(from, to))}</span>`;
				offset = to;
			});
			html += escapeHtml(line.slice(offset));
			lines.set(line, html);
			return html;
		},
		clear: () => lines.clear(),
		get size() {
			return lines.size;
		},
	};
}
