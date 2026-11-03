import {
	createContext,
	type MouseEvent,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { diffPointerTextOffset } from "@/hooks/git/diff-code-navigation";
import { type DiffSymbolRange, diffSymbolAtOffset, diffSymbolRanges } from "@/hooks/git/diff-symbol";

interface DiffSymbolSelection {
	symbol: string | null;
	line: HTMLElement;
}

const DiffSymbolContext = createContext<DiffSymbolSelection | null>(null);

/** Test a glyph's bounds, not just the nearest caret: clicks beyond EOL or in
 * whitespace must not select the identifier immediately before that caret. */
function characterAtPoint(element: HTMLElement, offset: number, x: number, y: number): number | null {
	const document = element.ownerDocument;
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let start = 0;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const length = node.textContent?.length ?? 0;
		if (offset >= start && offset < start + length) {
			const range = document.createRange();
			range.setStart(node, offset - start);
			range.setEnd(node, Math.min(offset - start + 1, length));
			return [...range.getClientRects()].some(
				(rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom,
			)
				? offset
				: null;
		}
		start += length;
	}
	return null;
}

function clickedSymbol(element: HTMLElement, event: MouseEvent): string | null {
	const offset = diffPointerTextOffset(element, event.clientX, event.clientY);
	if (offset === null) return null;
	for (const candidate of [offset, offset - 1]) {
		const hit = characterAtPoint(element, candidate, event.clientX, event.clientY);
		if (hit !== null) return diffSymbolAtOffset(element.textContent ?? "", hit);
	}
	return null;
}

/** One lexical selection shared by the visible old/new rows in one diff. */
export function DiffSymbolScope({
	children,
	className,
	identity,
	path,
}: {
	children: ReactNode;
	className?: string;
	identity: object;
	path: string;
}): React.ReactElement {
	const [selection, setSelection] = useState<DiffSymbolSelection | null>(null);
	const pointerStart = useRef<{ x: number; y: number } | null>(null);
	const scopeRef = useRef<HTMLDivElement>(null);

	useEffect(() => setSelection(null), [identity, path]);
	useEffect(() => {
		const scope = scopeRef.current;
		if (!selection || !scope) return;
		// The navigation menu can own focus just outside this scope, but still
		// inside this one review document. Never dismiss another file's highlight.
		const keyboardRegion = scope.closest("[data-review-document]") ?? scope;
		const clear = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.isComposing ||
				!(event.target instanceof Node) ||
				!keyboardRegion.contains(event.target)
			)
				return;
			// Document bubbling precedes the app's window Escape listener, even
			// when that listener was registered first. Only an actual dismissal
			// consumes the gesture; a subsequent Escape retains normal behavior.
			event.preventDefault();
			event.stopPropagation();
			setSelection(null);
		};
		scope.ownerDocument.addEventListener("keydown", clear);
		return () => scope.ownerDocument.removeEventListener("keydown", clear);
	}, [selection]);

	const handleClick = (event: MouseEvent<HTMLDivElement>) => {
		const start = pointerStart.current;
		pointerStart.current = null;
		const target = event.target instanceof Element ? event.target : null;
		if (!target || target.closest("button, a, input, textarea, [role=button], .kb-diff-line-number")) return;
		const row = target.closest(".kb-diff-row");
		if (!row) return;
		// Keep native selection and dragging untouched, including the click
		// browsers may dispatch after a drag. Code navigation also uses the
		// bubbling click, so this decoration never consumes the gesture.
		if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (
			(start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) ||
			!event.currentTarget.ownerDocument.getSelection()?.isCollapsed ||
			event.detail > 1
		)
			return;
		const line = row.querySelector<HTMLElement>(".kb-diff-text");
		if (!line) return;
		const symbol = line.contains(target) ? clickedSymbol(line, event) : null;
		if (symbol) {
			const scope = event.currentTarget;
			const keyboardRegion = scope.closest("[data-review-document]") ?? scope;
			// Standalone/patch diffs otherwise have no keyboard focus target.
			// Preserve the enclosing code-navigation menu's existing focus owner.
			if (!keyboardRegion.contains(scope.ownerDocument.activeElement)) scope.focus({ preventScroll: true });
		}
		setSelection(symbol ? { symbol, line } : null);
	};

	return (
		<DiffSymbolContext.Provider value={selection}>
			<div
				ref={scopeRef}
				tabIndex={-1}
				className={className}
				onPointerDownCapture={(event) => {
					pointerStart.current = { x: event.clientX, y: event.clientY };
				}}
				onClickCapture={handleClick}
			>
				{children}
			</div>
		</DiffSymbolContext.Provider>
	);
}

/** Add occurrence spans inside syntax spans without re-tokenizing source or
 * splitting an identifier at an intraline/syntax boundary. HTML is exclusively
 * the existing escaped syntax renderer output, never unescaped source text. */
export function decorateDiffSymbolHtml(html: string, ranges: readonly DiffSymbolRange[]): string {
	if (ranges.length === 0) return html;
	const template = document.createElement("template");
	template.innerHTML = html;
	const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
	const nodes: Node[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
	let start = 0;
	let rangeIndex = 0;
	for (const node of nodes) {
		const text = node.textContent ?? "";
		const end = start + text.length;
		while (rangeIndex < ranges.length && ranges[rangeIndex]!.to <= start) rangeIndex += 1;
		if (rangeIndex < ranges.length && ranges[rangeIndex]!.from < end) {
			const fragment = document.createDocumentFragment();
			let offset = 0;
			for (let index = rangeIndex; index < ranges.length && ranges[index]!.from < end; index += 1) {
				const range = ranges[index]!;
				const from = Math.max(0, range.from - start);
				const to = Math.min(text.length, range.to - start);
				fragment.append(text.slice(offset, from));
				const mark = document.createElement("span");
				mark.className = "kb-diff-symbol-occurrence";
				mark.textContent = text.slice(from, to);
				fragment.append(mark);
				offset = to;
			}
			fragment.append(text.slice(offset));
			node.parentNode?.replaceChild(fragment, node);
		}
		start = end;
	}
	return template.innerHTML;
}

export function useDiffSymbolText(text: string, html: string) {
	const selection = useContext(DiffSymbolContext);
	const ref = useRef<HTMLSpanElement>(null);
	const symbol = selection?.symbol ?? null;
	const decoratedHtml = useMemo(
		() => decorateDiffSymbolHtml(html, diffSymbolRanges(text, symbol)),
		[html, text, symbol],
	);
	return { ref, html: decoratedHtml, active: selection?.line === ref.current && selection !== null };
}
