import type { RuntimeProjectAvailability, RuntimeProjectSummary } from "../core";

/** Off-switch for summary reuse; disabled, every project-list build rereads each board. */
export const PROJECT_SUMMARY_CACHE_ENABLED = true;

/** Everything a summary derives from except the board contents, which the revision stands for. */
export interface ProjectSummaryCacheKey {
	repoPath: string;
	boardRevision: number;
	folderOnly?: boolean;
	displayName?: string;
	metadataRevision?: number;
	availability: RuntimeProjectAvailability;
}

function serializeKey(key: ProjectSummaryCacheKey): string {
	return JSON.stringify([
		key.repoPath,
		key.boardRevision,
		key.folderOnly === true,
		key.displayName ?? null,
		key.metadataRevision ?? 0,
		key.availability,
	]);
}

/**
 * Reuses a project's derived summary while its board revision, location,
 * display metadata, and availability are unchanged. Validation still reads the
 * cheap inputs on every build, so a stale entry can never be served.
 */
export class ProjectSummaryCache {
	private readonly entries = new Map<string, { key: string; summary: RuntimeProjectSummary }>();

	constructor(private readonly enabled = PROJECT_SUMMARY_CACHE_ENABLED) {}

	get(projectId: string, key: ProjectSummaryCacheKey): RuntimeProjectSummary | null {
		if (!this.enabled) return null;
		const entry = this.entries.get(projectId);
		return entry && entry.key === serializeKey(key) ? entry.summary : null;
	}

	set(projectId: string, key: ProjectSummaryCacheKey, summary: RuntimeProjectSummary): void {
		if (!this.enabled) return;
		this.entries.set(projectId, { key: serializeKey(key), summary });
	}

	purge(projectId: string): void {
		this.entries.delete(projectId);
	}
}
