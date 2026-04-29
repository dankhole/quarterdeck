import type {
	RuntimeBoardData,
	RuntimeConflictState,
	RuntimeGitSyncSummary,
	RuntimeProjectMetadata,
	RuntimeTaskWorktreeMetadata,
} from "../core";
import { invalidateGitRepositoryInfoCache } from "../state/project-state-utils";
import {
	computeAutoMergedFiles,
	detectActiveConflict,
	getCommitsBehindBase,
	getConflictedFiles,
	getGitSyncSummary,
	getTaskWorktreePath,
	getTaskWorktreePathInfo,
	pathExists,
	probeGitWorkdirState,
	runGit,
	stashCount,
} from "../workdir";

export interface TrackedTaskWorktree {
	taskId: string;
	baseRef: string;
	workingDirectory: string | null;
	useWorktree?: boolean;
}

export interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	conflictState: RuntimeConflictState | null;
	stashCount: number;
	stateToken: string | null;
	stateVersion: number;
}

export interface CachedTaskWorktreeMetadata {
	data: RuntimeTaskWorktreeMetadata;
	stateToken: string | null;
	baseRefCommit: string | null;
	originBaseRefCommit: string | null;
	lastKnownBranch: string | null;
}

export interface ProjectMetadataEntry {
	projectPath: string;
	trackedTasks: TrackedTaskWorktree[];
	subscriberCount: number;
	focusedTaskId: string | null;
	isDocumentVisible: boolean;
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

export function collectTrackedTasks(board: RuntimeBoardData): TrackedTaskWorktree[] {
	const tracked: TrackedTaskWorktree[] = [];
	for (const column of board.columns) {
		// Backlog and trash cards do not need git metadata polling. Tracking only
		// active columns avoids unnecessary work, and trash paths are reconstructed
		// from task id on the web-ui side.
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			tracked.push({
				taskId: card.id,
				baseRef: card.baseRef,
				workingDirectory: card.workingDirectory ?? null,
				useWorktree: card.useWorktree,
			});
		}
	}
	return tracked;
}

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

async function loadConflictState(cwd: string): Promise<RuntimeConflictState | null> {
	const detected = await detectActiveConflict(cwd);
	if (!detected) {
		return null;
	}
	const conflictedFiles = await getConflictedFiles(cwd);
	const autoMergedFiles = await computeAutoMergedFiles(cwd, conflictedFiles);
	return {
		operation: detected.operation,
		sourceBranch: detected.sourceBranch,
		currentStep: detected.currentStep,
		totalSteps: detected.totalSteps,
		conflictedFiles,
		autoMergedFiles,
	};
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
		subscriberCount: 0,
		focusedTaskId: null,
		isDocumentVisible: true,
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

async function resolveTaskPath(
	projectPath: string,
	task: TrackedTaskWorktree,
): Promise<{ path: string; exists: boolean; baseRef: string }> {
	if (task.useWorktree === false) {
		return { path: projectPath, exists: await pathExists(projectPath), baseRef: task.baseRef };
	}
	// Use the card's workingDirectory if available (set at session start).
	if (task.workingDirectory) {
		const exists = await pathExists(task.workingDirectory);
		return { path: task.workingDirectory, exists, baseRef: task.baseRef };
	}
	if (!task.baseRef.trim()) {
		const worktreePath = getTaskWorktreePath(projectPath, task.taskId);
		return { path: worktreePath, exists: await pathExists(worktreePath), baseRef: "" };
	}
	// Fallback for tasks started before workingDirectory was persisted.
	return await getTaskWorktreePathInfo({
		cwd: projectPath,
		taskId: task.taskId,
		baseRef: task.baseRef,
	});
}

export async function loadTaskWorktreeMetadata(
	projectPath: string,
	task: TrackedTaskWorktree,
	current: CachedTaskWorktreeMetadata | null,
): Promise<CachedTaskWorktreeMetadata | null> {
	const pathInfo = await resolveTaskPath(projectPath, task);

	if (!pathInfo.exists) {
		if (
			current &&
			current.data.exists === false &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: false,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				hasUnmergedChanges: null,
				behindBaseCount: null,
				conflictState: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
			baseRefCommit: null,
			originBaseRefCommit: null,
			lastKnownBranch: null,
		};
	}

	try {
		const probe = await probeGitWorkdirState(pathInfo.path);
		if (!pathInfo.baseRef.trim()) {
			if (
				current &&
				current.stateToken === probe.stateToken &&
				current.baseRefCommit === null &&
				current.originBaseRefCommit === null &&
				current.data.path === pathInfo.path &&
				current.data.baseRef === ""
			) {
				return current;
			}
			const [gitSummary, conflictState] = await Promise.all([
				getGitSyncSummary(pathInfo.path, { probe }),
				loadConflictState(pathInfo.path),
			]);
			return {
				data: {
					taskId: task.taskId,
					path: pathInfo.path,
					exists: true,
					baseRef: "",
					branch: probe.currentBranch,
					isDetached: probe.headCommit !== null && probe.currentBranch === null,
					headCommit: probe.headCommit,
					changedFiles: gitSummary.changedFiles,
					additions: gitSummary.additions,
					deletions: gitSummary.deletions,
					hasUnmergedChanges: null,
					behindBaseCount: null,
					conflictState,
					stateVersion: Date.now(),
				},
				stateToken: probe.stateToken,
				baseRefCommit: null,
				originBaseRefCommit: null,
				lastKnownBranch: probe.currentBranch,
			};
		}

		const originRef = `origin/${pathInfo.baseRef}`;
		const [baseRefResult, originBaseRefResult] = await Promise.all([
			runGit(pathInfo.path, ["--no-optional-locks", "rev-parse", "--verify", pathInfo.baseRef], {
				timeoutClass: "metadata",
			}),
			runGit(pathInfo.path, ["--no-optional-locks", "rev-parse", "--verify", originRef], {
				timeoutClass: "metadata",
			}),
		]);
		const baseRefCommit = baseRefResult.ok ? baseRefResult.stdout : null;
		const originBaseRefCommit = originBaseRefResult.ok ? originBaseRefResult.stdout : null;
		if (
			current &&
			current.stateToken === probe.stateToken &&
			current.baseRefCommit === baseRefCommit &&
			current.originBaseRefCommit === originBaseRefCommit &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		const [summary, unmergedResult, treeDiffResult, behindBase, conflictState] = await Promise.all([
			getGitSyncSummary(pathInfo.path, { probe }),
			runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", `${pathInfo.baseRef}...HEAD`], {
				timeoutClass: "metadata",
			}),
			runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", pathInfo.baseRef, "HEAD"], {
				timeoutClass: "metadata",
			}),
			getCommitsBehindBase(pathInfo.path, pathInfo.baseRef),
			loadConflictState(pathInfo.path),
		]);
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: probe.currentBranch,
				isDetached: probe.headCommit !== null && probe.currentBranch === null,
				headCommit: probe.headCommit,
				changedFiles: summary.changedFiles,
				additions: summary.additions,
				deletions: summary.deletions,
				hasUnmergedChanges:
					unmergedResult.exitCode === 0
						? false
						: unmergedResult.exitCode === 1
							? treeDiffResult.exitCode !== 0 // suppress when trees are identical (already landed)
							: null,
				behindBaseCount: behindBase?.behindCount ?? null,
				conflictState,
				stateVersion: Date.now(),
			},
			stateToken: probe.stateToken,
			baseRefCommit,
			originBaseRefCommit,
			lastKnownBranch: probe.currentBranch,
		};
	} catch {
		if (current) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				hasUnmergedChanges: null,
				behindBaseCount: null,
				conflictState: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
			baseRefCommit: null,
			originBaseRefCommit: null,
			lastKnownBranch: null,
		};
	}
}
