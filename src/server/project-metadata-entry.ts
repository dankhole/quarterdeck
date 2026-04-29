import type {
	RuntimeConflictState,
	RuntimeGitSyncSummary,
	RuntimeProjectMetadata,
	RuntimeTaskWorktreeMetadata,
} from "../core";
import type { CachedHomeGitMetadata } from "./project-metadata-home";
import type { TrackedTaskWorktree } from "./project-metadata-paths";
import type { CachedTaskWorktreeMetadata } from "./project-metadata-task-cache";
import type { ProjectMetadataVisibilityReports } from "./project-metadata-visibility";

export interface ProjectMetadataEntry {
	projectPath: string;
	trackedTasks: TrackedTaskWorktree[];
	documentVisibilityByClientId: ProjectMetadataVisibilityReports;
	focusedTaskId: string | null;
	homeGit: CachedHomeGitMetadata;
	taskMetadataByTaskId: Map<string, CachedTaskWorktreeMetadata>;
	pollIntervals: ProjectMetadataPollIntervals;
}

export interface ProjectMetadataPollIntervals {
	focusedTaskPollMs: number;
	backgroundTaskPollMs: number;
	homeRepoPollMs: number;
}

export const PROJECT_METADATA_POLL_INTERVALS: ProjectMetadataPollIntervals = {
	focusedTaskPollMs: 5_000,
	backgroundTaskPollMs: 20_000,
	homeRepoPollMs: 30_000,
};

function areGitSummariesEqual(a: RuntimeGitSyncSummary | null, b: RuntimeGitSyncSummary | null): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.currentBranch === b.currentBranch &&
		a.upstreamBranch === b.upstreamBranch &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.aheadCount === b.aheadCount &&
		a.behindCount === b.behindCount
	);
}

function areConflictStatesEqual(a: RuntimeConflictState | null, b: RuntimeConflictState | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.operation === b.operation &&
		a.sourceBranch === b.sourceBranch &&
		a.currentStep === b.currentStep &&
		a.totalSteps === b.totalSteps &&
		a.conflictedFiles.length === b.conflictedFiles.length &&
		a.conflictedFiles.every((file, i) => file === b.conflictedFiles[i])
	);
}

function areTaskMetadataEqual(a: RuntimeTaskWorktreeMetadata, b: RuntimeTaskWorktreeMetadata): boolean {
	return (
		a.taskId === b.taskId &&
		a.path === b.path &&
		a.exists === b.exists &&
		a.baseRef === b.baseRef &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.hasUnmergedChanges === b.hasUnmergedChanges &&
		a.behindBaseCount === b.behindBaseCount &&
		areConflictStatesEqual(a.conflictState ?? null, b.conflictState ?? null) &&
		a.stateVersion === b.stateVersion
	);
}

export function areProjectMetadataEqual(a: RuntimeProjectMetadata, b: RuntimeProjectMetadata): boolean {
	if (!areGitSummariesEqual(a.homeGitSummary, b.homeGitSummary)) {
		return false;
	}
	if (a.homeGitStateVersion !== b.homeGitStateVersion) {
		return false;
	}
	if (!areConflictStatesEqual(a.homeConflictState ?? null, b.homeConflictState ?? null)) {
		return false;
	}
	if (a.taskWorktrees.length !== b.taskWorktrees.length) {
		return false;
	}
	for (let index = 0; index < a.taskWorktrees.length; index += 1) {
		const left = a.taskWorktrees[index];
		const right = b.taskWorktrees[index];
		if (!left || !right || !areTaskMetadataEqual(left, right)) {
			return false;
		}
	}
	return true;
}

export function createEmptyProjectMetadata(): RuntimeProjectMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		homeConflictState: null,
		homeStashCount: 0,
		taskWorktrees: [],
	};
}

export function createProjectEntry(projectPath: string): ProjectMetadataEntry {
	return {
		projectPath,
		trackedTasks: [],
		documentVisibilityByClientId: new Map(),
		focusedTaskId: null,
		homeGit: {
			summary: null,
			conflictState: null,
			stashCount: 0,
			stateToken: null,
			stateVersion: 0,
		},
		taskMetadataByTaskId: new Map<string, CachedTaskWorktreeMetadata>(),
		pollIntervals: PROJECT_METADATA_POLL_INTERVALS,
	};
}

export function buildProjectMetadataSnapshot(entry: ProjectMetadataEntry): RuntimeProjectMetadata {
	return {
		homeGitSummary: entry.homeGit.summary,
		homeGitStateVersion: entry.homeGit.stateVersion,
		homeConflictState: entry.homeGit.conflictState,
		homeStashCount: entry.homeGit.stashCount,
		taskWorktrees: entry.trackedTasks
			.map((task) => entry.taskMetadataByTaskId.get(task.taskId)?.data ?? null)
			.filter((task): task is RuntimeTaskWorktreeMetadata => task !== null),
	};
}
