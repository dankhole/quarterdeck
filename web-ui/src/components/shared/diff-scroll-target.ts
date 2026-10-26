import { createContext, type RefObject } from "react";
import type { UnifiedDiffRow } from "./diff-parser";

export interface DiffScrollLine {
	path: string;
	side: "current" | "removed";
	lineNumber: number;
}

export function getDiffScrollLines(path: string, row: UnifiedDiffRow): DiffScrollLine[] {
	return row.lineNumber === null
		? []
		: [
				{
					path,
					side: row.variant === "removed" ? "removed" : "current",
					lineNumber: row.lineNumber,
				},
			];
}

/** A commit-phase hint: deferred chunks reveal the relocated line before paint. */
export const DiffScrollTargetContext = createContext<RefObject<DiffScrollLine | null>>({ current: null });
