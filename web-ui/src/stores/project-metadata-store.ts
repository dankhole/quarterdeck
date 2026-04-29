import { useSyncExternalStore } from "react";

import type {
	RuntimeConflictState,
	RuntimeGitSyncSummary,
	RuntimeProjectMetadata,
	RuntimeTaskRepositoryInfoResponse,
	RuntimeTaskWorktreeInfoResponse,
	RuntimeTaskWorktreeMetadata,
} from "@/runtime/types";
import type { ReviewTaskWorktreeSnapshot } from "@/types";

type StoreListener = () => void;
type TaskMetadataListener = (taskId: string) => void;

interface ProjectMetadataState {
	projectPath: string | null;
	homeGitSummary: RuntimeGitSyncSummary | null;
	homeGitStateVersion: number;
	homeStashCount: number;
	taskWorktreeInfoByTaskId: Record<string, RuntimeTaskWorktreeInfoResponse | null>;
	taskWorktreeSnapshotByTaskId: Record<string, ReviewTaskWorktreeSnapshot | null>;
	taskWorktreeStateVersionByTaskId: Record<string, number>;
}

const projectMetadataState: ProjectMetadataState = {
	projectPath: null,
	homeGitSummary: null,
	homeGitStateVersion: 0,
	homeStashCount: 0,
	taskWorktreeInfoByTaskId: {},
	taskWorktreeSnapshotByTaskId: {},
	taskWorktreeStateVersionByTaskId: {},
};

let homeConflictState: RuntimeConflictState | null = null;
const homeGitSummaryListeners = new Set<StoreListener>();
const homeConflictStateListeners = new Set<StoreListener>();
const homeStashCountListeners = new Set<StoreListener>();
const taskMetadataListenersByTaskId = new Map<string, Set<StoreListener>>();
const anyTaskMetadataListeners = new Set<TaskMetadataListener>();

function emitHomeGitSummary(): void {
	for (const listener of homeGitSummaryListeners) {
		listener();
	}
}

function emitHomeConflictState(): void {
	for (const listener of homeConflictStateListeners) {
		listener();
	}
}

function emitHomeStashCount(): void {
	for (const listener of homeStashCountListeners) {
		listener();
	}
}

function emitTaskMetadata(taskId: string): void {
	const listeners = taskMetadataListenersByTaskId.get(taskId);
	if (listeners) {
		for (const listener of listeners) {
			listener();
		}
	}
	for (const listener of anyTaskMetadataListeners) {
		listener(taskId);
	}
}

function toTaskWorktreeInfo(metadata: RuntimeTaskWorktreeMetadata): RuntimeTaskWorktreeInfoResponse {
	return {
		taskId: metadata.taskId,
		path: metadata.path,
		exists: metadata.exists,
		baseRef: metadata.baseRef,
		branch: metadata.branch,
		isDetached: metadata.isDetached,
		headCommit: metadata.headCommit,
	};
}

function toTaskWorktreeSnapshot(metadata: RuntimeTaskWorktreeMetadata): ReviewTaskWorktreeSnapshot {
	return {
		taskId: metadata.taskId,
		path: metadata.path,
		baseRef: metadata.baseRef,
		branch: metadata.branch,
		isDetached: metadata.isDetached,
		headCommit: metadata.headCommit,
		changedFiles: metadata.changedFiles,
		additions: metadata.additions,
		deletions: metadata.deletions,
		hasUnmergedChanges: metadata.hasUnmergedChanges,
		behindBaseCount: metadata.behindBaseCount,
		conflictState: metadata.conflictState ?? null,
	};
}

function subscribeToTaskId(taskId: string, listener: StoreListener): () => void {
	const listeners = taskMetadataListenersByTaskId.get(taskId) ?? new Set<StoreListener>();
	listeners.add(listener);
	taskMetadataListenersByTaskId.set(taskId, listeners);
	return () => {
		const current = taskMetadataListenersByTaskId.get(taskId);
		if (!current) {
			return;
		}
		current.delete(listener);
		if (current.size === 0) {
			taskMetadataListenersByTaskId.delete(taskId);
		}
	};
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

function areTaskWorktreeInfosEqual(
	a: RuntimeTaskWorktreeInfoResponse | null,
	b: RuntimeTaskWorktreeInfoResponse | null,
): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.taskId === b.taskId &&
		a.path === b.path &&
		a.exists === b.exists &&
		a.baseRef === b.baseRef &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit
	);
}

function areConflictStatesEqual(a: RuntimeConflictState | null, b: RuntimeConflictState | null): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.operation === b.operation &&
		a.currentStep === b.currentStep &&
		a.totalSteps === b.totalSteps &&
		a.sourceBranch === b.sourceBranch &&
		a.conflictedFiles.length === b.conflictedFiles.length &&
		a.conflictedFiles.every((f, i) => f === b.conflictedFiles[i]) &&
		a.autoMergedFiles.length === b.autoMergedFiles.length &&
		a.autoMergedFiles.every((f, i) => f === b.autoMergedFiles[i])
	);
}

function areTaskWorktreeSnapshotsEqual(
	a: ReviewTaskWorktreeSnapshot | null,
	b: ReviewTaskWorktreeSnapshot | null,
): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.taskId === b.taskId &&
		a.path === b.path &&
		a.baseRef === b.baseRef &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.hasUnmergedChanges === b.hasUnmergedChanges &&
		a.behindBaseCount === b.behindBaseCount &&
		areConflictStatesEqual(a.conflictState, b.conflictState)
	);
}

export function getProjectPath(): string | null {
	return projectMetadataState.projectPath;
}

export function setProjectPath(path: string | null): void {
	projectMetadataState.projectPath = path;
}

export function getHomeGitStateVersion(): number {
	return projectMetadataState.homeGitStateVersion;
}

function setHomeGitMetadata(summary: RuntimeGitSyncSummary | null, stateVersion: number): boolean {
	const summaryChanged = !areGitSummariesEqual(projectMetadataState.homeGitSummary, summary);
	const versionChanged = projectMetadataState.homeGitStateVersion !== stateVersion;
	if (!summaryChanged && !versionChanged) {
		return false;
	}
	projectMetadataState.homeGitSummary = summary;
	projectMetadataState.homeGitStateVersion = stateVersion;
	emitHomeGitSummary();
	return true;
}

export function setHomeGitSummary(summary: RuntimeGitSyncSummary | null): boolean {
	const nextStateVersion = areGitSummariesEqual(projectMetadataState.homeGitSummary, summary)
		? projectMetadataState.homeGitStateVersion
		: Date.now();
	return setHomeGitMetadata(summary, nextStateVersion);
}

export function clearHomeGitSummary(): void {
	setHomeGitMetadata(null, 0);
}

export function getTaskWorktreeInfo(
	taskId: string | null | undefined,
	baseRef?: string | null,
): RuntimeTaskWorktreeInfoResponse | null {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const value = projectMetadataState.taskWorktreeInfoByTaskId[normalizedTaskId] ?? null;
	if (!value) {
		return null;
	}
	if (baseRef !== undefined && baseRef !== null && value.baseRef !== baseRef) {
		return null;
	}
	return value;
}

export function getTaskRepositoryInfo(
	taskId: string | null | undefined,
	baseRef?: string | null,
): RuntimeTaskRepositoryInfoResponse | null {
	return getTaskWorktreeInfo(taskId, baseRef);
}

export function setTaskWorktreeInfo(info: RuntimeTaskWorktreeInfoResponse | null): boolean {
	if (!info) {
		return false;
	}
	const existing = projectMetadataState.taskWorktreeInfoByTaskId[info.taskId] ?? null;
	if (areTaskWorktreeInfosEqual(existing, info)) {
		return false;
	}
	projectMetadataState.taskWorktreeInfoByTaskId = {
		...projectMetadataState.taskWorktreeInfoByTaskId,
		[info.taskId]: info,
	};
	emitTaskMetadata(info.taskId);
	return true;
}

export function setTaskRepositoryInfo(info: RuntimeTaskRepositoryInfoResponse | null): boolean {
	return setTaskWorktreeInfo(info);
}

export function clearTaskWorktreeInfo(taskId: string | null | undefined): boolean {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId || !(normalizedTaskId in projectMetadataState.taskWorktreeInfoByTaskId)) {
		return false;
	}
	const { [normalizedTaskId]: _removed, ...rest } = projectMetadataState.taskWorktreeInfoByTaskId;
	projectMetadataState.taskWorktreeInfoByTaskId = rest;
	emitTaskMetadata(normalizedTaskId);
	return true;
}

export function clearTaskRepositoryInfo(taskId: string | null | undefined): boolean {
	return clearTaskWorktreeInfo(taskId);
}

export function getTaskWorktreeSnapshot(
	taskId: string | null | undefined,
	baseRef?: string | null,
): ReviewTaskWorktreeSnapshot | null {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const value = projectMetadataState.taskWorktreeSnapshotByTaskId[normalizedTaskId] ?? null;
	if (!value) {
		return null;
	}
	if (baseRef !== undefined && baseRef !== null && value.baseRef !== undefined && value.baseRef !== baseRef) {
		return null;
	}
	return value;
}

export function setTaskWorktreeSnapshot(snapshot: ReviewTaskWorktreeSnapshot | null): boolean {
	if (!snapshot) {
		return false;
	}
	const existing = projectMetadataState.taskWorktreeSnapshotByTaskId[snapshot.taskId] ?? null;
	if (areTaskWorktreeSnapshotsEqual(existing, snapshot)) {
		return false;
	}
	projectMetadataState.taskWorktreeSnapshotByTaskId = {
		...projectMetadataState.taskWorktreeSnapshotByTaskId,
		[snapshot.taskId]: snapshot,
	};
	projectMetadataState.taskWorktreeStateVersionByTaskId = {
		...projectMetadataState.taskWorktreeStateVersionByTaskId,
		[snapshot.taskId]: Date.now(),
	};
	emitTaskMetadata(snapshot.taskId);
	return true;
}

export function clearTaskWorktreeSnapshot(taskId: string | null | undefined): boolean {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId || !(normalizedTaskId in projectMetadataState.taskWorktreeSnapshotByTaskId)) {
		return false;
	}
	const { [normalizedTaskId]: _removed, ...rest } = projectMetadataState.taskWorktreeSnapshotByTaskId;
	const { [normalizedTaskId]: _removedVersion, ...restVersions } =
		projectMetadataState.taskWorktreeStateVersionByTaskId;
	projectMetadataState.taskWorktreeSnapshotByTaskId = rest;
	projectMetadataState.taskWorktreeStateVersionByTaskId = restVersions;
	emitTaskMetadata(normalizedTaskId);
	return true;
}

export function clearInactiveTaskWorktreeSnapshots(activeTaskIds: Set<string>): void {
	let changed = false;
	const nextSnapshots: Record<string, ReviewTaskWorktreeSnapshot | null> = {};
	const nextStateVersions: Record<string, number> = {};
	for (const [taskId, snapshot] of Object.entries(projectMetadataState.taskWorktreeSnapshotByTaskId)) {
		if (!activeTaskIds.has(taskId)) {
			changed = true;
			continue;
		}
		nextSnapshots[taskId] = snapshot;
		nextStateVersions[taskId] = projectMetadataState.taskWorktreeStateVersionByTaskId[taskId] ?? 0;
	}
	if (!changed) {
		return;
	}
	projectMetadataState.taskWorktreeSnapshotByTaskId = nextSnapshots;
	projectMetadataState.taskWorktreeStateVersionByTaskId = nextStateVersions;
	for (const taskId of taskMetadataListenersByTaskId.keys()) {
		if (!activeTaskIds.has(taskId)) {
			emitTaskMetadata(taskId);
		}
	}
}

export function resetProjectMetadataStore(): void {
	const taskIds = new Set([
		...Object.keys(projectMetadataState.taskWorktreeInfoByTaskId),
		...Object.keys(projectMetadataState.taskWorktreeSnapshotByTaskId),
		...Object.keys(projectMetadataState.taskWorktreeStateVersionByTaskId),
	]);
	projectMetadataState.homeGitSummary = null;
	projectMetadataState.homeGitStateVersion = 0;
	projectMetadataState.homeStashCount = 0;
	projectMetadataState.taskWorktreeInfoByTaskId = {};
	projectMetadataState.taskWorktreeSnapshotByTaskId = {};
	projectMetadataState.taskWorktreeStateVersionByTaskId = {};
	homeConflictState = null;
	emitHomeGitSummary();
	emitHomeConflictState();
	emitHomeStashCount();
	for (const taskId of taskIds) {
		emitTaskMetadata(taskId);
	}
}

export function replaceProjectMetadata(metadata: RuntimeProjectMetadata | null): void {
	setHomeGitMetadata(metadata?.homeGitSummary ?? null, metadata?.homeGitStateVersion ?? 0);

	const nextHomeConflictState = metadata?.homeConflictState ?? null;
	if (!areConflictStatesEqual(homeConflictState, nextHomeConflictState)) {
		homeConflictState = nextHomeConflictState;
		emitHomeConflictState();
	}

	const nextHomeStashCount = metadata?.homeStashCount ?? 0;
	if (projectMetadataState.homeStashCount !== nextHomeStashCount) {
		projectMetadataState.homeStashCount = nextHomeStashCount;
		emitHomeStashCount();
	}

	const nextTaskWorktreeInfoByTaskId: Record<string, RuntimeTaskWorktreeInfoResponse | null> = {};
	const nextTaskWorktreeSnapshotByTaskId: Record<string, ReviewTaskWorktreeSnapshot | null> = {};
	const nextTaskWorktreeStateVersionByTaskId: Record<string, number> = {};

	for (const taskMetadata of metadata?.taskWorktrees ?? []) {
		nextTaskWorktreeInfoByTaskId[taskMetadata.taskId] = toTaskWorktreeInfo(taskMetadata);
		nextTaskWorktreeSnapshotByTaskId[taskMetadata.taskId] = toTaskWorktreeSnapshot(taskMetadata);
		nextTaskWorktreeStateVersionByTaskId[taskMetadata.taskId] = taskMetadata.stateVersion;
	}

	const taskIds = new Set([
		...Object.keys(projectMetadataState.taskWorktreeInfoByTaskId),
		...Object.keys(projectMetadataState.taskWorktreeSnapshotByTaskId),
		...Object.keys(projectMetadataState.taskWorktreeStateVersionByTaskId),
		...Object.keys(nextTaskWorktreeInfoByTaskId),
		...Object.keys(nextTaskWorktreeSnapshotByTaskId),
		...Object.keys(nextTaskWorktreeStateVersionByTaskId),
	]);

	const changedTaskIds: string[] = [];
	for (const taskId of taskIds) {
		const previousInfo = projectMetadataState.taskWorktreeInfoByTaskId[taskId] ?? null;
		const nextInfo = nextTaskWorktreeInfoByTaskId[taskId] ?? null;
		const previousSnapshot = projectMetadataState.taskWorktreeSnapshotByTaskId[taskId] ?? null;
		const nextSnapshot = nextTaskWorktreeSnapshotByTaskId[taskId] ?? null;
		const previousStateVersion = projectMetadataState.taskWorktreeStateVersionByTaskId[taskId] ?? 0;
		const nextStateVersion = nextTaskWorktreeStateVersionByTaskId[taskId] ?? 0;
		if (
			!areTaskWorktreeInfosEqual(previousInfo, nextInfo) ||
			!areTaskWorktreeSnapshotsEqual(previousSnapshot, nextSnapshot) ||
			previousStateVersion !== nextStateVersion
		) {
			changedTaskIds.push(taskId);
		}
	}

	projectMetadataState.taskWorktreeInfoByTaskId = nextTaskWorktreeInfoByTaskId;
	projectMetadataState.taskWorktreeSnapshotByTaskId = nextTaskWorktreeSnapshotByTaskId;
	projectMetadataState.taskWorktreeStateVersionByTaskId = nextTaskWorktreeStateVersionByTaskId;

	for (const taskId of changedTaskIds) {
		emitTaskMetadata(taskId);
	}
}

export function subscribeToAnyTaskMetadata(listener: TaskMetadataListener): () => void {
	anyTaskMetadataListeners.add(listener);
	return () => {
		anyTaskMetadataListeners.delete(listener);
	};
}

export function useHomeGitSummaryValue(): RuntimeGitSyncSummary | null {
	return useSyncExternalStore(
		(listener) => {
			homeGitSummaryListeners.add(listener);
			return () => {
				homeGitSummaryListeners.delete(listener);
			};
		},
		() => projectMetadataState.homeGitSummary,
		() => null,
	);
}

export function useHomeGitStateVersionValue(): number {
	return useSyncExternalStore(
		(listener) => {
			homeGitSummaryListeners.add(listener);
			return () => {
				homeGitSummaryListeners.delete(listener);
			};
		},
		() => projectMetadataState.homeGitStateVersion,
		() => 0,
	);
}

export function useTaskWorktreeInfoValue(
	taskId: string | null | undefined,
	baseRef?: string | null,
): RuntimeTaskWorktreeInfoResponse | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => getTaskWorktreeInfo(normalizedTaskId, baseRef),
		() => null,
	);
}

export function useTaskRepositoryInfoValue(
	taskId: string | null | undefined,
	baseRef?: string | null,
): RuntimeTaskRepositoryInfoResponse | null {
	return useTaskWorktreeInfoValue(taskId, baseRef);
}

export function useTaskWorktreeSnapshotValue(
	taskId: string | null | undefined,
	baseRef?: string | null,
): ReviewTaskWorktreeSnapshot | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => getTaskWorktreeSnapshot(normalizedTaskId, baseRef),
		() => null,
	);
}

export function useTaskWorktreeStateVersionValue(taskId: string | null | undefined): number {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => projectMetadataState.taskWorktreeStateVersionByTaskId[normalizedTaskId] ?? 0,
		() => 0,
	);
}

export function useConflictState(taskId: string | null): RuntimeConflictState | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => {
			if (!normalizedTaskId) {
				return null;
			}
			const snapshot = projectMetadataState.taskWorktreeSnapshotByTaskId[normalizedTaskId];
			return snapshot?.conflictState ?? null;
		},
		() => null,
	);
}

export function useHomeConflictState(): RuntimeConflictState | null {
	return useSyncExternalStore(
		(listener) => {
			homeConflictStateListeners.add(listener);
			return () => {
				homeConflictStateListeners.delete(listener);
			};
		},
		() => homeConflictState,
		() => null,
	);
}

export function useHomeStashCount(): number {
	return useSyncExternalStore(
		(listener) => {
			homeStashCountListeners.add(listener);
			return () => {
				homeStashCountListeners.delete(listener);
			};
		},
		() => projectMetadataState.homeStashCount,
		() => 0,
	);
}
