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

function getPathBasename(path: string): string {
	const separatorIndex = path.lastIndexOf("/");
	return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
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
	const extension = basename.slice(dotIndex + 1);
	const language = PRISM_LANGUAGE_BY_EXTENSION[extension];
	if (!language) {
		return null;
	}
	return Prism.languages[language] ? language : null;
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
	return Prism.highlight(line.length > 0 ? line : " ", grammar, language);
}

function toLines(text: string): string[] {
	const rawLines = text.split("\n");
	return text.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
}

export function buildHighlightedLineMap(
	text: string | null | undefined,
	grammar: Prism.Grammar | null,
	language: string | null,
): Map<number, string> {
	const lines = toLines(text ?? "");
	const highlightedByLine = new Map<number, string>();
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const highlighted = getHighlightedLineHtml(line, grammar, language);
		if (highlighted != null) {
			highlightedByLine.set(index + 1, highlighted);
		}
	}
	return highlightedByLine;
}
