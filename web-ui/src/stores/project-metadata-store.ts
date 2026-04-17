import { useSyncExternalStore } from "react";

import type {
	RuntimeConflictState,
	RuntimeGitSyncSummary,
	RuntimeProjectMetadata,
	RuntimeTaskProjectMetadata,
	RuntimeTaskWorktreeInfoResponse,
} from "@/runtime/types";
import type { ReviewTaskProjectSnapshot } from "@/types";

type StoreListener = () => void;
type TaskMetadataListener = (taskId: string) => void;

interface WorkspaceMetadataState {
	projectPath: string | null;
	homeGitSummary: RuntimeGitSyncSummary | null;
	homeGitStateVersion: number;
	homeStashCount: number;
	taskWorkspaceInfoByTaskId: Record<string, RuntimeTaskWorktreeInfoResponse | null>;
	taskWorkspaceSnapshotByTaskId: Record<string, ReviewTaskProjectSnapshot | null>;
	taskWorkspaceStateVersionByTaskId: Record<string, number>;
}

const projectMetadataState: WorkspaceMetadataState = {
	projectPath: null,
	homeGitSummary: null,
	homeGitStateVersion: 0,
	homeStashCount: 0,
	taskWorkspaceInfoByTaskId: {},
	taskWorkspaceSnapshotByTaskId: {},
	taskWorkspaceStateVersionByTaskId: {},
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

function toTaskWorkspaceInfo(metadata: RuntimeTaskProjectMetadata): RuntimeTaskWorktreeInfoResponse {
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

function toTaskWorkspaceSnapshot(metadata: RuntimeTaskProjectMetadata): ReviewTaskProjectSnapshot {
	return {
		taskId: metadata.taskId,
		path: metadata.path,
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

function areTaskWorkspaceInfosEqual(
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

function areTaskWorkspaceSnapshotsEqual(
	a: ReviewTaskProjectSnapshot | null,
	b: ReviewTaskProjectSnapshot | null,
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
	const value = projectMetadataState.taskWorkspaceInfoByTaskId[normalizedTaskId] ?? null;
	if (!value) {
		return null;
	}
	if (baseRef && value.baseRef !== baseRef) {
		return null;
	}
	return value;
}

export function setTaskWorktreeInfo(info: RuntimeTaskWorktreeInfoResponse | null): boolean {
	if (!info) {
		return false;
	}
	const existing = projectMetadataState.taskWorkspaceInfoByTaskId[info.taskId] ?? null;
	if (areTaskWorkspaceInfosEqual(existing, info)) {
		return false;
	}
	projectMetadataState.taskWorkspaceInfoByTaskId = {
		...projectMetadataState.taskWorkspaceInfoByTaskId,
		[info.taskId]: info,
	};
	emitTaskMetadata(info.taskId);
	return true;
}

export function clearTaskWorktreeInfo(taskId: string | null | undefined): boolean {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId || !(normalizedTaskId in projectMetadataState.taskWorkspaceInfoByTaskId)) {
		return false;
	}
	const { [normalizedTaskId]: _removed, ...rest } = projectMetadataState.taskWorkspaceInfoByTaskId;
	projectMetadataState.taskWorkspaceInfoByTaskId = rest;
	emitTaskMetadata(normalizedTaskId);
	return true;
}

export function getTaskProjectSnapshot(taskId: string | null | undefined): ReviewTaskProjectSnapshot | null {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId) {
		return null;
	}
	return projectMetadataState.taskWorkspaceSnapshotByTaskId[normalizedTaskId] ?? null;
}

export function setTaskProjectSnapshot(snapshot: ReviewTaskProjectSnapshot | null): boolean {
	if (!snapshot) {
		return false;
	}
	const existing = projectMetadataState.taskWorkspaceSnapshotByTaskId[snapshot.taskId] ?? null;
	if (areTaskWorkspaceSnapshotsEqual(existing, snapshot)) {
		return false;
	}
	projectMetadataState.taskWorkspaceSnapshotByTaskId = {
		...projectMetadataState.taskWorkspaceSnapshotByTaskId,
		[snapshot.taskId]: snapshot,
	};
	projectMetadataState.taskWorkspaceStateVersionByTaskId = {
		...projectMetadataState.taskWorkspaceStateVersionByTaskId,
		[snapshot.taskId]: Date.now(),
	};
	emitTaskMetadata(snapshot.taskId);
	return true;
}

export function clearTaskProjectSnapshot(taskId: string | null | undefined): boolean {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId || !(normalizedTaskId in projectMetadataState.taskWorkspaceSnapshotByTaskId)) {
		return false;
	}
	const { [normalizedTaskId]: _removed, ...rest } = projectMetadataState.taskWorkspaceSnapshotByTaskId;
	const { [normalizedTaskId]: _removedVersion, ...restVersions } =
		projectMetadataState.taskWorkspaceStateVersionByTaskId;
	projectMetadataState.taskWorkspaceSnapshotByTaskId = rest;
	projectMetadataState.taskWorkspaceStateVersionByTaskId = restVersions;
	emitTaskMetadata(normalizedTaskId);
	return true;
}

export function clearInactiveTaskProjectSnapshots(activeTaskIds: Set<string>): void {
	let changed = false;
	const nextSnapshots: Record<string, ReviewTaskProjectSnapshot | null> = {};
	const nextStateVersions: Record<string, number> = {};
	for (const [taskId, snapshot] of Object.entries(projectMetadataState.taskWorkspaceSnapshotByTaskId)) {
		if (!activeTaskIds.has(taskId)) {
			changed = true;
			continue;
		}
		nextSnapshots[taskId] = snapshot;
		nextStateVersions[taskId] = projectMetadataState.taskWorkspaceStateVersionByTaskId[taskId] ?? 0;
	}
	if (!changed) {
		return;
	}
	projectMetadataState.taskWorkspaceSnapshotByTaskId = nextSnapshots;
	projectMetadataState.taskWorkspaceStateVersionByTaskId = nextStateVersions;
	for (const taskId of taskMetadataListenersByTaskId.keys()) {
		if (!activeTaskIds.has(taskId)) {
			emitTaskMetadata(taskId);
		}
	}
}

export function resetProjectMetadataStore(): void {
	const taskIds = new Set([
		...Object.keys(projectMetadataState.taskWorkspaceInfoByTaskId),
		...Object.keys(projectMetadataState.taskWorkspaceSnapshotByTaskId),
		...Object.keys(projectMetadataState.taskWorkspaceStateVersionByTaskId),
	]);
	projectMetadataState.homeGitSummary = null;
	projectMetadataState.homeGitStateVersion = 0;
	projectMetadataState.homeStashCount = 0;
	projectMetadataState.taskWorkspaceInfoByTaskId = {};
	projectMetadataState.taskWorkspaceSnapshotByTaskId = {};
	projectMetadataState.taskWorkspaceStateVersionByTaskId = {};
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

	const nextTaskWorkspaceInfoByTaskId: Record<string, RuntimeTaskWorktreeInfoResponse | null> = {};
	const nextTaskWorkspaceSnapshotByTaskId: Record<string, ReviewTaskProjectSnapshot | null> = {};
	const nextTaskWorkspaceStateVersionByTaskId: Record<string, number> = {};

	for (const taskMetadata of metadata?.taskWorkspaces ?? []) {
		nextTaskWorkspaceInfoByTaskId[taskMetadata.taskId] = toTaskWorkspaceInfo(taskMetadata);
		nextTaskWorkspaceSnapshotByTaskId[taskMetadata.taskId] = toTaskWorkspaceSnapshot(taskMetadata);
		nextTaskWorkspaceStateVersionByTaskId[taskMetadata.taskId] = taskMetadata.stateVersion;
	}

	const taskIds = new Set([
		...Object.keys(projectMetadataState.taskWorkspaceInfoByTaskId),
		...Object.keys(projectMetadataState.taskWorkspaceSnapshotByTaskId),
		...Object.keys(projectMetadataState.taskWorkspaceStateVersionByTaskId),
		...Object.keys(nextTaskWorkspaceInfoByTaskId),
		...Object.keys(nextTaskWorkspaceSnapshotByTaskId),
		...Object.keys(nextTaskWorkspaceStateVersionByTaskId),
	]);

	const changedTaskIds: string[] = [];
	for (const taskId of taskIds) {
		const previousInfo = projectMetadataState.taskWorkspaceInfoByTaskId[taskId] ?? null;
		const nextInfo = nextTaskWorkspaceInfoByTaskId[taskId] ?? null;
		const previousSnapshot = projectMetadataState.taskWorkspaceSnapshotByTaskId[taskId] ?? null;
		const nextSnapshot = nextTaskWorkspaceSnapshotByTaskId[taskId] ?? null;
		const previousStateVersion = projectMetadataState.taskWorkspaceStateVersionByTaskId[taskId] ?? 0;
		const nextStateVersion = nextTaskWorkspaceStateVersionByTaskId[taskId] ?? 0;
		if (
			!areTaskWorkspaceInfosEqual(previousInfo, nextInfo) ||
			!areTaskWorkspaceSnapshotsEqual(previousSnapshot, nextSnapshot) ||
			previousStateVersion !== nextStateVersion
		) {
			changedTaskIds.push(taskId);
		}
	}

	projectMetadataState.taskWorkspaceInfoByTaskId = nextTaskWorkspaceInfoByTaskId;
	projectMetadataState.taskWorkspaceSnapshotByTaskId = nextTaskWorkspaceSnapshotByTaskId;
	projectMetadataState.taskWorkspaceStateVersionByTaskId = nextTaskWorkspaceStateVersionByTaskId;

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

export function useTaskProjectSnapshotValue(taskId: string | null | undefined): ReviewTaskProjectSnapshot | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => getTaskProjectSnapshot(normalizedTaskId),
		() => null,
	);
}

export function useTaskProjectStateVersionValue(taskId: string | null | undefined): number {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => projectMetadataState.taskWorkspaceStateVersionByTaskId[normalizedTaskId] ?? 0,
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
			const snapshot = projectMetadataState.taskWorkspaceSnapshotByTaskId[normalizedTaskId];
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
