import type { UnifiedDiffRow } from "@/components/shared/diff-parser";
import { createFileBrowserContentScopeKey } from "./file-browser-scope";
import type { ReviewScope } from "./review-document";

export interface ReviewHunk {
	/** Content identity excludes line numbers so insertions above do not retarget review. */
	readonly signature: string;
	readonly rows: readonly UnifiedDiffRow[];
	readonly anchor: { side: "current" | "removed"; lineNumber: number };
}

/** A difference is a contiguous edit, including both sides of a replacement. */
export function buildReviewHunks(rows: readonly UnifiedDiffRow[]): ReviewHunk[] {
	const hunks: ReviewHunk[] = [];
	let changed: UnifiedDiffRow[] = [];
	const flush = () => {
		const first = changed.find((row) => row.lineNumber !== null);
		if (first?.lineNumber != null) {
			hunks.push({
				signature: JSON.stringify(changed.map((row) => [row.variant, row.text])),
				rows: changed,
				anchor: { side: first.variant === "removed" ? "removed" : "current", lineNumber: first.lineNumber },
			});
		}
		changed = [];
	};
	for (const row of rows) {
		if (row.variant === "context") flush();
		else changed.push(row);
	}
	flush();
	return hunks;
}

export function focusedReviewScopeKey(scope: ReviewScope): string {
	const { kind, base, head, headSource, mode } = scope.revisions;
	// A refresh version is not a different comparison.
	return JSON.stringify([
		createFileBrowserContentScopeKey(scope.repository),
		kind,
		base,
		head,
		headSource ?? "revision",
		mode,
	]);
}

export function resolveReviewPath(
	paths: readonly string[],
	selectedPath: string | null,
	previousIndex: number,
): string | null {
	if (selectedPath !== null && paths.includes(selectedPath)) return selectedPath;
	return paths[Math.min(Math.max(previousIndex, 0), paths.length - 1)] ?? null;
}

export function reconcileReviewHunk(hunks: readonly ReviewHunk[], index: number, signature?: string): number {
	if (hunks.length === 0) return -1;
	const matches = hunks.flatMap((hunk, candidate) => (hunk.signature === signature ? [candidate] : []));
	if (matches.length > 0)
		return matches.reduce((best, candidate) =>
			Math.abs(candidate - index) < Math.abs(best - index) ? candidate : best,
		);
	return Math.min(Math.max(index, 0), hunks.length - 1);
}
