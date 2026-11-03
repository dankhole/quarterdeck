// @vitest-environment node
import { describe, expect, it } from "vitest";
import { diffSymbolAtOffset, diffSymbolRanges } from "./diff-symbol";

describe("lexical diff symbols", () => {
	it("matches complete case-sensitive identifiers, not substrings", () => {
		const text = "market markets supermarket Market market_id $market market";
		expect(diffSymbolRanges(text, "market")).toEqual([
			{ from: 0, to: 6 },
			{ from: 52, to: 58 },
		]);
		expect(diffSymbolAtOffset(text, 3)).toBe("market");
		expect(diffSymbolAtOffset(text, 6)).toBeNull();
		expect(diffSymbolRanges(text, null)).toEqual([]);
	});

	it("supports Unicode, $, underscores, and UTF-16 offsets", () => {
		const text = "😀 marché $price _value 123value";
		expect(diffSymbolAtOffset(text, 3)).toBe("marché");
		expect(diffSymbolAtOffset(text, 11)).toBe("$price");
		expect(diffSymbolAtOffset(text, 18)).toBe("_value");
		expect(diffSymbolAtOffset(text, 29)).toBeNull();
		expect(diffSymbolRanges(text, "marché")).toEqual([{ from: 3, to: 9 }]);
	});

	it("rejects whitespace, punctuation, numbers, and invalid offsets", () => {
		for (const offset of [-1, 1.5, 6, 7, 8, 10, 100]) {
			expect(diffSymbolAtOffset("market () 1", offset)).toBeNull();
		}
	});
});
