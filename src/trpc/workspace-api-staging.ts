import { resolve } from "node:path";
import type {
	RuntimeStashDropResponse,
	RuntimeStashListResponse,
	RuntimeStashPopApplyResponse,
	RuntimeStashPushResponse,
	RuntimeStashShowResponse,
} from "../core";
import {
	commitSelectedFiles,
	discardGitChanges,
	discardSingleFile,
	runGitSyncAction,
	stashApply,
	stashDrop,
	stashList,
	stashPop,
	stashPush,
	stashShow,
} from "../workspace";
import type { RuntimeTrpcContext } from "./app-router-context";
import {
	createGitOutputErrorResponse,
	errorMessage,
	normalizeOptionalTaskWorkspaceScopeInput,
	resolveWorkingDir,
	type WorkspaceApiContext,
} from "./workspace-api-shared";

type StagingOps = Pick<
	RuntimeTrpcContext["workspaceApi"],
	| "discardGitChanges"
	| "commitSelectedFiles"
	| "discardFile"
	| "stashPush"
	| "stashList"
	| "stashPop"
	| "stashApply"
	| "stashDrop"
	| "stashShow"
>;

export function createStagingOps(ctx: WorkspaceApiContext): StagingOps {
	return {
		discardGitChanges: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input);
				const cwd = await resolveWorkingDir(workspaceScope.workspacePath, taskScope);
				if (taskScope && resolve(cwd) === resolve(workspaceScope.workspacePath)) {
					return createGitOutputErrorResponse(
						new Error("Cannot discard changes in the shared checkout. Isolate the task to a worktree first."),
					);
				}
				const response = await discardGitChanges({ cwd });
				if (response.ok) ctx.refreshGitMetadata(workspaceScope, taskScope);
				return response;
			} catch (error) {
				return createGitOutputErrorResponse(error);
			}
		},

		commitSelectedFiles: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope);
				const commitCwd = await resolveWorkingDir(workspaceScope.workspacePath, taskScope);
				if (taskScope && resolve(commitCwd) === resolve(workspaceScope.workspacePath)) {
					return createGitOutputErrorResponse(
						new Error("Cannot commit in the shared checkout. Isolate the task to a worktree first."),
					);
				}
				const response = await commitSelectedFiles({
					cwd: commitCwd,
					paths: input.paths,
					message: input.message,
				});
				if (response.ok) {
					if (input.pushAfterCommit) {
						const pushResult = await runGitSyncAction({ cwd: commitCwd, action: "push" });
						ctx.refreshGitMetadata(workspaceScope, taskScope);
						return {
							...response,
							pushOk: pushResult.ok,
							...(!pushResult.ok && { pushError: pushResult.error ?? "Push failed." }),
							summary: pushResult.summary,
						};
					}
					ctx.refreshGitMetadata(workspaceScope, taskScope);
				}
				return response;
			} catch (error) {
				return createGitOutputErrorResponse(error);
			}
		},

		discardFile: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(workspaceScope.workspacePath, taskScope);
				if (taskScope && resolve(cwd) === resolve(workspaceScope.workspacePath)) {
					return createGitOutputErrorResponse(
						new Error("Cannot discard changes in the shared checkout. Isolate the task to a worktree first."),
					);
				}
				const response = await discardSingleFile({
					cwd,
					path: input.path,
					fileStatus: input.fileStatus,
				});
				if (response.ok) ctx.refreshGitMetadata(workspaceScope, taskScope);
				return response;
			} catch (error) {
				return createGitOutputErrorResponse(error);
			}
		},

		stashPush: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(workspaceScope.workspacePath, taskScope);
				const response = await stashPush({ cwd, paths: input.paths, message: input.message });
				if (response.ok) ctx.refreshGitMetadata(workspaceScope, taskScope);
				return response;
			} catch (error) {
				return { ok: false, error: errorMessage(error) } satisfies RuntimeStashPushResponse;
			}
		},

		stashList: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					normalizeOptionalTaskWorkspaceScopeInput(input.taskScope),
				);
				return await stashList(cwd);
			} catch (error) {
				return { ok: false, entries: [], error: errorMessage(error) } satisfies RuntimeStashListResponse;
			}
		},

		stashPop: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(workspaceScope.workspacePath, taskScope);
				const response = await stashPop({ cwd, index: input.index });
				if (response.ok || response.conflicted) ctx.refreshGitMetadata(workspaceScope, taskScope);
				return response;
			} catch (error) {
				return { ok: false, conflicted: false, error: errorMessage(error) } satisfies RuntimeStashPopApplyResponse;
			}
		},

		stashApply: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(workspaceScope.workspacePath, taskScope);
				const response = await stashApply({ cwd, index: input.index });
				if (response.ok || response.conflicted) ctx.refreshGitMetadata(workspaceScope, taskScope);
				return response;
			} catch (error) {
				return { ok: false, conflicted: false, error: errorMessage(error) } satisfies RuntimeStashPopApplyResponse;
			}
		},

		stashDrop: async (workspaceScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskWorkspaceScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(workspaceScope.workspacePath, taskScope);
				const response = await stashDrop({ cwd, index: input.index });
				if (response.ok) ctx.refreshGitMetadata(workspaceScope, taskScope);
				return response;
			} catch (error) {
				return { ok: false, error: errorMessage(error) } satisfies RuntimeStashDropResponse;
			}
		},

		stashShow: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					normalizeOptionalTaskWorkspaceScopeInput(input.taskScope),
				);
				return await stashShow({ cwd, index: input.index });
			} catch (error) {
				return { ok: false, error: errorMessage(error) } satisfies RuntimeStashShowResponse;
			}
		},
	};
}
