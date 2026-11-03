export interface DiffSymbolRange {
	from: number;
	to: number;
}

// Language-neutral lexical identifiers, not language-server references. Including
// $ and Unicode identifier characters covers Java/JS and non-ASCII source names.
const IDENTIFIER = /(?<![$\p{ID_Continue}]|\u200c|\u200d)[$_\p{ID_Start}](?:[$\p{ID_Continue}]|\u200c|\u200d)*/gu;

export function diffSymbolAtOffset(text: string, offset: number): string | null {
	if (!Number.isInteger(offset) || offset < 0 || offset >= text.length) return null;
	for (const match of text.matchAll(IDENTIFIER)) {
		if (match.index > offset) break;
		if (offset < match.index + match[0].length) return match[0];
	}
	return null;
}

export function diffSymbolRanges(text: string, symbol: string | null): DiffSymbolRange[] {
	if (!symbol) return [];
	const ranges: DiffSymbolRange[] = [];
	for (const match of text.matchAll(IDENTIFIER)) {
		if (match[0] === symbol) ranges.push({ from: match.index, to: match.index + symbol.length });
	}
	return ranges;
}
