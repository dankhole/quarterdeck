import { Buffer } from "node:buffer";
import c from "refractor/c";
import { refractor } from "refractor/core";
import cpp from "refractor/cpp";
import csharp from "refractor/csharp";
import css from "refractor/css";
import go from "refractor/go";
import java from "refractor/java";
import javascript from "refractor/javascript";
import json from "refractor/json";
import jsx from "refractor/jsx";
import markup from "refractor/markup";
import python from "refractor/python";
import ruby from "refractor/ruby";
import rust from "refractor/rust";
import sql from "refractor/sql";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";

// Register markup first so CSS and JavaScript also tokenize embedded style/script content.
for (const syntax of [
	markup,
	css,
	javascript,
	typescript,
	jsx,
	tsx,
	java,
	csharp,
	c,
	cpp,
	python,
	ruby,
	go,
	rust,
	sql,
	yaml,
	json,
]) {
	refractor.register(syntax);
}

type HighlightNode = ReturnType<typeof refractor.highlight>["children"][number];

const languages = new Map<string, string>([
	["js", "javascript"],
	["mjs", "javascript"],
	["cjs", "javascript"],
	["ts", "typescript"],
	["mts", "typescript"],
	["cts", "typescript"],
	["jsx", "jsx"],
	["tsx", "tsx"],
	["java", "java"],
	["cs", "csharp"],
	["csx", "csharp"],
	["c", "c"],
	["h", "cpp"],
	["cc", "cpp"],
	["cpp", "cpp"],
	["cxx", "cpp"],
	["hh", "cpp"],
	["hpp", "cpp"],
	["hxx", "cpp"],
	["py", "python"],
	["pyi", "python"],
	["rb", "ruby"],
	["go", "go"],
	["rs", "rust"],
	["sql", "sql"],
	["css", "css"],
	["html", "markup"],
	["htm", "markup"],
	["xml", "xml"],
	["svg", "xml"],
	["yaml", "yaml"],
	["yml", "yaml"],
	["json", "json"],
	["jsonc", "json"],
]);

/** Maximum UTF-8 source size admitted to the synchronous tokenizer. */
export const MAX_COMMENT_SOURCE_BYTES = 1_048_576;

/** Half-open comment span in UTF-16 code units, matching JS string and LSP offsets. */
export interface CommentRange {
	from: number;
	to: number;
}

/**
 * Syntax-tokenizer comment spans, sorted and non-overlapping. No file I/O or caching.
 * `null` means unsupported or unclassifiable; `[]` means recognized with no comments.
 *
 * This is synchronous highlighting, not a validating compiler parser. Sources above the
 * shared byte limit return `null`; callers additionally own aggregate read/parse budgets.
 * Synchronous Prism regex execution cannot be time-preempted.
 * Conservatively decline known tokenizer gaps rather than suppress possible code:
 * - C# raw strings and backslash + doubled quote in verbatim strings.
 * - Python f-strings (Prism predates Python 3.12 same-quote interpolation).
 * - JS-family (including embedded HTML JS) comment tokens after an unclassified slash
 *   on the same source line: Prism can
 *   mistake a regex character class for a comment after a control-flow condition.
 * - YAML comment tokens without a whitespace separator before `#`.
 * Shell is deliberately unsupported: Prism confuses word-internal `#` with comments.
 */
export function getCommentRanges(path: string, content: string): readonly CommentRange[] | null {
	const filename = path.split(/[\\/]/).at(-1) ?? "";
	const dot = filename.lastIndexOf(".");
	const language = dot > 0 ? languages.get(filename.slice(dot + 1).toLowerCase()) : undefined;
	if (
		!language ||
		content.length > MAX_COMMENT_SOURCE_BYTES ||
		Buffer.byteLength(content, "utf8") > MAX_COMMENT_SOURCE_BYTES ||
		(language === "csharp" && (content.includes('"""') || content.includes('\\""'))) ||
		(language === "python" && /(?:f|fr|rf)["']/i.test(content))
	) {
		return null;
	}

	try {
		const root = refractor.highlight(content, language);
		const javascriptFamily = ["javascript", "typescript", "jsx", "tsx"].includes(language);
		const pending: { node: HighlightNode; inComment: boolean; inLiteral: boolean; inJavascript: boolean }[] = [];
		for (let i = root.children.length - 1; i >= 0; i--) {
			const node = root.children[i];
			if (node) pending.push({ node, inComment: false, inLiteral: false, inJavascript: javascriptFamily });
		}

		const ranges: CommentRange[] = [];
		let lineHasUnclassifiedSlash = false;
		let offset = 0;
		while (pending.length > 0) {
			const entry = pending.pop();
			if (!entry) break;
			const { node, inComment, inLiteral, inJavascript } = entry;
			if (node.type === "text") {
				// Do not assume a highlighter preserves source: entity decoding, whitespace
				// normalization, or a future plugin must never silently shift our offsets.
				if (!content.startsWith(node.value, offset)) return null;
				if (inJavascript) {
					// Regex literals cannot cross a source line. Outside tokenizer-recognized
					// literals/comments, a prior slash makes a comment token ambiguous: it
					// could belong to a regex Prism failed to recognize. Do not infer lexical
					// regex/division context ourselves; decline the whole source instead.
					if (inComment && lineHasUnclassifiedSlash) return null;
					const lineBreak = Math.max(
						node.value.lastIndexOf("\n"),
						node.value.lastIndexOf("\r"),
						node.value.lastIndexOf("\u2028"),
						node.value.lastIndexOf("\u2029"),
					);
					if (lineBreak >= 0) lineHasUnclassifiedSlash = false;
					if (!inLiteral && !inComment && node.value.indexOf("/", lineBreak + 1) >= 0) {
						lineHasUnclassifiedSlash = true;
					}
				}
				const end = offset + node.value.length;
				if (inComment && end > offset) {
					const previous = ranges.at(-1);
					if (previous?.to === offset) previous.to = end;
					else ranges.push({ from: offset, to: end });
				}
				offset = end;
			} else if (node.type === "element") {
				const classes = node.properties.className;
				const comment = inComment || (Array.isArray(classes) && classes.includes("comment"));
				const entersJavascript = Array.isArray(classes) && classes.includes("language-javascript");
				const literal =
					!entersJavascript &&
					(inLiteral ||
						(Array.isArray(classes) &&
							["string", "regex", "plain-text", "attr-value"].some((name) => classes.includes(name))));
				for (let i = node.children.length - 1; i >= 0; i--) {
					const child = node.children[i];
					if (child)
						pending.push({
							node: child,
							inComment: comment,
							inLiteral: literal,
							inJavascript: inJavascript || entersJavascript,
						});
				}
			} else {
				return null;
			}
		}
		if (offset !== content.length) return null;

		if (language === "yaml") {
			// YAML plain scalars may contain `#`; it starts a comment only after separation.
			for (const range of ranges) {
				if (range.from > 0 && !/[\t \r\n]/.test(content.charAt(range.from - 1))) return null;
			}
		}
		return ranges;
	} catch {
		// Highlighting failures (including pathological nesting) are unknown, not comment-free.
		return null;
	}
}

/** Overlap against sorted, non-overlapping ranges from getCommentRanges; includes inside zero-width points. */
export function overlapsComment(ranges: readonly CommentRange[], from: number, to: number): boolean {
	if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return false;

	// Find the first range whose end is strictly after the requested start.
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		const range = ranges[middle];
		if (!range) return false;
		if (range.to <= from) low = middle + 1;
		else high = middle;
	}
	const range = ranges[low];
	return range !== undefined && (from === to ? range.from <= from : range.from < to);
}
