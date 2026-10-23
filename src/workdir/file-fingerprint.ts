import { stat } from "node:fs/promises";
import { join } from "node:path";

import { limitBulkFsCall } from "../fs/bulk-fs-limit";

export interface FileFingerprint {
	path: string;
	size: number | null;
	mtimeMs: number | null;
	ctimeMs: number | null;
}

export async function buildFileFingerprints(repoRoot: string, paths: string[]): Promise<FileFingerprint[]> {
	if (paths.length === 0) {
		return [];
	}
	const uniqueSortedPaths = Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right));
	return await Promise.all(
		uniqueSortedPaths.map(async (path) => {
			try {
				// Only the stat call itself holds a limiter slot; the fan-out above stays unbounded.
				const fileStat = await limitBulkFsCall(() => stat(join(repoRoot, path)));
				return {
					path,
					size: fileStat.size,
					mtimeMs: fileStat.mtimeMs,
					ctimeMs: fileStat.ctimeMs,
				} satisfies FileFingerprint;
			} catch {
				return {
					path,
					size: null,
					mtimeMs: null,
					ctimeMs: null,
				} satisfies FileFingerprint;
			}
		}),
	);
}
