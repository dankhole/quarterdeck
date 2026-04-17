import { stat } from "node:fs/promises";
import { join } from "node:path";

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
				const fileStat = await stat(join(repoRoot, path));
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
