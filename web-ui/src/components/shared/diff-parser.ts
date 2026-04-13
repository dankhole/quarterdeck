import { diffLines, diffWordsWithSpace } from "diff";

export const CONTEXT_RADIUS = 3;
export const MIN_COLLAPSE_LINES = 8;
export const INCREMENTAL_EXPAND_STEP = 20;
export const INCREMENTAL_EXPAND_THRESHOLD = 40;

export interface InlineDiffSegment {
	key: string;
	text: string;
	tone: "added" | "removed" | "context";
}

export interface UnifiedDiffRow {
	key: string;
	lineNumber: number | null;
	variant: "context" | "added" | "removed";
	text: string;
	segments?: InlineDiffSegment[];
}

export interface CollapsedContextBlock {
	id: string;
	count: number;
	rows: UnifiedDiffRow[];
	expanded: boolean;
}

export type ExpandedBlockState = Record<string, boolean | { top: number; bottom: number }>;

export type DiffDisplayItem =
	| { type: "row"; row: UnifiedDiffRow }
	| { type: "collapsed"; block: CollapsedContextBlock };

function toLines(text: string): string[] {
	const rawLines = text.split("\n");
	return text.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
}

function buildModifiedSegments(
	oldText: string,
	newText: string,
): {
	oldSegments: InlineDiffSegment[];
	newSegments: InlineDiffSegment[];
} {
	const oldSegments: InlineDiffSegment[] = [];
	const newSegments: InlineDiffSegment[] = [];
	const parts = diffWordsWithSpace(oldText, newText);

	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (!part) {
			continue;
		}
		if (part.removed) {
			oldSegments.push({ key: `o-${index}`, text: part.value, tone: "removed" });
			continue;
		}
		if (part.added) {
			newSegments.push({ key: `n-${index}`, text: part.value, tone: "added" });
			continue;
		}
		oldSegments.push({ key: `oc-${index}`, text: part.value, tone: "context" });
		newSegments.push({ key: `nc-${index}`, text: part.value, tone: "context" });
	}
	return { oldSegments, newSegments };
}

export function buildUnifiedDiffRows(oldText: string | null | undefined, newText: string): UnifiedDiffRow[] {
	const rows: UnifiedDiffRow[] = [];
	let oldLine = 1;
	let newLine = 1;
	const changes = diffLines(oldText ?? "", newText, {
		ignoreWhitespace: false,
		stripTrailingCr: true,
		ignoreNewlineAtEof: true,
	});

	for (let index = 0; index < changes.length; index += 1) {
		const change = changes[index];
		const nextChange = changes[index + 1];
		if (!change) {
			continue;
		}

		if (change.removed && nextChange?.added) {
			const removedLines = toLines(change.value);
			const addedLines = toLines(nextChange.value);
			const pairCount = Math.max(removedLines.length, addedLines.length);

			const removedRows: UnifiedDiffRow[] = [];
			const addedRows: UnifiedDiffRow[] = [];
			let localOldLine = oldLine;
			let localNewLine = newLine;

			for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
				const removedLine = removedLines[pairIndex];
				const addedLine = addedLines[pairIndex];

				if (removedLine != null && addedLine != null) {
					const { oldSegments, newSegments } = buildModifiedSegments(removedLine, addedLine);
					removedRows.push({
						key: `m-old-${localOldLine}-${localNewLine}`,
						lineNumber: localOldLine,
						variant: "removed",
						text: removedLine,
						segments: oldSegments,
					});
					addedRows.push({
						key: `m-new-${localOldLine}-${localNewLine}`,
						lineNumber: localNewLine,
						variant: "added",
						text: addedLine,
						segments: newSegments,
					});
					localOldLine += 1;
					localNewLine += 1;
				} else if (removedLine != null) {
					removedRows.push({
						key: `o-${localOldLine}`,
						lineNumber: localOldLine,
						variant: "removed",
						text: removedLine,
					});
					localOldLine += 1;
				} else if (addedLine != null) {
					addedRows.push({
						key: `n-${localNewLine}`,
						lineNumber: localNewLine,
						variant: "added",
						text: addedLine,
					});
					localNewLine += 1;
				}
			}

			rows.push(...removedRows, ...addedRows);
			oldLine = localOldLine;
			newLine = localNewLine;
			index += 1;
			continue;
		}

		const lines = toLines(change.value);
		for (const line of lines) {
			if (change.added) {
				rows.push({ key: `n-${newLine}`, lineNumber: newLine, variant: "added", text: line });
				newLine += 1;
				continue;
			}
			if (change.removed) {
				rows.push({ key: `o-${oldLine}`, lineNumber: oldLine, variant: "removed", text: line });
				oldLine += 1;
				continue;
			}
			rows.push({ key: `c-${oldLine}-${newLine}`, lineNumber: newLine, variant: "context", text: line });
			oldLine += 1;
			newLine += 1;
		}
	}
	return rows;
}

export function parsePatchToRows(patch: string): UnifiedDiffRow[] {
	if (!patch) {
		return [];
	}
	const rawLines = patch.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
		rawLines.pop();
	}
	const rows: UnifiedDiffRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;

	for (const raw of rawLines) {
		if (raw.startsWith("@@")) {
			inHunk = true;
			const match = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match) {
				oldLine = Number.parseInt(match[1] ?? "0", 10);
				newLine = Number.parseInt(match[2] ?? "0", 10);
			}
			continue;
		}
		if (!inHunk) {
			continue;
		}
		if (raw.startsWith("+")) {
			rows.push({ key: `n-${newLine}`, lineNumber: newLine, variant: "added", text: raw.slice(1) });
			newLine++;
		} else if (raw.startsWith("-")) {
			rows.push({ key: `o-${oldLine}`, lineNumber: oldLine, variant: "removed", text: raw.slice(1) });
			oldLine++;
		} else if (raw.startsWith(" ")) {
			rows.push({ key: `c-${oldLine}-${newLine}`, lineNumber: newLine, variant: "context", text: raw.slice(1) });
			oldLine++;
			newLine++;
		}
	}
	return enrichRowsWithInlineSegments(rows);
}

/**
 * Post-process rows to add word-level inline diff segments for adjacent
 * removed/added blocks (e.g. rows parsed from a git patch which lack them).
 */
function enrichRowsWithInlineSegments(rows: UnifiedDiffRow[]): UnifiedDiffRow[] {
	const result: UnifiedDiffRow[] = [];
	let index = 0;

	while (index < rows.length) {
		const row = rows[index]!;
		if (row.variant !== "removed") {
			result.push(row);
			index += 1;
			continue;
		}

		// Collect contiguous removed rows
		const removedStart = index;
		while (index < rows.length && rows[index]!.variant === "removed") {
			index += 1;
		}
		const removedBlock = rows.slice(removedStart, index);

		// Collect contiguous added rows immediately following
		const addedStart = index;
		while (index < rows.length && rows[index]!.variant === "added") {
			index += 1;
		}
		const addedBlock = rows.slice(addedStart, index);

		if (addedBlock.length === 0) {
			// Pure deletion — no pairing possible
			result.push(...removedBlock);
			continue;
		}

		// Pair positionally and compute inline segments
		const pairCount = Math.min(removedBlock.length, addedBlock.length);
		for (let pi = 0; pi < pairCount; pi += 1) {
			const removedRow = removedBlock[pi]!;
			const addedRow = addedBlock[pi]!;
			if (!removedRow.segments && !addedRow.segments) {
				const { oldSegments, newSegments } = buildModifiedSegments(removedRow.text, addedRow.text);
				removedBlock[pi] = { ...removedRow, segments: oldSegments };
				addedBlock[pi] = { ...addedRow, segments: newSegments };
			}
		}

		result.push(...removedBlock, ...addedBlock);
	}

	return result;
}

export function buildDisplayItems(rows: UnifiedDiffRow[], expandedBlocks: ExpandedBlockState): DiffDisplayItem[] {
	const changedIndices: number[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index]?.variant !== "context") {
			changedIndices.push(index);
		}
	}

	const nearbyContext = new Set<number>();
	for (const changedIndex of changedIndices) {
		const start = Math.max(0, changedIndex - CONTEXT_RADIUS);
		const end = Math.min(rows.length - 1, changedIndex + CONTEXT_RADIUS);
		for (let index = start; index <= end; index += 1) {
			nearbyContext.add(index);
		}
	}

	const shouldHideContextAt = (index: number): boolean => {
		const row = rows[index];
		if (!row || row.variant !== "context") {
			return false;
		}
		if (changedIndices.length === 0) {
			return rows.length >= MIN_COLLAPSE_LINES;
		}
		return !nearbyContext.has(index);
	};

	const items: DiffDisplayItem[] = [];
	let index = 0;
	while (index < rows.length) {
		if (!shouldHideContextAt(index)) {
			const row = rows[index];
			if (row) {
				items.push({ type: "row", row });
			}
			index += 1;
			continue;
		}

		const start = index;
		while (index < rows.length && shouldHideContextAt(index)) {
			index += 1;
		}
		const blockRows = rows.slice(start, index);
		if (blockRows.length < MIN_COLLAPSE_LINES) {
			for (const row of blockRows) {
				items.push({ type: "row", row });
			}
			continue;
		}

		const blockId = `ctx-${start}-${index - 1}`;
		const blockState = expandedBlocks[blockId];

		if (blockState === true) {
			// Fully expanded (legacy boolean toggle)
			items.push({
				type: "collapsed",
				block: { id: blockId, count: blockRows.length, rows: blockRows, expanded: true },
			});
			continue;
		}

		if (typeof blockState === "object" && blockState !== null) {
			const topReveal = Math.min(blockState.top, blockRows.length);
			const bottomReveal = Math.min(blockState.bottom, blockRows.length - topReveal);

			// Rows revealed from the top
			for (let ri = 0; ri < topReveal; ri += 1) {
				const row = blockRows[ri];
				if (row) {
					items.push({ type: "row", row });
				}
			}

			// Remaining collapsed middle
			const remainingStart = topReveal;
			const remainingEnd = blockRows.length - bottomReveal;
			if (remainingEnd > remainingStart) {
				const remainingRows = blockRows.slice(remainingStart, remainingEnd);
				items.push({
					type: "collapsed",
					block: { id: blockId, count: remainingRows.length, rows: remainingRows, expanded: false },
				});
			}

			// Rows revealed from the bottom
			for (let ri = blockRows.length - bottomReveal; ri < blockRows.length; ri += 1) {
				const row = blockRows[ri];
				if (row) {
					items.push({ type: "row", row });
				}
			}
			continue;
		}

		// Not expanded at all
		items.push({
			type: "collapsed",
			block: { id: blockId, count: blockRows.length, rows: blockRows, expanded: false },
		});
	}
	return items;
}

export function truncatePathMiddle(path: string, maxLength = 64): string {
	if (path.length <= maxLength) {
		return path;
	}
	const separator = "...";
	const keep = Math.max(8, maxLength - separator.length);
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${path.slice(0, head)}${separator}${path.slice(path.length - tail)}`;
}
