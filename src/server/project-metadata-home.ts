import type { RuntimeConflictState, RuntimeGitSyncSummary } from "../core";
import { invalidateGitRepositoryInfoCache } from "../state/project-state-utils";
import { getGitSyncSummary, probeGitWorkdirState, stashCount } from "../workdir";
import { loadConflictState } from "./project-metadata-path-loader";

export interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	conflictState: RuntimeConflictState | null;
	stashCount: number;
	stateToken: string | null;
	stateVersion: number;
}

export async function loadHomeGitMetadata(
	projectPath: string,
	currentHomeGit: CachedHomeGitMetadata,
): Promise<CachedHomeGitMetadata> {
	try {
		const [probe, currentStashCount] = await Promise.all([
			probeGitWorkdirState(projectPath),
			stashCount(projectPath),
		]);
		// Metadata polling is the current safety net for out-of-band branch
		// changes. If repository-info cache ownership moves closer to metadata
		// polling, fold this into that shared owner instead of leaving it implicit.
		invalidateGitRepositoryInfoCache(projectPath);
		const stashCountChanged = currentStashCount !== currentHomeGit.stashCount;
		if (currentHomeGit.stateToken === probe.stateToken) {
			if (stashCountChanged) {
				return {
					...currentHomeGit,
					stashCount: currentStashCount,
					stateVersion: Date.now(),
				};
			}
			return currentHomeGit;
		}
		const [summary, conflictState] = await Promise.all([
			getGitSyncSummary(projectPath, { probe }),
			loadConflictState(projectPath),
		]);
		return {
			summary,
			conflictState,
			stashCount: currentStashCount,
			stateToken: probe.stateToken,
			stateVersion: Date.now(),
		};
	} catch {
		return currentHomeGit;
	}
}
