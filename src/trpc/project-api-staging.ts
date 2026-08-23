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
	isProjectCheckoutCwd,
	normalizeOptionalTaskScopeInput,
	observeProjectOperation,
	type ProjectApiContext,
	resolveWorkingDir,
} from "./project-api-shared";
import { createGitMetadataRefreshEffects } from "./runtime-mutation-effects";

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

function createGitMetadataRefreshEffectsForCwd(
	projectScope: { projectId: string; projectPath: string },
	taskScope: { taskId: string; baseRef: string } | null,
	cwd: string,
) {
	return createGitMetadataRefreshEffects(projectScope, taskScope, {
		includeHome: taskScope !== null && isProjectCheckoutCwd(projectScope.projectPath, cwd),
	});
}

export function createStagingOps(ctx: ProjectApiContext): StagingOps {
	const operations: StagingOps = {
		discardGitChanges: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input);
				const cwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				if (taskScope && isProjectCheckoutCwd(projectScope.projectPath, cwd)) {
					return createGitOutputErrorResponse(
						new Error("Cannot discard changes in the shared checkout. Isolate the task to a worktree first."),
					);
				}
				const response = await discardGitChanges({ cwd });
				if (response.ok) ctx.applyEffects(createGitMetadataRefreshEffectsForCwd(projectScope, taskScope, cwd));
				return response;
			} catch (error) {
				return createGitOutputErrorResponse(error);
			}
		},

		commitSelectedFiles: async (projectScope, input) => {
			try {
				const taskScope = normalizeOptionalTaskScopeInput(input.taskScope);
				const commitCwd = await resolveWorkingDir(projectScope.projectPath, taskScope);
				const response = await commitSelectedFiles({
					cwd: commitCwd,
					paths: input.paths,
					message: input.message,
				});
				if (response.ok) {
					if (input.pushAfterCommit) {
						const pushResult = await runGitSyncAction({ cwd: commitCwd, action: "push" });
						ctx.applyEffects(createGitMetadataRefreshEffectsForCwd(projectScope, taskScope, commitCwd));
						return {
							...response,
							pushOk: pushResult.ok,
							...(!pushResult.ok && { pushError: pushResult.error ?? "Push failed." }),
							summary: pushResult.summary,
						};
					}
					ctx.applyEffects(createGitMetadataRefreshEffectsForCwd(projectScope, taskScope, commitCwd));
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
				if (taskScope && isProjectCheckoutCwd(projectScope.projectPath, cwd)) {
					return createGitOutputErrorResponse(
						new Error("Cannot discard changes in the shared checkout. Isolate the task to a worktree first."),
					);
				}
				const response = await discardSingleFile({
					cwd,
					path: input.path,
					fileStatus: input.fileStatus,
				});
				if (response.ok) ctx.applyEffects(createGitMetadataRefreshEffectsForCwd(projectScope, taskScope, cwd));
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
				if (response.ok) ctx.applyEffects(createGitMetadataRefreshEffectsForCwd(projectScope, taskScope, cwd));
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
				if (response.ok || response.conflicted) {
					ctx.applyEffects(createGitMetadataRefreshEffectsForCwd(projectScope, taskScope, cwd));
				}
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
				if (response.ok || response.conflicted) {
					ctx.applyEffects(createGitMetadataRefreshEffectsForCwd(projectScope, taskScope, cwd));
				}
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
				if (response.ok) ctx.applyEffects(createGitMetadataRefreshEffectsForCwd(projectScope, taskScope, cwd));
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

	return {
		...operations,
		discardGitChanges: async (scope, input) =>
			await observeProjectOperation(
				ctx,
				scope,
				"discard_all",
				{ taskId: input?.taskId },
				async () => await operations.discardGitChanges(scope, input),
			),
		commitSelectedFiles: async (scope, input) =>
			await observeProjectOperation(
				ctx,
				scope,
				input.pushAfterCommit ? "commit_and_push" : "commit",
				{ taskId: input.taskScope?.taskId },
				async () => await operations.commitSelectedFiles(scope, input),
			),
		discardFile: async (scope, input) =>
			await observeProjectOperation(
				ctx,
				scope,
				"discard_file",
				{ taskId: input.taskScope?.taskId },
				async () => await operations.discardFile(scope, input),
			),
		stashPush: async (scope, input) =>
			await observeProjectOperation(
				ctx,
				scope,
				"stash_push",
				{ taskId: input.taskScope?.taskId },
				async () => await operations.stashPush(scope, input),
			),
		stashPop: async (scope, input) =>
			await observeProjectOperation(
				ctx,
				scope,
				"stash_pop",
				{ taskId: input.taskScope?.taskId },
				async () => await operations.stashPop(scope, input),
			),
		stashApply: async (scope, input) =>
			await observeProjectOperation(
				ctx,
				scope,
				"stash_apply",
				{ taskId: input.taskScope?.taskId },
				async () => await operations.stashApply(scope, input),
			),
		stashDrop: async (scope, input) =>
			await observeProjectOperation(
				ctx,
				scope,
				"stash_drop",
				{ taskId: input.taskScope?.taskId },
				async () => await operations.stashDrop(scope, input),
			),
	};
}
