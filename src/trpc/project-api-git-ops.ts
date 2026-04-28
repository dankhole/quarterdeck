import { parseGitCheckoutRequest } from "../core";
import { invalidateGitRepositoryInfoCache } from "../state/project-state-utils";
import {
	cherryPickCommit,
	createBranchFromRef,
	deleteBranch,
	renameBranch,
	resetToRef,
	resolveTaskWorkingDirectory,
	runGitCheckoutAction,
	runGitMergeAction,
	runGitRebaseAction,
	runGitSyncAction,
} from "../workdir";
import type { RuntimeTrpcContext, RuntimeTrpcProjectScope } from "./app-router-context";
import {
	createGitBranchErrorResponse,
	EMPTY_GIT_SUMMARY,
	errorMessage,
	hasActiveSharedCheckoutTask,
	normalizeOptionalTaskScopeInput,
	type ProjectApiContext,
	resolveWorkingDir,
} from "./project-api-shared";
import { createGitMetadataRefreshEffects, createProjectStateUpdatedEffects } from "./runtime-mutation-effects";

type GitOps = Pick<
	RuntimeTrpcContext["projectApi"],
	| "runGitSyncAction"
	| "checkoutGitBranch"
	| "mergeBranch"
	| "rebaseBranch"
	| "resetToRef"
	| "cherryPickCommit"
	| "createBranch"
	| "deleteBranch"
	| "renameBranch"
>;

function invalidateProjectGitRepositoryInfo(projectScope: Pick<RuntimeTrpcProjectScope, "projectPath">): void {
	// Keep this wrapper as the local reminder that branch-list context has a
	// separate cache. If git mutation handling grows beyond this module, move
	// this invalidation behind that shared mutation path instead of copying it.
	invalidateGitRepositoryInfoCache(projectScope.projectPath);
}

export function createGitOps(ctx: ProjectApiContext): GitOps {
	return {
		runGitSyncAction: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					normalizeOptionalTaskScopeInput(input.taskScope ?? null),
				);
				const response = await runGitSyncAction({ cwd, action: input.action, branch: input.branch ?? null });
				if (response.ok) {
					invalidateProjectGitRepositoryInfo(projectScope);
				}
				return response;
			} catch (error) {
				return {
					ok: false,
					action: input.action,
					summary: { ...EMPTY_GIT_SUMMARY },
					output: "",
					error: errorMessage(error),
				};
			}
		},

		checkoutGitBranch: async (projectScope, input) => {
			try {
				const body = parseGitCheckoutRequest(input);

				if (input.taskId) {
					const taskCwd = await resolveTaskWorkingDirectory({
						projectPath: projectScope.projectPath,
						taskId: input.taskId,
						baseRef: input.baseRef ?? "",
					});
					const response = await runGitCheckoutAction({ cwd: taskCwd, branch: body.branch });
					if (response.ok) {
						invalidateProjectGitRepositoryInfo(projectScope);
						ctx.applyEffects(
							createGitMetadataRefreshEffects(projectScope, {
								taskId: input.taskId,
							}),
						);
					}
					return response;
				}

				if (await hasActiveSharedCheckoutTask(projectScope.projectPath)) {
					return createGitBranchErrorResponse(
						new Error(
							"Cannot switch branches while a task in the shared checkout is in progress or review. Isolate the task or move it to another column first.",
						),
					);
				}
				const response = await runGitCheckoutAction({
					cwd: projectScope.projectPath,
					branch: body.branch,
				});
				if (response.ok) {
					invalidateProjectGitRepositoryInfo(projectScope);
					ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
				}
				return response;
			} catch (error) {
				return createGitBranchErrorResponse(error);
			}
		},

		mergeBranch: async (projectScope, input) => {
			try {
				const branchToMerge = input.branch.trim();
				if (!branchToMerge) {
					return createGitBranchErrorResponse(new Error("Branch name cannot be empty."));
				}

				if (input.taskId) {
					const taskCwd = await resolveTaskWorkingDirectory({
						projectPath: projectScope.projectPath,
						taskId: input.taskId,
						baseRef: input.baseRef ?? "",
					});
					const response = await runGitMergeAction({ cwd: taskCwd, branch: branchToMerge });
					if (response.ok || response.conflictState) {
						ctx.applyEffects(
							createGitMetadataRefreshEffects(projectScope, {
								taskId: input.taskId,
							}),
						);
					}
					return response;
				}

				if (await hasActiveSharedCheckoutTask(projectScope.projectPath)) {
					return createGitBranchErrorResponse(
						new Error(
							"Cannot merge while a task in the shared checkout is in progress or review. Isolate the task or move it to another column first.",
						),
					);
				}
				const response = await runGitMergeAction({ cwd: projectScope.projectPath, branch: branchToMerge });
				if (response.ok || response.conflictState) {
					ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
				}
				return response;
			} catch (error) {
				return createGitBranchErrorResponse(error);
			}
		},

		rebaseBranch: async (projectScope, input) => {
			try {
				const ontoRef = input.onto.trim();
				if (!ontoRef) {
					return {
						ok: false as const,
						onto: ontoRef,
						summary: { ...EMPTY_GIT_SUMMARY },
						output: "",
						error: "Target ref cannot be empty.",
					};
				}

				if (input.taskId) {
					const taskCwd = await resolveTaskWorkingDirectory({
						projectPath: projectScope.projectPath,
						taskId: input.taskId,
						baseRef: input.baseRef ?? "",
					});
					const response = await runGitRebaseAction({ cwd: taskCwd, onto: ontoRef });
					if (response.ok || response.conflictState) {
						ctx.applyEffects(
							createGitMetadataRefreshEffects(projectScope, {
								taskId: input.taskId,
							}),
						);
					}
					return response;
				}

				if (await hasActiveSharedCheckoutTask(projectScope.projectPath)) {
					return {
						ok: false as const,
						onto: ontoRef,
						summary: { ...EMPTY_GIT_SUMMARY },
						output: "",
						error: "Cannot rebase while a task in the shared checkout is in progress or review. Isolate the task or move it to another column first.",
					};
				}
				const response = await runGitRebaseAction({ cwd: projectScope.projectPath, onto: ontoRef });
				if (response.ok || response.conflictState) {
					ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
				}
				return response;
			} catch (error) {
				return {
					ok: false as const,
					onto: input.onto,
					summary: { ...EMPTY_GIT_SUMMARY },
					output: "",
					error: errorMessage(error),
				};
			}
		},

		resetToRef: async (projectScope, input) => {
			try {
				const targetRef = input.ref.trim();
				if (!targetRef) {
					return {
						ok: false as const,
						ref: targetRef,
						summary: { ...EMPTY_GIT_SUMMARY },
						output: "",
						error: "Target ref cannot be empty.",
					};
				}

				if (input.taskId) {
					const taskCwd = await resolveTaskWorkingDirectory({
						projectPath: projectScope.projectPath,
						taskId: input.taskId,
						baseRef: input.baseRef ?? "",
					});
					const response = await resetToRef({ cwd: taskCwd, ref: targetRef });
					if (response.ok) {
						ctx.applyEffects(
							createGitMetadataRefreshEffects(projectScope, {
								taskId: input.taskId,
							}),
						);
					}
					return response;
				}

				if (await hasActiveSharedCheckoutTask(projectScope.projectPath)) {
					return {
						ok: false as const,
						ref: targetRef,
						summary: { ...EMPTY_GIT_SUMMARY },
						output: "",
						error: "Cannot reset while a task in the shared checkout is in progress or review. Isolate the task or move it to another column first.",
					};
				}
				const response = await resetToRef({ cwd: projectScope.projectPath, ref: targetRef });
				if (response.ok) ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
				return response;
			} catch (error) {
				return {
					ok: false as const,
					ref: input.ref,
					summary: { ...EMPTY_GIT_SUMMARY },
					output: "",
					error: errorMessage(error),
				};
			}
		},

		cherryPickCommit: async (projectScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					projectScope.projectPath,
					normalizeOptionalTaskScopeInput(input.taskScope ?? null),
				);
				const result = await cherryPickCommit({
					cwd,
					commitHash: input.commitHash,
					targetBranch: input.targetBranch,
				});
				if (result.ok) ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
				return result;
			} catch (error) {
				return {
					ok: false as const,
					commitHash: input.commitHash,
					targetBranch: input.targetBranch,
					output: "",
					error: errorMessage(error),
				};
			}
		},

		createBranch: async (projectScope, input) => {
			try {
				const result = await createBranchFromRef({
					cwd: projectScope.projectPath,
					branchName: input.branchName,
					startRef: input.startRef,
				});
				if (result.ok) {
					invalidateProjectGitRepositoryInfo(projectScope);
					ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
				}
				return result;
			} catch (error) {
				return { ok: false as const, branchName: input.branchName, error: errorMessage(error) };
			}
		},

		deleteBranch: async (projectScope, input) => {
			try {
				const result = await deleteBranch({
					cwd: projectScope.projectPath,
					branchName: input.branchName,
				});
				if (result.ok) {
					invalidateProjectGitRepositoryInfo(projectScope);
					ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
				}
				return result;
			} catch (error) {
				return { ok: false as const, branchName: input.branchName, error: errorMessage(error) };
			}
		},

		renameBranch: async (projectScope, input) => {
			try {
				const result = await renameBranch({
					cwd: projectScope.projectPath,
					oldName: input.oldName,
					newName: input.newName,
				});
				if (result.ok) {
					invalidateProjectGitRepositoryInfo(projectScope);
					ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
				}
				return result;
			} catch (error) {
				return { ok: false as const, oldName: input.oldName, newName: input.newName, error: errorMessage(error) };
			}
		},
	};
}
