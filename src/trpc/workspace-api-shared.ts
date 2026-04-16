import { resolve } from "node:path";
import type {
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitMergeResponse,
	RuntimeWorkspaceChangesMode,
} from "../core/api-contract";
import type { IRuntimeBroadcaster, ITerminalManagerProvider, IWorkspaceDataProvider } from "../core/service-interfaces";
import { loadWorkspaceState } from "../state/workspace-state";
import { isMissingTaskWorktreeError, resolveTaskWorkingDirectory } from "../workspace/task-worktree";

// ── Dependencies ────────────────────────────────────────────────────────────────

export interface CreateWorkspaceApiDependencies {
	terminals: ITerminalManagerProvider;
	broadcaster: Pick<
		IRuntimeBroadcaster,
		| "broadcastRuntimeWorkspaceStateUpdated"
		| "broadcastRuntimeProjectsUpdated"
		| "broadcastTaskTitleUpdated"
		| "setFocusedTask"
		| "requestTaskRefresh"
		| "requestHomeRefresh"
	>;
	data: Pick<IWorkspaceDataProvider, "buildWorkspaceStateSnapshot">;
}

// ── Shared context ──────────────────────────────────────────────────────────────

export interface WorkspaceApiContext {
	deps: CreateWorkspaceApiDependencies;
	broadcastStateUpdate: (scope: { workspaceId: string; workspacePath: string }) => void;
	refreshGitMetadata: (scope: { workspaceId: string }, taskScope: { taskId: string; baseRef: string } | null) => void;
}

export function createWorkspaceApiContext(deps: CreateWorkspaceApiDependencies): WorkspaceApiContext {
	const broadcastStateUpdate = (scope: { workspaceId: string; workspacePath: string }) => {
		void deps.broadcaster.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath);
	};

	const refreshGitMetadata = (
		scope: { workspaceId: string },
		taskScope: { taskId: string; baseRef: string } | null,
	) => {
		if (taskScope) {
			deps.broadcaster.requestTaskRefresh(scope.workspaceId, taskScope.taskId);
		} else {
			deps.broadcaster.requestHomeRefresh(scope.workspaceId);
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
	workspacePath: string,
	taskScope: { taskId: string; baseRef: string } | null,
): Promise<string> {
	if (!taskScope) return workspacePath;
	return await resolveTaskWorkingDirectory({ workspacePath, ...taskScope });
}

export async function tryResolveTaskCwd(
	workspacePath: string,
	taskId: string,
	baseRef: string,
): Promise<string | null> {
	try {
		return await resolveTaskWorkingDirectory({ workspacePath, taskId, baseRef });
	} catch (error) {
		if (isMissingTaskWorktreeError(error)) return null;
		throw error;
	}
}

export async function hasActiveSharedCheckoutTask(workspacePath: string): Promise<boolean> {
	const state = await loadWorkspaceState(workspacePath);
	const activeColumnIds = new Set(["in_progress", "review"]);
	return state.board.columns
		.filter((col) => activeColumnIds.has(col.id))
		.some((col) =>
			col.cards.some((card) => {
				const isSharedCheckout = card.workingDirectory
					? resolve(card.workingDirectory) === resolve(workspacePath)
					: card.useWorktree === false;
				return isSharedCheckout;
			}),
		);
}

// ── Input normalization ─────────────────────────────────────────────────────────

export function normalizeOptionalTaskWorkspaceScopeInput(
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

export function normalizeRequiredTaskWorkspaceScopeInput(input: {
	taskId: string | null;
	baseRef?: string;
	mode?: RuntimeWorkspaceChangesMode;
}): {
	taskId: string;
	baseRef: string;
	mode: RuntimeWorkspaceChangesMode;
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
