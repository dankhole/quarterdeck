import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-c";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-css";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";

const PRISM_LANGUAGE_BY_EXTENSION: Record<string, string> = {
	bash: "bash",
	c: "c",
	cc: "cpp",
	cjs: "javascript",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	cxx: "cpp",
	go: "go",
	h: "c",
	hh: "cpp",
	hpp: "cpp",
	htm: "markup",
	html: "markup",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "jsx",
	md: "markdown",
	mdx: "markdown",
	mjs: "javascript",
	php: "php",
	py: "python",
	rb: "ruby",
	rs: "rust",
	scss: "css",
	sh: "bash",
	sql: "sql",
	svg: "markup",
	swift: "swift",
	ts: "typescript",
	tsx: "tsx",
	xml: "markup",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

export const MAX_SYNC_HIGHLIGHT_LINE_LENGTH = 20_000;

export interface HighlightedLineCache {
	get(line: string): string | null;
	clear: () => void;
	readonly size: number;
}

function getPathBasename(path: string): string {
	const separatorIndex = path.lastIndexOf("/");
	return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

export function resolvePrismLanguageByAlias(alias: string): string | null {
	const lower = alias.toLowerCase();
	if (Prism.languages[lower]) return lower;
	const mapped = PRISM_LANGUAGE_BY_EXTENSION[lower];
	if (mapped && Prism.languages[mapped]) return mapped;
	return null;
}

export function resolvePrismLanguage(path: string): string | null {
	const basename = getPathBasename(path).toLowerCase();
	if (basename === "dockerfile") {
		return "bash";
	}
	const dotIndex = basename.lastIndexOf(".");
	if (dotIndex < 0 || dotIndex === basename.length - 1) {
		return null;
	}
	return resolvePrismLanguageByAlias(basename.slice(dotIndex + 1));
}

export function resolvePrismGrammar(language: string | null): Prism.Grammar | null {
	if (!language) {
		return null;
	}
	return Prism.languages[language] ?? null;
}

export function getHighlightedLineHtml(
	line: string,
	grammar: Prism.Grammar | null,
	language: string | null,
): string | null {
	if (!grammar || !language) {
		return null;
	}
	if (line.length > MAX_SYNC_HIGHLIGHT_LINE_LENGTH) {
		return null;
	}
	return Prism.highlight(line.length > 0 ? line : " ", grammar, language);
}

export function createHighlightedLineCache(
	grammar: Prism.Grammar | null,
	language: string | null,
): HighlightedLineCache {
	const highlightedByLine = new Map<string, string | null>();
	return {
		get(line: string): string | null {
			if (!grammar || !language) {
				return null;
			}
			if (highlightedByLine.has(line)) {
				return highlightedByLine.get(line) ?? null;
			}
			const highlighted = getHighlightedLineHtml(line, grammar, language);
			highlightedByLine.set(line, highlighted);
			return highlighted;
		},
		clear(): void {
			highlightedByLine.clear();
		},
		get size(): number {
			return highlightedByLine.size;
		},
	};
}
