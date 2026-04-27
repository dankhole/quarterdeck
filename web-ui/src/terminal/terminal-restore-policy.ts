export function shouldSkipEmptyRestoreSnapshot(snapshot: string, currentLines: readonly string[]): boolean {
	return snapshot.length === 0 && currentLines.some((line) => line.trim().length > 0);
}
