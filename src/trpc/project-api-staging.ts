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
} from "../workdir";
import type { RuntimeTrpcContext } from "./app-router-context";
import {
	createGitOutputErrorResponse,
	errorMessage,
	normalizeOptionalTaskScopeInput,
	type ProjectApiContext,
	resolveWorkingDir,
} from "./project-api-shared";

type StagingOps = Pick<
	RuntimeTrpcContext["projectApi"],
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

export function createStagingOps(ctx: ProjectApiContext): StagingOps {
	return {
		discardGitChanges: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input);
				const cwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				if (taskScope && resolve(cwd) === resolve(projectScope.projectPath)) {
					return createGitOutputErrorResponse(
						new Error("Cannot discard changes in the shared checkout. Isolate the task to a worktree first."),
					);
				}
				const response = await discardGitChanges({ cwd });
				if (response.ok) ctx.refreshGitMetadata(projectScope, taskScope);
				return response;
			} catch (error) {
				return createGitOutputErrorResponse(error);
			}
		},

		commitSelectedFiles: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input.taskScope);
				const commitCwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				if (taskScope && resolve(commitCwd) === resolve(projectScope.projectPath)) {
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
						ctx.refreshGitMetadata(projectScope, taskScope);
						return {
							...response,
							pushOk: pushResult.ok,
							...(!pushResult.ok && { pushError: pushResult.error ?? "Push failed." }),
							summary: pushResult.summary,
						};
					}
					ctx.refreshGitMetadata(projectScope, taskScope);
				}
				return response;
			} catch (error) {
				return createGitOutputErrorResponse(error);
			}
		},

		discardFile: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				if (taskScope && resolve(cwd) === resolve(projectScope.projectPath)) {
					return createGitOutputErrorResponse(
						new Error("Cannot discard changes in the shared checkout. Isolate the task to a worktree first."),
					);
				}
				const response = await discardSingleFile({
					cwd,
					path: input.path,
					fileStatus: input.fileStatus,
				});
				if (response.ok) ctx.refreshGitMetadata(projectScope, taskScope);
				return response;
			} catch (error) {
				return createGitOutputErrorResponse(error);
			}
		},

		stashPush: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				const response = await stashPush({ cwd, paths: input.paths, message: input.message });
				if (response.ok) ctx.refreshGitMetadata(projectScope, taskScope);
				return response;
			} catch (error) {
				return { ok: false, error: errorMessage(error) } satisfies RuntimeStashPushResponse;
			}
		},

		stashList: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					normalizeOptionalTaskScopeInput(input.taskScope),
				);
				return await stashList(cwd);
			} catch (error) {
				return { ok: false, entries: [], error: errorMessage(error) } satisfies RuntimeStashListResponse;
			}
		},

		stashPop: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				const response = await stashPop({ cwd, index: input.index });
				if (response.ok || response.conflicted) ctx.refreshGitMetadata(projectScope, taskScope);
				return response;
			} catch (error) {
				return { ok: false, conflicted: false, error: errorMessage(error) } satisfies RuntimeStashPopApplyResponse;
			}
		},

		stashApply: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				const response = await stashApply({ cwd, index: input.index });
				if (response.ok || response.conflicted) ctx.refreshGitMetadata(projectScope, taskScope);
				return response;
			} catch (error) {
				return { ok: false, conflicted: false, error: errorMessage(error) } satisfies RuntimeStashPopApplyResponse;
			}
		},

		stashDrop: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input.taskScope);
				const cwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				const response = await stashDrop({ cwd, index: input.index });
				if (response.ok) ctx.refreshGitMetadata(projectScope, taskScope);
				return response;
			} catch (error) {
				return { ok: false, error: errorMessage(error) } satisfies RuntimeStashDropResponse;
			}
		},

		stashShow: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					normalizeOptionalTaskScopeInput(input.taskScope),
				);
				return await stashShow({ cwd, index: input.index });
			} catch (error) {
				return { ok: false, error: errorMessage(error) } satisfies RuntimeStashShowResponse;
			}
		},
	};
}
