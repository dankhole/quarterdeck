import { useSyncExternalStore } from "react";

import type { RuntimeGitSyncSummary, RuntimeTaskGitStatus, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

type StoreListener = () => void;
type TaskMetadataListener = (taskId: string) => void;

interface WorkspaceMetadataState {
	homeGitSummary: RuntimeGitSyncSummary | null;
	homeChangeRevision: number;
	taskWorkspaceInfoByTaskId: Record<string, RuntimeTaskWorkspaceInfoResponse | null>;
	taskWorkspaceSnapshotByTaskId: Record<string, ReviewTaskWorkspaceSnapshot | null>;
	taskChangeRevisionByTaskId: Record<string, number>;
}

const workspaceMetadataState: WorkspaceMetadataState = {
	homeGitSummary: null,
	homeChangeRevision: 0,
	taskWorkspaceInfoByTaskId: {},
	taskWorkspaceSnapshotByTaskId: {},
	taskChangeRevisionByTaskId: {},
};

const homeGitSummaryListeners = new Set<StoreListener>();
const taskMetadataListenersByTaskId = new Map<string, Set<StoreListener>>();
const anyTaskMetadataListeners = new Set<TaskMetadataListener>();

function emitHomeGitSummary(): void {
	for (const listener of homeGitSummaryListeners) {
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
	a: RuntimeTaskWorkspaceInfoResponse | null,
	b: RuntimeTaskWorkspaceInfoResponse | null,
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

function areTaskWorkspaceSnapshotsEqual(
	a: ReviewTaskWorkspaceSnapshot | null,
	b: ReviewTaskWorkspaceSnapshot | null,
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
		a.deletions === b.deletions
	);
}

export function getHomeGitSummary(): RuntimeGitSyncSummary | null {
	return workspaceMetadataState.homeGitSummary;
}

export function getHomeGitChangeRevision(): number {
	return workspaceMetadataState.homeChangeRevision;
}

export function setHomeGitSummary(summary: RuntimeGitSyncSummary | null): boolean {
	if (areGitSummariesEqual(workspaceMetadataState.homeGitSummary, summary)) {
		return false;
	}
	workspaceMetadataState.homeGitSummary = summary;
	workspaceMetadataState.homeChangeRevision += 1;
	emitHomeGitSummary();
	return true;
}

export function clearHomeGitSummary(): void {
	setHomeGitSummary(null);
}

export function getTaskWorkspaceInfo(
	taskId: string | null | undefined,
	baseRef?: string | null,
): RuntimeTaskWorkspaceInfoResponse | null {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const value = workspaceMetadataState.taskWorkspaceInfoByTaskId[normalizedTaskId] ?? null;
	if (!value) {
		return null;
	}
	if (baseRef && value.baseRef !== baseRef) {
		return null;
	}
	return value;
}

export function setTaskWorkspaceInfo(info: RuntimeTaskWorkspaceInfoResponse | null): boolean {
	if (!info) {
		return false;
	}
	const existing = workspaceMetadataState.taskWorkspaceInfoByTaskId[info.taskId] ?? null;
	if (areTaskWorkspaceInfosEqual(existing, info)) {
		return false;
	}
	workspaceMetadataState.taskWorkspaceInfoByTaskId = {
		...workspaceMetadataState.taskWorkspaceInfoByTaskId,
		[info.taskId]: info,
	};
	emitTaskMetadata(info.taskId);
	return true;
}

export function clearTaskWorkspaceInfo(taskId: string | null | undefined): boolean {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId || !(normalizedTaskId in workspaceMetadataState.taskWorkspaceInfoByTaskId)) {
		return false;
	}
	const { [normalizedTaskId]: _removed, ...rest } = workspaceMetadataState.taskWorkspaceInfoByTaskId;
	workspaceMetadataState.taskWorkspaceInfoByTaskId = rest;
	emitTaskMetadata(normalizedTaskId);
	return true;
}

export function getTaskWorkspaceSnapshot(taskId: string | null | undefined): ReviewTaskWorkspaceSnapshot | null {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId) {
		return null;
	}
	return workspaceMetadataState.taskWorkspaceSnapshotByTaskId[normalizedTaskId] ?? null;
}

export function getTaskWorkspaceChangeRevision(taskId: string | null | undefined): number {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId) {
		return 0;
	}
	return workspaceMetadataState.taskChangeRevisionByTaskId[normalizedTaskId] ?? 0;
}

export function setTaskWorkspaceSnapshot(snapshot: ReviewTaskWorkspaceSnapshot | null): boolean {
	if (!snapshot) {
		return false;
	}
	const existing = workspaceMetadataState.taskWorkspaceSnapshotByTaskId[snapshot.taskId] ?? null;
	if (areTaskWorkspaceSnapshotsEqual(existing, snapshot)) {
		return false;
	}
	workspaceMetadataState.taskWorkspaceSnapshotByTaskId = {
		...workspaceMetadataState.taskWorkspaceSnapshotByTaskId,
		[snapshot.taskId]: snapshot,
	};
	emitTaskMetadata(snapshot.taskId);
	return true;
}

export function clearTaskWorkspaceSnapshot(taskId: string | null | undefined): boolean {
	const normalizedTaskId = taskId?.trim();
	if (!normalizedTaskId || !(normalizedTaskId in workspaceMetadataState.taskWorkspaceSnapshotByTaskId)) {
		return false;
	}
	const { [normalizedTaskId]: _removed, ...rest } = workspaceMetadataState.taskWorkspaceSnapshotByTaskId;
	workspaceMetadataState.taskWorkspaceSnapshotByTaskId = rest;
	workspaceMetadataState.taskChangeRevisionByTaskId = {
		...workspaceMetadataState.taskChangeRevisionByTaskId,
		[normalizedTaskId]: (workspaceMetadataState.taskChangeRevisionByTaskId[normalizedTaskId] ?? 0) + 1,
	};
	emitTaskMetadata(normalizedTaskId);
	return true;
}

export function clearInactiveTaskWorkspaceSnapshots(activeTaskIds: Set<string>): void {
	let changed = false;
	const nextSnapshots: Record<string, ReviewTaskWorkspaceSnapshot | null> = {};
	const nextTaskChangeRevisions: Record<string, number> = {};
	for (const [taskId, snapshot] of Object.entries(workspaceMetadataState.taskWorkspaceSnapshotByTaskId)) {
		if (!activeTaskIds.has(taskId)) {
			changed = true;
			continue;
		}
		nextSnapshots[taskId] = snapshot;
		nextTaskChangeRevisions[taskId] = workspaceMetadataState.taskChangeRevisionByTaskId[taskId] ?? 0;
	}
	if (!changed) {
		return;
	}
	workspaceMetadataState.taskWorkspaceSnapshotByTaskId = nextSnapshots;
	workspaceMetadataState.taskChangeRevisionByTaskId = nextTaskChangeRevisions;
	for (const taskId of taskMetadataListenersByTaskId.keys()) {
		if (!activeTaskIds.has(taskId)) {
			emitTaskMetadata(taskId);
		}
	}
}

export function applyWorkspaceGitStatusUpdate(input: {
	homeSummary: RuntimeGitSyncSummary;
	homeChangeRevision: number;
	tasks: RuntimeTaskGitStatus[];
}): void {
	let homeChanged = false;
	if (
		!areGitSummariesEqual(workspaceMetadataState.homeGitSummary, input.homeSummary) ||
		workspaceMetadataState.homeChangeRevision !== input.homeChangeRevision
	) {
		workspaceMetadataState.homeGitSummary = input.homeSummary;
		workspaceMetadataState.homeChangeRevision = input.homeChangeRevision;
		homeChanged = true;
	}

	const existingTaskIds = new Set([
		...Object.keys(workspaceMetadataState.taskWorkspaceInfoByTaskId),
		...Object.keys(workspaceMetadataState.taskWorkspaceSnapshotByTaskId),
		...Object.keys(workspaceMetadataState.taskChangeRevisionByTaskId),
	]);
	const nextTaskIds = new Set(input.tasks.map((task) => task.taskId));
	const changedTaskIds = new Set<string>();

	let nextInfoByTaskId = workspaceMetadataState.taskWorkspaceInfoByTaskId;
	let nextSnapshotsByTaskId = workspaceMetadataState.taskWorkspaceSnapshotByTaskId;
	let nextRevisionsByTaskId = workspaceMetadataState.taskChangeRevisionByTaskId;

	for (const taskId of existingTaskIds) {
		if (nextTaskIds.has(taskId)) {
			continue;
		}
		if (taskId in nextInfoByTaskId) {
			const { [taskId]: _removed, ...rest } = nextInfoByTaskId;
			nextInfoByTaskId = rest;
		}
		if (taskId in nextSnapshotsByTaskId) {
			const { [taskId]: _removed, ...rest } = nextSnapshotsByTaskId;
			nextSnapshotsByTaskId = rest;
		}
		if (taskId in nextRevisionsByTaskId) {
			const { [taskId]: _removed, ...rest } = nextRevisionsByTaskId;
			nextRevisionsByTaskId = rest;
		}
		changedTaskIds.add(taskId);
	}

	for (const task of input.tasks) {
		const nextInfo: RuntimeTaskWorkspaceInfoResponse = {
			taskId: task.taskId,
			path: task.path,
			exists: task.exists,
			baseRef: task.baseRef,
			branch: task.branch,
			isDetached: task.isDetached,
			headCommit: task.headCommit,
		};
		const nextSnapshot: ReviewTaskWorkspaceSnapshot = {
			taskId: task.taskId,
			path: task.path,
			branch: task.branch,
			isDetached: task.isDetached,
			headCommit: task.headCommit,
			changedFiles: task.changedFiles,
			additions: task.additions,
			deletions: task.deletions,
		};

		const previousInfo = nextInfoByTaskId[task.taskId] ?? null;
		const previousSnapshot = nextSnapshotsByTaskId[task.taskId] ?? null;
		const previousRevision = nextRevisionsByTaskId[task.taskId] ?? 0;

		if (!areTaskWorkspaceInfosEqual(previousInfo, nextInfo)) {
			nextInfoByTaskId = {
				...nextInfoByTaskId,
				[task.taskId]: nextInfo,
			};
			changedTaskIds.add(task.taskId);
		}

		if (!areTaskWorkspaceSnapshotsEqual(previousSnapshot, nextSnapshot)) {
			nextSnapshotsByTaskId = {
				...nextSnapshotsByTaskId,
				[task.taskId]: nextSnapshot,
			};
			changedTaskIds.add(task.taskId);
		}

		if (previousRevision !== task.changeRevision) {
			nextRevisionsByTaskId = {
				...nextRevisionsByTaskId,
				[task.taskId]: task.changeRevision,
			};
			changedTaskIds.add(task.taskId);
		}
	}

	workspaceMetadataState.taskWorkspaceInfoByTaskId = nextInfoByTaskId;
	workspaceMetadataState.taskWorkspaceSnapshotByTaskId = nextSnapshotsByTaskId;
	workspaceMetadataState.taskChangeRevisionByTaskId = nextRevisionsByTaskId;

	if (homeChanged) {
		emitHomeGitSummary();
	}

	for (const taskId of changedTaskIds) {
		emitTaskMetadata(taskId);
	}
}

export function resetWorkspaceMetadataStore(): void {
	const taskIds = new Set([
		...Object.keys(workspaceMetadataState.taskWorkspaceInfoByTaskId),
		...Object.keys(workspaceMetadataState.taskWorkspaceSnapshotByTaskId),
		...Object.keys(workspaceMetadataState.taskChangeRevisionByTaskId),
	]);
	workspaceMetadataState.homeGitSummary = null;
	workspaceMetadataState.homeChangeRevision = 0;
	workspaceMetadataState.taskWorkspaceInfoByTaskId = {};
	workspaceMetadataState.taskWorkspaceSnapshotByTaskId = {};
	workspaceMetadataState.taskChangeRevisionByTaskId = {};
	emitHomeGitSummary();
	for (const taskId of taskIds) {
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
		() => workspaceMetadataState.homeGitSummary,
		() => null,
	);
}

export function useHomeGitChangeRevisionValue(): number {
	return useSyncExternalStore(
		(listener) => {
			homeGitSummaryListeners.add(listener);
			return () => {
				homeGitSummaryListeners.delete(listener);
			};
		},
		() => workspaceMetadataState.homeChangeRevision,
		() => 0,
	);
}

export function useTaskWorkspaceInfoValue(
	taskId: string | null | undefined,
	baseRef?: string | null,
): RuntimeTaskWorkspaceInfoResponse | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => getTaskWorkspaceInfo(normalizedTaskId, baseRef),
		() => null,
	);
}

export function useTaskWorkspaceSnapshotValue(taskId: string | null | undefined): ReviewTaskWorkspaceSnapshot | null {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => getTaskWorkspaceSnapshot(normalizedTaskId),
		() => null,
	);
}

export function useTaskWorkspaceChangeRevisionValue(taskId: string | null | undefined): number {
	const normalizedTaskId = taskId?.trim() ?? "";
	return useSyncExternalStore(
		(listener) => {
			if (!normalizedTaskId) {
				return () => {};
			}
			return subscribeToTaskId(normalizedTaskId, listener);
		},
		() => getTaskWorkspaceChangeRevision(normalizedTaskId),
		() => 0,
	);
}
