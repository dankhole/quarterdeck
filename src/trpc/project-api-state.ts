import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import {
	findCardInBoard,
	normalizeDiagnosticErrorClass,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
} from "../core";
import {
	ProjectBoardCommandIdentityConflictError,
	ProjectBoardLifecycleCommandRequiredError,
	ProjectStateConflictError,
} from "../state";
import { archiveTaskWorktreeForTrash, ensureTaskWorktreeIfDoesntExist, getTaskRepositoryInfo } from "../workdir";
import type { RuntimeTrpcContext, RuntimeTrpcProjectScope } from "./app-router-context";
import { normalizeRequiredTaskScopeInput, type ProjectApiContext } from "./project-api-shared";
import {
	createBoardCommandCommittedEffects,
	createProjectStateUpdatedEffects,
	createTaskTitleUpdatedEffects,
} from "./runtime-mutation-effects";

type StateOps = Pick<
	RuntimeTrpcContext["projectApi"],
	| "ensureWorktree"
	| "deleteWorktree"
	| "loadTaskContext"
	| "loadState"
	| "applyBoardCommands"
	| "updateTaskTitle"
	| "setTaskDisplaySummary"
	| "setFocusedTask"
	| "setDocumentVisible"
>;

function requireBoardCommands(ctx: ProjectApiContext) {
	if (!ctx.deps.boardCommands) {
		throw new Error("Project board command authority is not configured.");
	}
	return ctx.deps.boardCommands;
}

async function persistTaskTitle(
	ctx: ProjectApiContext,
	projectScope: RuntimeTrpcProjectScope,
	input: {
		taskId: string;
		title: string;
		commandId: string;
	},
): Promise<boolean> {
	const updatedAt = Date.now();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const current = await ctx.deps.data.buildProjectStateSnapshot(projectScope.projectId, projectScope.projectPath);
		const card = findCardInBoard(current.board, input.taskId);
		if (!card) {
			return false;
		}
		try {
			const result = await requireBoardCommands(ctx).executeBatch(projectScope, {
				commandId: input.commandId,
				expectedRevision: current.revision,
				commands: [
					{
						kind: "patch_task",
						taskId: input.taskId,
						title: input.title,
						updatedAt,
					},
				],
			});
			if (!result.acceptedChange) {
				return false;
			}
			ctx.applyEffects(
				createTaskTitleUpdatedEffects({
					projectId: projectScope.projectId,
					taskId: input.taskId,
					title: input.title,
				}),
			);
			return true;
		} catch (error) {
			if (!(error instanceof ProjectStateConflictError) || attempt === 2) {
				throw error;
			}
		}
	}
	return false;
}

export function createStateOps(ctx: ProjectApiContext): StateOps {
	return {
		// Low-level compatibility surface for controlled maintenance callers. Browser
		// task lifecycle actions use ProjectTaskLifecycleService instead.
		ensureWorktree: async (projectScope, input) => {
			const body = parseWorktreeEnsureRequest(input);
			return await ctx.deps.taskResourceOperations.run(projectScope.projectId, body.taskId, async () => {
				return await ensureTaskWorktreeIfDoesntExist({
					cwd: projectScope.projectPath,
					taskId: body.taskId,
					baseRef: body.baseRef,
					branch: body.branch ?? undefined,
				});
			});
		},

		deleteWorktree: async (projectScope, input) => {
			const body = parseWorktreeDeleteRequest(input);
			return await ctx.deps.taskResourceOperations.run(projectScope.projectId, body.taskId, async () => {
				const terminalManager = ctx.deps.terminals.getTerminalManagerForProject(projectScope.projectId);
				if (terminalManager?.hasTaskSessionLifecycleActivity(body.taskId)) {
					return {
						ok: false,
						removed: false,
						error: "Task worktree cleanup was skipped because an agent session is active.",
					};
				}
				// This compatibility endpoint is trash-safe: it archives recoverable
				// work rather than permanently purging it. Production task deletion is
				// owned by ProjectTaskLifecycleService.
				return await archiveTaskWorktreeForTrash({
					repoPath: projectScope.projectPath,
					taskId: body.taskId,
				});
			});
		},

		loadTaskContext: async (projectScope, input) => {
			const normalizedInput = normalizeRequiredTaskScopeInput(input);
			return await getTaskRepositoryInfo({
				cwd: projectScope.projectPath,
				taskId: normalizedInput.taskId,
				baseRef: normalizedInput.baseRef,
			});
		},

		loadState: async (projectScope) => {
			try {
				const state = await ctx.deps.data.buildProjectStateSnapshot(
					projectScope.projectId,
					projectScope.projectPath,
				);
				return state;
			} catch (error) {
				ctx.deps.diagnostics?.recordEvent(
					"project.state_load_failed",
					{ errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError" },
					{ projectId: projectScope.projectId },
					{ level: "error", essential: true },
				);
				throw error;
			}
		},

		applyBoardCommands: async (projectScope, input) => {
			const operationId = randomUUID();
			const startedAt = Date.now();
			ctx.deps.diagnostics?.recordEvent(
				"project.board_save_started",
				{ expectedRevision: input.expectedRevision },
				{ projectId: projectScope.projectId, operationId },
				{ essential: true },
			);
			try {
				const result = await requireBoardCommands(ctx).executeClientBatch(projectScope, input);
				ctx.applyEffects(createBoardCommandCommittedEffects(projectScope));
				ctx.deps.diagnostics?.recordEvent(
					"project.board_save_completed",
					{
						expectedRevision: input.expectedRevision,
						resultRevision: result.state.revision,
						acceptedChange: result.acceptedChange,
						replayed: result.replayed,
						durationMs: Date.now() - startedAt,
					},
					{ projectId: projectScope.projectId, operationId },
					{ essential: true },
				);
				return result;
			} catch (error) {
				if (error instanceof ProjectStateConflictError) {
					ctx.deps.diagnostics?.recordEvent(
						"project.board_save_conflict",
						{
							expectedRevision: input.expectedRevision,
							currentRevision: error.currentRevision,
							durationMs: Date.now() - startedAt,
						},
						{ projectId: projectScope.projectId, operationId },
						{ level: "warn", essential: true },
					);
					throw new TRPCError({
						code: "CONFLICT",
						message: error.message,
						cause: { currentRevision: error.currentRevision },
					});
				}
				ctx.deps.diagnostics?.recordEvent(
					"project.board_save_failed",
					{
						errorClass: error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError",
						durationMs: Date.now() - startedAt,
					},
					{ projectId: projectScope.projectId, operationId },
					{ level: "error", essential: true },
				);
				if (error instanceof ProjectBoardCommandIdentityConflictError) {
					throw new TRPCError({ code: "CONFLICT", message: error.message });
				}
				if (error instanceof ProjectBoardLifecycleCommandRequiredError) {
					throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
				}
				throw error;
			}
		},

		updateTaskTitle: async (projectScope, taskId, title) =>
			await persistTaskTitle(ctx, projectScope, {
				taskId,
				title,
				commandId: `title:${randomUUID()}`,
			}),

		setTaskDisplaySummary: async (projectScope, taskId, text, generatedAt) => {
			const manager = await ctx.deps.terminals.ensureTerminalManagerForProject(
				projectScope.projectId,
				projectScope.projectPath,
			);
			manager.store.setDisplaySummary(taskId, text, generatedAt);
			ctx.applyEffects(createProjectStateUpdatedEffects(projectScope));
		},

		setFocusedTask: (projectScope, taskId) => {
			// This intentionally stays a direct command instead of becoming a
			// post-mutation effect. Focus steers metadata-monitor polling policy;
			// it is not a "mutation happened, now deliver consequences" path.
			ctx.deps.broadcaster.setFocusedTask(projectScope.projectId, taskId);
		},

		setDocumentVisible: (projectScope, clientId, isDocumentVisible) => {
			ctx.deps.broadcaster.setDocumentVisible(projectScope.projectId, clientId, isDocumentVisible);
		},
	};
}
