import { ensureSyntaxTree, type LanguageSupport, StreamLanguage } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import {
	createHighlightedLineCache,
	getHighlightedLineHtml,
	type HighlightedLineCache,
	MAX_SYNC_HIGHLIGHT_LINE_LENGTH,
	resolvePrismGrammar,
	resolvePrismLanguage,
} from "@/components/shared/syntax-highlighting";
import { languageExtension, quarterdeckHighlightStyle } from "./source-presentation";

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// CodeMirror's stream parser stops emitting tokens after 10,000 characters on a line.
const MAX_STREAM_HIGHLIGHT_LINE_LENGTH = 10_000;
const MAX_FRAGMENT_PARSE_TIME_MS = 20;

/** Highlight independent review fragments; callers replace the cache when lazy support becomes ready. */
export function createSourceLineCache(
	path: string,
	extension: LanguageSupport | null = languageExtension("", path),
): HighlightedLineCache {
	const language = resolvePrismLanguage(path);
	if (!extension) {
		return createHighlightedLineCache(resolvePrismGrammar(language), language);
	}
	const isStreamLanguage = extension.language instanceof StreamLanguage;
	const fallbackGrammar = resolvePrismGrammar(language);
	const lines = new Map<string, string | null>();
	return {
		get(line) {
			if (line.length > MAX_SYNC_HIGHLIGHT_LINE_LENGTH) return null;
			if (lines.has(line)) return lines.get(line) ?? null;
			if (isStreamLanguage && line.length > MAX_STREAM_HIGHLIGHT_LINE_LENGTH) {
				// Stream grammars silently stop tokenizing long rows. Prefer Prism, or
				// plain text when unavailable, rather than a partially colored fragment.
				const html = getHighlightedLineHtml(line, fallbackGrammar, language);
				lines.set(line, html);
				return html;
			}
			const state = EditorState.create({ doc: line, extensions: extension });
			// Initial editor parsing covers only a small viewport. Finish this bounded
			// fragment, never a complete review document, or use a safe fallback.
			const tree = ensureSyntaxTree(state, line.length, MAX_FRAGMENT_PARSE_TIME_MS);
			if (!tree) {
				const html = getHighlightedLineHtml(line, fallbackGrammar, language);
				lines.set(line, html);
				return html;
			}
			let offset = 0;
			let html = "";
			highlightTree(tree, quarterdeckHighlightStyle, (from, to, classes) => {
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
