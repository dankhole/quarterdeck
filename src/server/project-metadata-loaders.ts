import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

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

export interface ResolvedTaskWorktreePath {
	taskId: string;
	path: string;
	normalizedPath: string;
	exists: boolean;
	baseRef: string;
}

export interface ResolvedTaskWorktreeMetadataInput {
	task: TrackedTaskWorktree;
	pathInfo: ResolvedTaskWorktreePath;
	current: CachedTaskWorktreeMetadata | null;
}

export interface LoadedTaskWorktreeMetadata {
	taskId: string;
	metadata: CachedTaskWorktreeMetadata | null;
}

export interface CachedPathWorktreeMetadata {
	path: string;
	normalizedPath: string;
	exists: boolean;
	probeFailed: boolean;
	branch: string | null;
	isDetached: boolean;
	headCommit: string | null;
	changedFiles: number | null;
	additions: number | null;
	deletions: number | null;
	conflictState: RuntimeConflictState | null;
	stateToken: string | null;
	stateVersion: number;
	lastKnownBranch: string | null;
}

export interface BaseRefWorktreeMetadata {
	baseRefCommit: string | null;
	originBaseRefCommit: string | null;
	hasUnmergedChanges: boolean | null;
	behindBaseCount: number | null;
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

async function normalizePhysicalPath(path: string, exists: boolean): Promise<string> {
	const absolutePath = resolvePath(path);
	if (!exists) {
		return absolutePath;
	}
	try {
		return await realpath(absolutePath);
	} catch {
		return absolutePath;
	}
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

export async function resolveTaskWorktreePath(
	projectPath: string,
	task: TrackedTaskWorktree,
): Promise<ResolvedTaskWorktreePath> {
	if (task.useWorktree === false) {
		const exists = await pathExists(projectPath);
		return {
			taskId: task.taskId,
			path: projectPath,
			normalizedPath: await normalizePhysicalPath(projectPath, exists),
			exists,
			baseRef: task.baseRef,
		};
	}
	// Use the card's workingDirectory if available (set at session start).
	if (task.workingDirectory) {
		const exists = await pathExists(task.workingDirectory);
		return {
			taskId: task.taskId,
			path: task.workingDirectory,
			normalizedPath: await normalizePhysicalPath(task.workingDirectory, exists),
			exists,
			baseRef: task.baseRef,
		};
	}
	if (!task.baseRef.trim()) {
		const worktreePath = getTaskWorktreePath(projectPath, task.taskId);
		const exists = await pathExists(worktreePath);
		return {
			taskId: task.taskId,
			path: worktreePath,
			normalizedPath: await normalizePhysicalPath(worktreePath, exists),
			exists,
			baseRef: "",
		};
	}
	// Fallback for tasks started before workingDirectory was persisted.
	const pathInfo = await getTaskWorktreePathInfo({
		cwd: projectPath,
		taskId: task.taskId,
		baseRef: task.baseRef,
	});
	return {
		taskId: pathInfo.taskId,
		path: pathInfo.path,
		normalizedPath: await normalizePhysicalPath(pathInfo.path, pathInfo.exists),
		exists: pathInfo.exists,
		baseRef: pathInfo.baseRef,
	};
}

export async function resolveTaskWorktreeMetadataInput(
	projectPath: string,
	task: TrackedTaskWorktree,
	current: CachedTaskWorktreeMetadata | null,
): Promise<ResolvedTaskWorktreeMetadataInput> {
	return {
		task,
		pathInfo: await resolveTaskWorktreePath(projectPath, task),
		current,
	};
}

function derivePathMetadataFromTask(
	pathInfo: ResolvedTaskWorktreePath,
	current: CachedTaskWorktreeMetadata | null,
): CachedPathWorktreeMetadata | null {
	if (!current || current.data.path !== pathInfo.path || current.data.exists !== pathInfo.exists) {
		return null;
	}
	return {
		path: current.data.path,
		normalizedPath: pathInfo.normalizedPath,
		exists: current.data.exists,
		probeFailed: false,
		branch: current.data.branch,
		isDetached: current.data.isDetached,
		headCommit: current.data.headCommit,
		changedFiles: current.data.changedFiles,
		additions: current.data.additions,
		deletions: current.data.deletions,
		conflictState: current.data.conflictState ?? null,
		stateToken: current.stateToken,
		stateVersion: current.data.stateVersion,
		lastKnownBranch: current.lastKnownBranch,
	};
}

function createMissingPathMetadata(
	pathInfo: ResolvedTaskWorktreePath,
	currentPathMetadata: CachedPathWorktreeMetadata | null,
): CachedPathWorktreeMetadata {
	if (currentPathMetadata?.exists === false) {
		return currentPathMetadata;
	}
	return {
		path: pathInfo.path,
		normalizedPath: pathInfo.normalizedPath,
		exists: false,
		probeFailed: false,
		branch: null,
		isDetached: false,
		headCommit: null,
		changedFiles: null,
		additions: null,
		deletions: null,
		conflictState: null,
		stateToken: null,
		stateVersion: Date.now(),
		lastKnownBranch: null,
	};
}

export async function loadPathWorktreeMetadata(
	pathInfo: ResolvedTaskWorktreePath,
	currentPathMetadata: CachedPathWorktreeMetadata | null,
): Promise<CachedPathWorktreeMetadata> {
	if (!pathInfo.exists) {
		return createMissingPathMetadata(pathInfo, currentPathMetadata);
	}

	try {
		const probe = await probeGitWorkdirState(pathInfo.path);
		if (
			currentPathMetadata?.exists &&
			currentPathMetadata.path === pathInfo.path &&
			currentPathMetadata.stateToken === probe.stateToken
		) {
			return currentPathMetadata;
		}
		const [gitSummary, conflictState] = await Promise.all([
			getGitSyncSummary(pathInfo.path, { probe }),
			loadConflictState(pathInfo.path),
		]);
		return {
			path: pathInfo.path,
			normalizedPath: pathInfo.normalizedPath,
			exists: true,
			probeFailed: false,
			branch: probe.currentBranch,
			isDetached: probe.headCommit !== null && probe.currentBranch === null,
			headCommit: probe.headCommit,
			changedFiles: gitSummary.changedFiles,
			additions: gitSummary.additions,
			deletions: gitSummary.deletions,
			conflictState,
			stateToken: probe.stateToken,
			stateVersion: Date.now(),
			lastKnownBranch: probe.currentBranch,
		};
	} catch {
		if (currentPathMetadata && currentPathMetadata.path === pathInfo.path) {
			return { ...currentPathMetadata, probeFailed: true };
		}
		return {
			path: pathInfo.path,
			normalizedPath: pathInfo.normalizedPath,
			exists: true,
			probeFailed: true,
			branch: null,
			isDetached: false,
			headCommit: null,
			changedFiles: null,
			additions: null,
			deletions: null,
			conflictState: null,
			stateToken: null,
			stateVersion: Date.now(),
			lastKnownBranch: null,
		};
	}
}

function canReuseTaskMetadata(
	task: TrackedTaskWorktree,
	pathInfo: ResolvedTaskWorktreePath,
	pathMetadata: CachedPathWorktreeMetadata,
	baseRefMetadata: BaseRefWorktreeMetadata,
	current: CachedTaskWorktreeMetadata | null,
): current is CachedTaskWorktreeMetadata {
	return (
		current !== null &&
		current.data.taskId === task.taskId &&
		current.data.path === pathInfo.path &&
		current.data.exists === pathMetadata.exists &&
		current.data.baseRef === pathInfo.baseRef &&
		current.stateToken === pathMetadata.stateToken &&
		current.baseRefCommit === baseRefMetadata.baseRefCommit &&
		current.originBaseRefCommit === baseRefMetadata.originBaseRefCommit
	);
}

async function loadBaseRefWorktreeMetadata(
	pathInfo: ResolvedTaskWorktreePath,
	pathMetadata: CachedPathWorktreeMetadata,
	current: CachedTaskWorktreeMetadata | null,
): Promise<BaseRefWorktreeMetadata> {
	if (!pathMetadata.exists || !pathInfo.baseRef.trim()) {
		return {
			baseRefCommit: null,
			originBaseRefCommit: null,
			hasUnmergedChanges: null,
			behindBaseCount: null,
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
		current.stateToken === pathMetadata.stateToken &&
		current.baseRefCommit === baseRefCommit &&
		current.originBaseRefCommit === originBaseRefCommit &&
		current.data.path === pathInfo.path &&
		current.data.baseRef === pathInfo.baseRef
	) {
		return {
			baseRefCommit,
			originBaseRefCommit,
			hasUnmergedChanges: current.data.hasUnmergedChanges,
			behindBaseCount: current.data.behindBaseCount,
		};
	}

	const [unmergedResult, treeDiffResult, behindBase] = await Promise.all([
		runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", `${pathInfo.baseRef}...HEAD`], {
			timeoutClass: "metadata",
		}),
		runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", pathInfo.baseRef, "HEAD"], {
			timeoutClass: "metadata",
		}),
		getCommitsBehindBase(pathInfo.path, pathInfo.baseRef),
	]);
	return {
		baseRefCommit,
		originBaseRefCommit,
		hasUnmergedChanges:
			unmergedResult.exitCode === 0
				? false
				: unmergedResult.exitCode === 1
					? treeDiffResult.exitCode !== 0 // suppress when trees are identical (already landed)
					: null,
		behindBaseCount: behindBase?.behindCount ?? null,
	};
}

export function projectTaskWorktreeMetadata(input: {
	task: TrackedTaskWorktree;
	pathInfo: ResolvedTaskWorktreePath;
	pathMetadata: CachedPathWorktreeMetadata;
	baseRefMetadata: BaseRefWorktreeMetadata;
	current: CachedTaskWorktreeMetadata | null;
}): CachedTaskWorktreeMetadata {
	const { task, pathInfo, pathMetadata, baseRefMetadata, current } = input;
	if (canReuseTaskMetadata(task, pathInfo, pathMetadata, baseRefMetadata, current)) {
		return current;
	}
	return {
		data: {
			taskId: task.taskId,
			path: pathInfo.path,
			exists: pathMetadata.exists,
			baseRef: pathInfo.baseRef,
			branch: pathMetadata.branch,
			isDetached: pathMetadata.isDetached,
			headCommit: pathMetadata.headCommit,
			changedFiles: pathMetadata.changedFiles,
			additions: pathMetadata.additions,
			deletions: pathMetadata.deletions,
			hasUnmergedChanges: baseRefMetadata.hasUnmergedChanges,
			behindBaseCount: baseRefMetadata.behindBaseCount,
			conflictState: pathMetadata.conflictState,
			stateVersion: Date.now(),
		},
		stateToken: pathMetadata.stateToken,
		baseRefCommit: baseRefMetadata.baseRefCommit,
		originBaseRefCommit: baseRefMetadata.originBaseRefCommit,
		lastKnownBranch: pathMetadata.lastKnownBranch,
	};
}

function selectCurrentPathMetadata(inputs: ResolvedTaskWorktreeMetadataInput[]): CachedPathWorktreeMetadata | null {
	for (const input of inputs) {
		const currentPathMetadata = derivePathMetadataFromTask(input.pathInfo, input.current);
		if (currentPathMetadata) {
			return currentPathMetadata;
		}
	}
	return null;
}

function selectCurrentBaseRefMetadataInput(
	inputs: ResolvedTaskWorktreeMetadataInput[],
	pathMetadata: CachedPathWorktreeMetadata,
	baseRef: string,
): CachedTaskWorktreeMetadata | null {
	for (const input of inputs) {
		if (
			input.pathInfo.baseRef === baseRef &&
			input.current &&
			input.current.data.path === input.pathInfo.path &&
			input.current.data.baseRef === baseRef &&
			input.current.stateToken === pathMetadata.stateToken
		) {
			return input.current;
		}
	}
	return null;
}

async function loadTaskWorktreeMetadataForResolvedPath(
	inputs: ResolvedTaskWorktreeMetadataInput[],
): Promise<LoadedTaskWorktreeMetadata[]> {
	if (inputs.length === 0) {
		return [];
	}
	const pathInfo = inputs[0]?.pathInfo;
	if (!pathInfo) {
		return [];
	}
	const pathMetadata = await loadPathWorktreeMetadata(pathInfo, selectCurrentPathMetadata(inputs));
	if (pathMetadata.probeFailed) {
		return inputs.map((input) => ({
			taskId: input.task.taskId,
			metadata:
				input.current ??
				projectTaskWorktreeMetadata({
					task: input.task,
					pathInfo: input.pathInfo,
					pathMetadata: {
						...pathMetadata,
						path: input.pathInfo.path,
						normalizedPath: input.pathInfo.normalizedPath,
						branch: null,
						isDetached: false,
						headCommit: null,
						changedFiles: null,
						additions: null,
						deletions: null,
						conflictState: null,
						stateToken: null,
						lastKnownBranch: null,
					},
					baseRefMetadata: {
						baseRefCommit: null,
						originBaseRefCommit: null,
						hasUnmergedChanges: null,
						behindBaseCount: null,
					},
					current: input.current,
				}),
		}));
	}
	const baseRefMetadataByRef = new Map<string, BaseRefWorktreeMetadata>();
	const results: LoadedTaskWorktreeMetadata[] = [];

	for (const input of inputs) {
		let baseRefMetadata = baseRefMetadataByRef.get(input.pathInfo.baseRef);
		if (!baseRefMetadata) {
			baseRefMetadata = await loadBaseRefWorktreeMetadata(
				input.pathInfo,
				pathMetadata,
				selectCurrentBaseRefMetadataInput(inputs, pathMetadata, input.pathInfo.baseRef),
			);
			baseRefMetadataByRef.set(input.pathInfo.baseRef, baseRefMetadata);
		}
		results.push({
			taskId: input.task.taskId,
			metadata: projectTaskWorktreeMetadata({
				task: input.task,
				pathInfo: input.pathInfo,
				pathMetadata,
				baseRefMetadata,
				current: input.current,
			}),
		});
	}
	return results;
}

export async function loadTaskWorktreeMetadataBatch(
	inputs: ResolvedTaskWorktreeMetadataInput[],
): Promise<LoadedTaskWorktreeMetadata[]> {
	const groups = new Map<string, ResolvedTaskWorktreeMetadataInput[]>();
	for (const input of inputs) {
		const currentGroup = groups.get(input.pathInfo.normalizedPath);
		if (currentGroup) {
			currentGroup.push(input);
		} else {
			groups.set(input.pathInfo.normalizedPath, [input]);
		}
	}
	const loaded: LoadedTaskWorktreeMetadata[] = [];
	for (const group of groups.values()) {
		loaded.push(...(await loadTaskWorktreeMetadataForResolvedPath(group)));
	}
	return loaded;
}

export async function loadTaskWorktreeMetadata(
	projectPath: string,
	task: TrackedTaskWorktree,
	current: CachedTaskWorktreeMetadata | null,
): Promise<CachedTaskWorktreeMetadata | null> {
	const input = await resolveTaskWorktreeMetadataInput(projectPath, task, current);
	const [loaded] = await loadTaskWorktreeMetadataBatch([input]);
	return loaded?.metadata ?? null;
}
