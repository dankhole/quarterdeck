import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { csharp } from "@codemirror/legacy-modes/mode/clike";

// Preserve synchronous support for the established editor languages. Metadata and
// all other grammar loaders belong to the maintained catalog, not this map.
const preloaded: Readonly<Record<string, LanguageSupport>> = {
	C: cpp(),
	"C++": cpp(),
	"C#": new LanguageSupport(StreamLanguage.define(csharp)),
	CSS: css(),
	HTML: html(),
	Java: java(),
	JavaScript: javascript(),
	JSON: json(),
	JSX: javascript({ jsx: true }),
	Markdown: markdown(),
	Python: python(),
	Rust: rust(),
	SQL: sql(),
	TSX: javascript({ typescript: true, jsx: true }),
	TypeScript: javascript({ typescript: true }),
};

// A preloaded description must own its loader as well as its support value:
// assigning .support on an upstream description would let .load replace it.
const compatibilityExtensions: Readonly<Record<string, readonly string[]>> = {
	Markdown: ["mdx"],
	Shell: ["zsh"],
};
const descriptions = languages.map((description) => {
	const support = preloaded[description.name];
	const extraExtensions = compatibilityExtensions[description.name];
	if (!support && !extraExtensions) return description;
	return LanguageDescription.of({
		...description,
		extensions: [...description.extensions, ...(extraExtensions ?? [])],
		...(support ? { support } : { load: () => description.load() }),
	});
});
const filenames = descriptions.flatMap((description) =>
	description.filename
		? [
				{
					description,
					pattern: new RegExp(
						description.filename.source,
						`${description.filename.flags.replace(/[gy]/g, "").replace(/i/g, "")}i`,
					),
				},
			]
		: [],
);

/** Resolve exact hints first, then catalog filenames and longest extension suffixes. */
export function resolveSourceLanguage(language: string, path: string): LanguageDescription | null {
	const hint = language.trim().toLowerCase();
	const named = LanguageDescription.matchLanguageName(descriptions, hint === "markup" ? "html" : hint, false);
	if (named) return named;
	const extensionHint =
		hint &&
		descriptions.find((description) => description.extensions.some((extension) => extension.toLowerCase() === hint));
	if (extensionHint) return extensionHint;

	const filename = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
	const special = filenames.find(({ pattern }) => pattern.test(filename));
	if (special) return special.description;
	const lower = filename.toLowerCase();
	// The catalog includes compound extensions (e.g. cmake.in), while the SDK's
	// matchFilename helper currently considers only the final suffix.
	for (let dot = lower.indexOf("."); dot >= 0; dot = lower.indexOf(".", dot + 1)) {
		const suffix = lower.slice(dot + 1);
		const match = descriptions.find((description) =>
			description.extensions.some((extension) => extension.toLowerCase() === suffix),
		);
		if (match) return match;
	}
	return null;
}

/** Read available support without starting a grammar load. */
export function languageExtension(language: string, path: string): LanguageSupport | null {
	return resolveSourceLanguage(language, path)?.support ?? null;
}

/** The SDK owns successful caching, concurrent-load deduplication and failure reset. */
export async function loadSourceLanguage(language: string, path: string): Promise<LanguageSupport | null> {
	return (await resolveSourceLanguage(language, path)?.load()) ?? null;
}
