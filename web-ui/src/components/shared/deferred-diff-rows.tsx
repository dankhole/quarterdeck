import { useEffect, useMemo, useRef, useState } from "react";

export const DEFERRED_ROW_THRESHOLD = 200;
const ROWS_PER_CHUNK = 80;
const ESTIMATED_ROW_HEIGHT = 21.2;

/** Keep small diffs immediate; reveal large groups near the viewport. */
export function DeferredDiffRows<T>({
	rows,
	getRowKey,
	renderRow,
}: {
	rows: readonly T[];
	getRowKey: (row: T) => string;
	renderRow: (row: T) => React.ReactElement;
}): React.ReactElement {
	const chunks = useMemo(() => {
		const result: T[][] = [];
		for (let start = 0; start < rows.length; start += ROWS_PER_CHUNK) {
			result.push(rows.slice(start, start + ROWS_PER_CHUNK));
		}
		return result;
	}, [rows]);

	return (
		<>
			{chunks.map((chunk) => (
				<DeferredDiffChunk
					key={getRowKey(chunk[0]!)}
					rows={chunk}
					renderRow={renderRow}
					defer={rows.length > DEFERRED_ROW_THRESHOLD}
				/>
			))}
		</>
	);
}

export function DeferredDiffChunk<T>({
	rows,
	renderRow,
	defer,
}: {
	rows: readonly T[];
	renderRow: (row: T) => React.ReactElement;
	defer: boolean;
}): React.ReactElement {
	const elementRef = useRef<HTMLDivElement>(null);
	const [revealed, setRevealed] = useState(() => !defer || typeof IntersectionObserver === "undefined");
	const visible = revealed || !defer;

	useEffect(() => {
		if (!defer) {
			setRevealed(true);
			return;
		}
		const element = elementRef.current;
		if (revealed || !element) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setRevealed(true);
				observer.disconnect();
			},
			{ root: element.closest("[data-diff-scroll-container]"), rootMargin: "600px 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [defer, revealed]);

	// Keep revealed rows mounted: browser selection, comment focus, and wrapped
	// line heights remain stable when scrolling back through an inspected diff.
	return (
		<div ref={elementRef} style={visible ? undefined : { height: rows.length * ESTIMATED_ROW_HEIGHT }}>
			{visible ? rows.map(renderRow) : null}
		</div>
	);
}
