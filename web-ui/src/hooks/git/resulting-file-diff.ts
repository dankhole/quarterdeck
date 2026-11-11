import type { UnifiedDiffRow } from "@/components/shared/diff-parser";

export interface ResultingFileChange {
	readonly type: "change";
	readonly key: string;
	readonly kind: "addition" | "modification" | "deletion";
	readonly rows: UnifiedDiffRow[];
	readonly removed: UnifiedDiffRow[];
	readonly current: UnifiedDiffRow[];
}

export type ResultingFileItem =
	| { readonly type: "context"; readonly key: string; readonly row: UnifiedDiffRow }
	| ResultingFileChange;

/** Projects the shared diff engine's rows; line addresses and row identities are never recomputed. */
export function buildResultingFileItems(rows: readonly UnifiedDiffRow[]): ResultingFileItem[] {
	const items: ResultingFileItem[] = [];
	let index = 0;
	while (index < rows.length) {
		const row = rows[index]!;
		if (row.variant === "context") {
			items.push({ type: "context", key: row.key, row });
			index += 1;
			continue;
		}
		const start = index;
		while (index < rows.length && rows[index]!.variant !== "context") index += 1;
		const changed = rows.slice(start, index);
		const removed = changed.filter((line) => line.variant === "removed");
		const current = changed.filter((line) => line.variant !== "removed");
		items.push({
			type: "change",
			key: `change-${row.key}`,
			kind: removed.length === 0 ? "addition" : current.length === 0 ? "deletion" : "modification",
			rows: changed,
			removed,
			current,
		});
	}
	return items;
}
