import type { RuntimeConflictState } from "../core";
import {
	computeAutoMergedFiles,
	detectActiveConflict,
	getConflictedFiles,
	getGitSyncSummary,
	probeGitWorkdirState,
} from "../workdir";
import type { ResolvedTaskWorktreePath } from "./project-metadata-paths";

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

export async function loadConflictState(cwd: string): Promise<RuntimeConflictState | null> {
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
