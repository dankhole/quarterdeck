import type { RuntimeProjectMetadata, RuntimeProjectStateResponse, RuntimeProjectSummary } from "@/runtime/types";
import type { FileEditorTab } from "./file-editor-workspace";

export interface FileEditorScopeIdentity {
	readonly projectId: string | null;
	readonly taskId: string | null;
	readonly taskCreatedAt?: number;
	readonly rootPath?: string | null;
}

export interface FileEditorScopeTarget {
	readonly projectId: string;
	readonly tasks?: readonly { readonly taskId: string; readonly taskCreatedAt: number }[];
}

export interface FileEditorDraft {
	readonly id: string;
	readonly scopeKey: string;
	readonly generation: number;
	readonly scope: FileEditorScopeIdentity;
	readonly tab: FileEditorTab;
	readonly detached: boolean;
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
let reviewTarget: FileEditorScopeTarget | "detached" | null = null;

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

export function getFileEditorDrafts(
	target: FileEditorScopeTarget | "detached" | null = reviewTarget,
): FileEditorDraft[] {
	const result = [...detachedDrafts.values()].filter(
		(draft) => !target || target === "detached" || matches(draft.scope, target),
	);
	if (target === "detached") return result;
	for (const [scopeKey, workspace] of workspaces) {
		if (target && !matches(workspace.scope, target)) continue;
		for (const tab of workspace.tabs) {
			if (isProtected(tab))
				result.push({
					id: JSON.stringify([scopeKey, workspace.generation, tab.path]),
					generation: workspace.generation,
					scopeKey,
					scope: workspace.scope,
					tab,
					detached: false,
				});
		}
	}
	return result;
}

/** Every destructive caller checks current drafts immediately before dispatch. */
export function guardFileEditorScopes(target: FileEditorScopeTarget): boolean {
	if (getFileEditorDrafts(target).length === 0) return true;
	reviewTarget = target;
	changed();
	return false;
}

export function getFileEditorReviewTarget(): FileEditorScopeTarget | "detached" | null {
	return reviewTarget;
}
export function setFileEditorReviewTarget(target: FileEditorScopeTarget | "detached" | null): void {
	reviewTarget = target;
	changed();
}

export function discardFileEditorDraft(draft: FileEditorDraft): void {
	if (draft.tab.isSaving) return;
	if (draft.detached) detachedDrafts.delete(draft.id);
	else {
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
	for (const [key, scope] of unavailableWorktrees)
		if (scope.projectId && !projectIds.has(scope.projectId)) unavailableWorktrees.delete(key);
	for (const workspace of [...workspaces.values()]) {
		if (workspace.scope.projectId && !projectIds.has(workspace.scope.projectId)) {
			retireFileEditorScopes({ projectId: workspace.scope.projectId });
		}
	}
}

export function reconcileFileEditorProjectState(projectId: string, state: RuntimeProjectStateResponse): void {
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
		if (scope.projectId !== projectId || !scope.taskId) continue;
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
