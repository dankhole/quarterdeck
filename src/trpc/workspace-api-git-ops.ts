import { parseGitCheckoutRequest } from "../core";
import {
	cherryPickCommit,
	createBranchFromRef,
	deleteBranch,
	getGitSyncSummary,
	renameBranch,
	resetToRef,
	resolveTaskWorkingDirectory,
	runGitCheckoutAction,
	runGitMergeAction,
	runGitRebaseAction,
	runGitSyncAction,
} from "../workspace";
import type { RuntimeTrpcContext } from "./app-router-context";
import {
	createGitBranchErrorResponse,
	EMPTY_GIT_SUMMARY,
	errorMessage,
	hasActiveSharedCheckoutTask,
	normalizeOptionalTaskWorkspaceScopeInput,
	resolveWorkingDir,
	type WorkspaceApiContext,
} from "./workspace-api-shared";

type GitOps = Pick<
	RuntimeTrpcContext["workspaceApi"],
	| "loadGitSummary"
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

export function createGitOps(ctx: WorkspaceApiContext): GitOps {
	return {
		loadGitSummary: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					normalizeOptionalTaskWorkspaceScopeInput(input),
				);
				const summary = await getGitSyncSummary(cwd);
				return { ok: true, summary };
			} catch (error) {
				return { ok: false, summary: { ...EMPTY_GIT_SUMMARY }, error: errorMessage(error) };
			}
		},

		runGitSyncAction: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null),
				);
				return await runGitSyncAction({ cwd, action: input.action, branch: input.branch ?? null });
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

		checkoutGitBranch: async (workspaceScope, input) => {
			try {
				const body = parseGitCheckoutRequest(input);

				if (input.taskId) {
					const taskCwd = await resolveTaskWorkingDirectory({
						workspacePath: workspaceScope.workspacePath,
						taskId: input.taskId,
						baseRef: input.baseRef ?? "",
					});
					const response = await runGitCheckoutAction({ cwd: taskCwd, branch: body.branch });
					if (response.ok) {
						ctx.deps.broadcaster.requestTaskRefresh(workspaceScope.workspaceId, input.taskId);
					}
					return response;
				}

				if (await hasActiveSharedCheckoutTask(workspaceScope.workspacePath)) {
					return createGitBranchErrorResponse(
						new Error(
							"Cannot switch branches while a task in the shared checkout is in progress or review. Isolate the task or move it to another column first.",
						),
					);
				}
				const response = await runGitCheckoutAction({
					cwd: workspaceScope.workspacePath,
					branch: body.branch,
				});
				if (response.ok) ctx.broadcastStateUpdate(workspaceScope);
				return response;
			} catch (error) {
				return createGitBranchErrorResponse(error);
			}
		},

		mergeBranch: async (workspaceScope, input) => {
			try {
				const branchToMerge = input.branch.trim();
				if (!branchToMerge) {
					return createGitBranchErrorResponse(new Error("Branch name cannot be empty."));
				}

				if (input.taskId) {
					const taskCwd = await resolveTaskWorkingDirectory({
						workspacePath: workspaceScope.workspacePath,
						taskId: input.taskId,
						baseRef: input.baseRef ?? "",
					});
					const response = await runGitMergeAction({ cwd: taskCwd, branch: branchToMerge });
					if (response.ok || response.conflictState) {
						ctx.deps.broadcaster.requestTaskRefresh(workspaceScope.workspaceId, input.taskId);
					}
					return response;
				}

				if (await hasActiveSharedCheckoutTask(workspaceScope.workspacePath)) {
					return createGitBranchErrorResponse(
						new Error(
							"Cannot merge while a task in the shared checkout is in progress or review. Isolate the task or move it to another column first.",
						),
					);
				}
				const response = await runGitMergeAction({ cwd: workspaceScope.workspacePath, branch: branchToMerge });
				if (response.ok || response.conflictState) ctx.broadcastStateUpdate(workspaceScope);
				return response;
			} catch (error) {
				return createGitBranchErrorResponse(error);
			}
		},

		rebaseBranch: async (workspaceScope, input) => {
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
						workspacePath: workspaceScope.workspacePath,
						taskId: input.taskId,
						baseRef: input.baseRef ?? "",
					});
					const response = await runGitRebaseAction({ cwd: taskCwd, onto: ontoRef });
					if (response.ok || response.conflictState) {
						ctx.deps.broadcaster.requestTaskRefresh(workspaceScope.workspaceId, input.taskId);
					}
					return response;
				}

				if (await hasActiveSharedCheckoutTask(workspaceScope.workspacePath)) {
					return {
						ok: false as const,
						onto: ontoRef,
						summary: { ...EMPTY_GIT_SUMMARY },
						output: "",
						error: "Cannot rebase while a task in the shared checkout is in progress or review. Isolate the task or move it to another column first.",
					};
				}
				const response = await runGitRebaseAction({ cwd: workspaceScope.workspacePath, onto: ontoRef });
				if (response.ok || response.conflictState) ctx.broadcastStateUpdate(workspaceScope);
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

		resetToRef: async (workspaceScope, input) => {
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
						workspacePath: workspaceScope.workspacePath,
						taskId: input.taskId,
						baseRef: input.baseRef ?? "",
					});
					const response = await resetToRef({ cwd: taskCwd, ref: targetRef });
					if (response.ok) {
						ctx.deps.broadcaster.requestTaskRefresh(workspaceScope.workspaceId, input.taskId);
					}
					return response;
				}

				if (await hasActiveSharedCheckoutTask(workspaceScope.workspacePath)) {
					return {
						ok: false as const,
						ref: targetRef,
						summary: { ...EMPTY_GIT_SUMMARY },
						output: "",
						error: "Cannot reset while a task in the shared checkout is in progress or review. Isolate the task or move it to another column first.",
					};
				}
				const response = await resetToRef({ cwd: workspaceScope.workspacePath, ref: targetRef });
				if (response.ok) ctx.broadcastStateUpdate(workspaceScope);
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

		cherryPickCommit: async (workspaceScope, input) => {
			try {
				const cwd = await resolveWorkingDir(
					workspaceScope.workspacePath,
					normalizeOptionalTaskWorkspaceScopeInput(input.taskScope ?? null),
				);
				const result = await cherryPickCommit({
					cwd,
					commitHash: input.commitHash,
					targetBranch: input.targetBranch,
				});
				if (result.ok) ctx.broadcastStateUpdate(workspaceScope);
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

		createBranch: async (workspaceScope, input) => {
			try {
				const result = await createBranchFromRef({
					cwd: workspaceScope.workspacePath,
					branchName: input.branchName,
					startRef: input.startRef,
				});
				if (result.ok) ctx.broadcastStateUpdate(workspaceScope);
				return result;
			} catch (error) {
				return { ok: false as const, branchName: input.branchName, error: errorMessage(error) };
			}
		},

		deleteBranch: async (workspaceScope, input) => {
			try {
				const result = await deleteBranch({
					cwd: workspaceScope.workspacePath,
					branchName: input.branchName,
				});
				if (result.ok) ctx.broadcastStateUpdate(workspaceScope);
				return result;
			} catch (error) {
				return { ok: false as const, branchName: input.branchName, error: errorMessage(error) };
			}
		},

		renameBranch: async (workspaceScope, input) => {
			try {
				const result = await renameBranch({
					cwd: workspaceScope.workspacePath,
					oldName: input.oldName,
					newName: input.newName,
				});
				if (result.ok) ctx.broadcastStateUpdate(workspaceScope);
				return result;
			} catch (error) {
				return { ok: false as const, oldName: input.oldName, newName: input.newName, error: errorMessage(error) };
			}
		},
	};
}
