import { resolve } from "node:path";
import type {
	IProjectDataProvider,
	IRuntimeBroadcaster,
	ITerminalManagerProvider,
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitMergeResponse,
	RuntimeWorkdirChangesMode,
} from "../core";
import { loadProjectState } from "../state";
import { isMissingTaskWorktreeError, resolveTaskWorkingDirectory } from "../workdir";

// ── Dependencies ────────────────────────────────────────────────────────────────

export interface CreateProjectApiDependencies {
	terminals: ITerminalManagerProvider;
	broadcaster: Pick<
		IRuntimeBroadcaster,
		| "broadcastRuntimeProjectStateUpdated"
		| "broadcastRuntimeProjectsUpdated"
		| "broadcastTaskTitleUpdated"
		| "setFocusedTask"
		| "requestTaskRefresh"
		| "requestHomeRefresh"
	>;
	data: Pick<IProjectDataProvider, "buildProjectStateSnapshot">;
}

// ── Shared context ──────────────────────────────────────────────────────────────

export interface ProjectApiContext {
	deps: CreateProjectApiDependencies;
	broadcastStateUpdate: (scope: { projectId: string; projectPath: string }) => void;
	refreshGitMetadata: (scope: { projectId: string }, taskScope: { taskId: string; baseRef: string } | null) => void;
}

export function createProjectApiContext(deps: CreateProjectApiDependencies): ProjectApiContext {
	const broadcastStateUpdate = (scope: { projectId: string; projectPath: string }) => {
		void deps.broadcaster.broadcastRuntimeProjectStateUpdated(scope.projectId, scope.projectPath);
	};

	const refreshGitMetadata = (scope: { projectId: string }, taskScope: { taskId: string; baseRef: string } | null) => {
		if (taskScope) {
			deps.broadcaster.requestTaskRefresh(scope.projectId, taskScope.taskId);
		} else {
			deps.broadcaster.requestHomeRefresh(scope.projectId);
		}
	};

	return { deps, broadcastStateUpdate, refreshGitMetadata };
}

// ── Constants ───────────────────────────────────────────────────────────────────

export const EMPTY_GIT_SUMMARY = {
	currentBranch: null,
	upstreamBranch: null,
	changedFiles: 0,
	additions: 0,
	deletions: 0,
	aheadCount: 0,
	behindCount: 0,
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────────

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function resolveWorkingDir(
	projectPath: string,
	taskScope: { taskId: string; baseRef: string } | null,
): Promise<string> {
	if (!taskScope) return projectPath;
	return await resolveTaskWorkingDirectory({ projectPath, ...taskScope });
}

export async function tryResolveTaskCwd(projectPath: string, taskId: string, baseRef: string): Promise<string | null> {
	try {
		return await resolveTaskWorkingDirectory({ projectPath, taskId, baseRef });
	} catch (error) {
		if (isMissingTaskWorktreeError(error)) return null;
		throw error;
	}
}

export async function hasActiveSharedCheckoutTask(projectPath: string): Promise<boolean> {
	const state = await loadProjectState(projectPath);
	const activeColumnIds = new Set(["in_progress", "review"]);
	return state.board.columns
		.filter((col) => activeColumnIds.has(col.id))
		.some((col) =>
			col.cards.some((card) => {
				const isSharedCheckout = card.workingDirectory
					? resolve(card.workingDirectory) === resolve(projectPath)
					: card.useWorktree === false;
				return isSharedCheckout;
			}),
		);
}

// ── Input normalization ─────────────────────────────────────────────────────────

export function normalizeOptionalTaskScopeInput(
	input: { taskId: string; baseRef: string } | null,
): { taskId: string; baseRef: string } | null {
	if (!input) return null;
	const taskId = input.taskId.trim();
	const baseRef = input.baseRef.trim();
	if (!taskId || !baseRef) {
		throw new Error("baseRef query parameter requires taskId.");
	}
	return { taskId, baseRef };
}

export function normalizeRequiredTaskScopeInput(input: {
	taskId: string | null;
	baseRef?: string;
	mode?: RuntimeWorkdirChangesMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkdirChangesMode;
} {
	const taskId = (input.taskId ?? "").trim();
	const baseRef = (input.baseRef ?? "").trim();
	if (!taskId) throw new Error("Missing taskId query parameter.");
	if (!baseRef) throw new Error("Missing baseRef query parameter.");
	return { taskId, baseRef, mode: input.mode ?? "working_copy" };
}

// ── Error response factories ────────────────────────────────────────────────────

export function createGitBranchErrorResponse(error: unknown): RuntimeGitCheckoutResponse & RuntimeGitMergeResponse {
	return { ok: false, branch: "", summary: { ...EMPTY_GIT_SUMMARY }, output: "", error: errorMessage(error) };
}

export function createGitOutputErrorResponse(error: unknown): RuntimeGitDiscardResponse & RuntimeGitCommitResponse {
	return { ok: false, summary: { ...EMPTY_GIT_SUMMARY }, output: "", error: errorMessage(error) };
}
