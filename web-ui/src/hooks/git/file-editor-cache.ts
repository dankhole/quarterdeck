import type { RuntimeProjectMetadata, RuntimeProjectStateResponse, RuntimeProjectSummary } from "@/runtime/types";
import {
	type FileEditorRecoveryProblem,
	type FileEditorRecoveryRecord,
	sameFileEditorRecoveryScope,
} from "./file-editor-recovery";
import type { FileEditorTab } from "./file-editor-workspace";

export interface FileEditorScopeIdentity {
	readonly projectId: string | null;
	readonly taskId: string | null;
	readonly taskCreatedAt?: number;
	readonly rootPath?: string | null;
}

export interface FileEditorScopeTarget {
	readonly projectId: string;
	/** When present, target exactly one live worktree, including the home repository. */
	readonly taskId?: string | null;
	readonly tasks?: readonly { readonly taskId: string; readonly taskCreatedAt: number }[];
}

export interface FileEditorDraft {
	readonly id: string;
	readonly scopeKey: string;
	readonly generation: number;
	readonly scope: FileEditorScopeIdentity;
	readonly tab: FileEditorTab;
	readonly detached: boolean;
	readonly recovered?: boolean;
	readonly recoveryId?: string;
}

interface CachedWorkspace {
	readonly generation: number;
	scope: FileEditorScopeIdentity;
	tabs: FileEditorTab[];
}

const emptyTabs: FileEditorTab[] = [];
const workspaces = new Map<string, CachedWorkspace>();
const unavailableWorktrees = new Map<string, FileEditorScopeIdentity>();
const detachedDrafts = new Map<string, FileEditorDraft>();
const listeners = new Set<() => void>();
let revision = 0;
let nextDraftId = 0;
let nextGeneration = 0;
const recoverySessionId = crypto.randomUUID();
export type FileEditorReviewTarget = FileEditorScopeTarget | "detached" | "all" | null;
let reviewTarget: FileEditorReviewTarget = null;
let recoveryProblem: FileEditorRecoveryProblem | null = null;
let expiredRecoveryCount = 0;
let recoveryWritesPaused = false;
let recoveryCommitPending = false;
let recoveryCommitBusy = false;

export function getFileEditorRecoveryStatus(): {
	problem: FileEditorRecoveryProblem | null;
	expired: number;
	paused: boolean;
	pending: boolean;
	busy: boolean;
} {
	return {
		problem: recoveryProblem,
		expired: expiredRecoveryCount,
		paused: recoveryWritesPaused,
		pending: recoveryCommitPending,
		busy: recoveryCommitBusy,
	};
}

export function setFileEditorRecoveryStatus(
	problem: FileEditorRecoveryProblem | null,
	expired = expiredRecoveryCount,
	paused = false,
	pending = false,
	busy = false,
): void {
	if (
		recoveryProblem === problem &&
		expiredRecoveryCount === expired &&
		recoveryWritesPaused === paused &&
		recoveryCommitPending === pending &&
		recoveryCommitBusy === busy
	)
		return;
	recoveryProblem = problem;
	expiredRecoveryCount = expired;
	recoveryWritesPaused = paused;
	recoveryCommitPending = pending;
	recoveryCommitBusy = busy;
	changed();
}

export function hydrateFileEditorRecovery(records: readonly FileEditorRecoveryRecord[]): void {
	for (const record of records) {
		const id = `recovered:${record.id}`;
		if (detachedDrafts.has(id)) continue;
		detachedDrafts.set(id, {
			id,
			recoveryId: record.id,
			recovered: true,
			scopeKey: record.scopeKey,
			generation: 0,
			scope: record.scope,
			tab: { ...record.tab, isSaving: false, error: null, recoveryRequiresSave: true, recoveryId: record.id },
			detached: true,
		});
	}
	if (records.length > 0) reviewTarget = "detached";
	changed();
}

/** Restoration changes the local editor only; the normal explicit Save retains its revision check. */
export function canRestoreFileEditorDraft(draft: FileEditorDraft): boolean {
	const current = detachedDrafts.get(draft.id);
	const workspace = workspaces.get(draft.scopeKey);
	return (
		!!current &&
		current.tab.value === draft.tab.value &&
		!!workspace &&
		sameFileEditorRecoveryScope(workspace.scope, draft.scope) &&
		!workspace.tabs.some((tab) => tab.path === draft.tab.path && isProtected(tab))
	);
}

export function restoreFileEditorDraft(draft: FileEditorDraft): boolean {
	if (!canRestoreFileEditorDraft(draft)) return false;
	const workspace = workspaces.get(draft.scopeKey);
	if (!workspace) return false;
	const tab = { ...draft.tab, isSaving: false, error: null, recoveryRequiresSave: true };
	workspace.tabs = [...workspace.tabs.filter((candidate) => candidate.path !== tab.path), tab];
	detachedDrafts.delete(draft.id);
	changed();
	return true;
}

function changed(): void {
	revision++;
	for (const listener of listeners) listener();
}

function isProtected(tab: FileEditorTab): boolean {
	return tab.value !== tab.savedValue || tab.isSaving;
}

function matches(scope: FileEditorScopeIdentity, target: FileEditorScopeTarget): boolean {
	return (
		scope.projectId === target.projectId &&
		(target.taskId === undefined || scope.taskId === target.taskId) &&
		(!target.tasks ||
			target.tasks.some(
				(task) =>
					task.taskId === scope.taskId &&
					(scope.taskCreatedAt === undefined || scope.taskCreatedAt === task.taskCreatedAt),
			))
	);
}

export function subscribeFileEditorCache(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getFileEditorCacheRevision(): number {
	return revision;
}

export function registerFileEditorScope(scopeKey: string, scope: FileEditorScopeIdentity): void {
	const existing = workspaces.get(scopeKey);
	if (existing) {
		if (JSON.stringify(existing.scope) === JSON.stringify(scope)) return;
		if (retireWorkspace(scopeKey, existing)) reviewTarget = "detached";
	}
	workspaces.set(scopeKey, { scope, tabs: [], generation: ++nextGeneration });
	changed();
}

export function getCachedFileEditorTabs(scopeKey: string): FileEditorTab[] {
	return workspaces.get(scopeKey)?.tabs ?? emptyTabs;
}

export function setCachedFileEditorTabs(scopeKey: string, tabs: readonly FileEditorTab[]): void {
	const existing = workspaces.get(scopeKey);
	workspaces.set(scopeKey, {
		scope: existing?.scope ?? { projectId: null, taskId: null },
		tabs: [...tabs],
		generation: existing?.generation ?? ++nextGeneration,
	});
	changed();
}

export function getFileEditorScopeGeneration(scopeKey: string): number | undefined {
	return workspaces.get(scopeKey)?.generation;
}

export function updateCachedFileEditorTabs(
	scopeKey: string,
	updater: (tabs: FileEditorTab[]) => FileEditorTab[],
	generation: number | undefined,
): void {
	const workspace = workspaces.get(scopeKey);
	if (!workspace || workspace.generation !== generation) return;
	workspace.tabs = updater(workspace.tabs);
	changed();
}

export function clearCachedFileEditorTabs(scopeKey?: string): void {
	if (scopeKey !== undefined) {
		workspaces.delete(scopeKey);
		unavailableWorktrees.delete(scopeKey);
	} else {
		workspaces.clear();
		unavailableWorktrees.clear();
		detachedDrafts.clear();
		reviewTarget = null;
	}
	changed();
}

export function hasDirtyCachedFileEditorTabs(): boolean {
	return detachedDrafts.size > 0 || [...workspaces.values()].some(({ tabs }) => tabs.some(isProtected));
}

export function getFileEditorDrafts(target: FileEditorReviewTarget = reviewTarget): FileEditorDraft[] {
	const result = [...detachedDrafts.values()].filter(
		(draft) => !target || target === "detached" || target === "all" || matches(draft.scope, target),
	);
	if (target === "detached") return result;
	for (const [scopeKey, workspace] of workspaces) {
		if (target && target !== "all" && !matches(workspace.scope, target)) continue;
		for (const tab of workspace.tabs) {
			if (isProtected(tab))
				result.push({
					id: JSON.stringify([scopeKey, workspace.generation, tab.path]),
					generation: workspace.generation,
					scopeKey,
					scope: workspace.scope,
					tab,
					detached: false,
					recoveryId:
						tab.recoveryId ?? JSON.stringify([recoverySessionId, scopeKey, workspace.generation, tab.path]),
				});
		}
	}
	return result;
}

/** Every destructive caller checks current drafts immediately before dispatch. */
export function guardFileEditorScopes(target: FileEditorScopeTarget, options?: { includeDetached?: boolean }): boolean {
	const drafts = getFileEditorDrafts(target);
	if (!drafts.some((draft) => options?.includeDetached !== false || !draft.detached)) return true;
	reviewTarget = target;
	changed();
	return false;
}

export function getFileEditorReviewTarget(): FileEditorReviewTarget {
	return reviewTarget;
}
export function setFileEditorReviewTarget(target: FileEditorReviewTarget): void {
	reviewTarget = target;
	changed();
}

export function discardFileEditorDraft(draft: FileEditorDraft): void {
	if (draft.tab.isSaving) return;
	if (draft.detached) {
		if (detachedDrafts.get(draft.id)?.tab.value !== draft.tab.value) return;
		detachedDrafts.delete(draft.id);
	} else {
		const workspace = workspaces.get(draft.scopeKey);
		if (!workspace || workspace.generation !== draft.generation) return;
		// A confirmation only discards the exact version that was presented.
		workspace.tabs = workspace.tabs.map((tab) =>
			tab.path === draft.tab.path && tab.value === draft.tab.value && !tab.isSaving
				? { ...tab, value: tab.savedValue, error: null }
				: tab,
		);
	}
	changed();
}

function retireWorkspace(scopeKey: string, workspace: CachedWorkspace): boolean {
	let retained = false;
	for (const tab of workspace.tabs) {
		if (!isProtected(tab)) continue;
		const id = `detached-${++nextDraftId}`;
		detachedDrafts.set(id, {
			id,
			scopeKey,
			generation: workspace.generation,
			scope: workspace.scope,
			tab: { ...tab, isSaving: false },
			detached: true,
			recoveryId: tab.recoveryId ?? JSON.stringify([recoverySessionId, scopeKey, workspace.generation, tab.path]),
		});
		retained = true;
	}
	workspaces.delete(scopeKey);
	return retained;
}

export function retireFileEditorScopes(target: FileEditorScopeTarget): void {
	for (const [key, scope] of unavailableWorktrees) if (matches(scope, target)) unavailableWorktrees.delete(key);
	let retired = false;
	let retained = false;
	for (const [key, workspace] of workspaces) {
		if (!matches(workspace.scope, target)) continue;
		retained = retireWorkspace(key, workspace) || retained;
		retired = true;
	}
	if (retained) reviewTarget = "detached";
	if (retired) changed();
}

/** Project lists are complete; task/worktree snapshots are scoped to one project. */
export function reconcileFileEditorProjects(projects: readonly RuntimeProjectSummary[]): void {
	const projectIds = new Set(projects.map((project) => project.id));
	const unavailableProjectIds = new Set(
		projects.filter((project) => project.availability?.status === "unavailable").map((project) => project.id),
	);
	for (const [key, scope] of unavailableWorktrees)
		if (scope.projectId && !projectIds.has(scope.projectId)) unavailableWorktrees.delete(key);
	for (const workspace of [...workspaces.values()]) {
		const project = projects.find((project) => project.id === workspace.scope.projectId);
		const movedHome =
			project &&
			workspace.scope.taskId === null &&
			workspace.scope.rootPath &&
			workspace.scope.rootPath !== project.path;
		if (
			workspace.scope.projectId &&
			(!projectIds.has(workspace.scope.projectId) ||
				unavailableProjectIds.has(workspace.scope.projectId) ||
				movedHome)
		) {
			retireFileEditorScopes({ projectId: workspace.scope.projectId });
		}
	}
}

export function reconcileFileEditorProjectState(projectId: string, state: RuntimeProjectStateResponse): void {
	if (state.availability?.status === "unavailable") {
		retireFileEditorScopes({ projectId });
		return;
	}
	const liveTasks = new Map(
		state.board.columns
			.flatMap((column) => (column.id === "trash" ? [] : column.cards))
			.map((task) => [task.id, task]),
	);
	for (const [key, scope] of unavailableWorktrees) {
		if (scope.projectId !== projectId || !scope.taskId) continue;
		const task = liveTasks.get(scope.taskId);
		if (!task || (scope.taskCreatedAt !== undefined && scope.taskCreatedAt !== task.createdAt))
			unavailableWorktrees.delete(key);
	}
	let retired = false;
	let retained = false;
	for (const [key, workspace] of workspaces) {
		const { scope } = workspace;
		if (scope.projectId !== projectId) continue;
		if (!scope.taskId) {
			if (scope.rootPath && scope.rootPath !== state.repoPath) {
				retained = retireWorkspace(key, workspace) || retained;
				retired = true;
			}
			continue;
		}
		const task = liveTasks.get(scope.taskId);
		if (task && (scope.taskCreatedAt === undefined || scope.taskCreatedAt === task.createdAt)) continue;
		retained = retireWorkspace(key, workspace) || retained;
		retired = true;
	}
	if (retained) reviewTarget = "detached";
	if (retired) changed();
}

export function reconcileFileEditorWorktrees(projectId: string, metadata: RuntimeProjectMetadata): void {
	for (const [key, scope] of unavailableWorktrees) {
		if (scope.projectId !== projectId) continue;
		const worktree = metadata.taskWorktrees.find((candidate) => candidate.taskId === scope.taskId);
		if (!worktree?.exists || (scope.rootPath && scope.rootPath !== worktree.path)) continue;
		unavailableWorktrees.delete(key);
		registerFileEditorScope(key, scope);
	}
	let retired = false;
	let retained = false;
	for (const [key, workspace] of workspaces) {
		const { scope } = workspace;
		if (scope.projectId !== projectId || !scope.taskId) continue;
		const worktree = metadata.taskWorktrees.find((candidate) => candidate.taskId === scope.taskId);
		// Absence can mean metadata is loading. Only an explicit missing/replaced worktree retires a scope.
		if (!worktree || (worktree.exists && (!scope.rootPath || scope.rootPath === worktree.path))) continue;
		if (!worktree.exists) unavailableWorktrees.set(key, scope);
		retained = retireWorkspace(key, workspace) || retained;
		retired = true;
	}
	if (retained) reviewTarget = "detached";
	if (retired) changed();
}
