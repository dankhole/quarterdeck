import Prism from "prismjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createHighlightedLineCache,
	getHighlightedLineHtml,
	MAX_SYNC_HIGHLIGHT_LINE_LENGTH,
	resolvePrismGrammar,
	resolvePrismLanguage,
} from "@/components/shared/syntax-highlighting";

describe("syntax highlighting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("caches Prism output per line", () => {
		const language = resolvePrismLanguage("example.ts");
		const grammar = resolvePrismGrammar(language);
		const highlightSpy = vi.spyOn(Prism, "highlight");
		const cache = createHighlightedLineCache(grammar, language);

		const first = cache.get("const value = 1;");
		const second = cache.get("const value = 1;");

		expect(first).toBe(second);
		expect(first).toContain("token keyword");
		expect(cache.size).toBe(1);
		expect(highlightSpy).toHaveBeenCalledTimes(1);
	});

	it("skips very long lines instead of synchronously tokenizing them", () => {
		const language = resolvePrismLanguage("example.ts");
		const grammar = resolvePrismGrammar(language);
		const highlightSpy = vi.spyOn(Prism, "highlight");
		const longLine = "x".repeat(MAX_SYNC_HIGHLIGHT_LINE_LENGTH + 1);

		expect(getHighlightedLineHtml(longLine, grammar, language)).toBeNull();
		expect(highlightSpy).not.toHaveBeenCalled();
	});
});
