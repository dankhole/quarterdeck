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
 * cheap inputs on every build, so `get` never serves a stale entry. `getLast`
 * is the explicit stale fallback for a time-boxed build.
 */
export class ProjectSummaryCache {
	private readonly entries = new Map<string, { key: string; repoPath: string; summary: RuntimeProjectSummary }>();
	private readonly epochs = new Map<string, number>();

	constructor(private readonly enabled = PROJECT_SUMMARY_CACHE_ENABLED) {}

	get(projectId: string, key: ProjectSummaryCacheKey): RuntimeProjectSummary | null {
		if (!this.enabled) return null;
		const entry = this.entries.get(projectId);
		return entry && entry.key === serializeKey(key) ? entry.summary : null;
	}

	/** The last summary built for this location, whatever its inputs; never one from before a purge. */
	getLast(projectId: string, repoPath: string): RuntimeProjectSummary | null {
		if (!this.enabled) return null;
		const entry = this.entries.get(projectId);
		return entry && entry.repoPath === repoPath ? entry.summary : null;
	}

	/** Capture before reading summary inputs; `set` drops a build that a purge overtook. */
	epoch(projectId: string): number {
		return this.epochs.get(projectId) ?? 0;
	}

	set(projectId: string, key: ProjectSummaryCacheKey, summary: RuntimeProjectSummary, epoch: number): void {
		if (!this.enabled || epoch !== this.epoch(projectId)) return;
		this.entries.set(projectId, { key: serializeKey(key), repoPath: key.repoPath, summary });
	}

	purge(projectId: string): void {
		this.entries.delete(projectId);
		this.epochs.set(projectId, this.epoch(projectId) + 1);
	}
}
