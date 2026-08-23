import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import {
	normalizeDiagnosticErrorClass,
	parseWorktreeDeleteRequest,
	parseWorktreeEnsureRequest,
	pruneOrphanSessionsForPersist,
} from "../core";
import { ProjectStateConflictError, saveProjectState } from "../state";
import { generateTaskTitle } from "../title";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist, getTaskRepositoryInfo } from "../workdir";
import type { RuntimeTrpcContext } from "./app-router-context";
import { normalizeRequiredTaskScopeInput, type ProjectApiContext } from "./project-api-shared";
import {
	createBoardStateSavedEffects,
	createProjectStateUpdatedEffects,
	createTaskTitleUpdatedEffects,
} from "./runtime-mutation-effects";

const MAX_CONCURRENT_TITLE_REQUESTS = 3;

type StateOps = Pick<
	RuntimeTrpcContext["projectApi"],
	| "ensureWorktree"
	| "deleteWorktree"
	| "loadTaskContext"
	| "loadState"
	| "saveState"
	| "notifyTaskTitleUpdated"
	| "setTaskDisplaySummary"
	| "setFocusedTask"
	| "setDocumentVisible"
>;

export function createStateOps(ctx: ProjectApiContext): StateOps {
	const automaticTitleGenerationInFlight = new Set<string>();

	return {
		// Called by the UI's ensureTaskWorktree (use-task-sessions.ts) for restore-from-trash.
		// The other path to ensureTaskWorktreeIfDoesntExist is startTaskSession in runtime-api.ts,
		// which reads branch from persisted board state server-side instead.
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
				const result = await deleteTaskWorktree({
					repoPath: projectScope.projectPath,
					taskId: body.taskId,
				});
				// workingDirectory is cleared by the client when it moves the card
				// to trash. The client persists through its normal board state cycle,
				// avoiding a second server-side board writer.
				return result;
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

		saveState: async (projectScope, input) => {
			const operationId = randomUUID();
			const startedAt = Date.now();
			ctx.deps.diagnostics?.recordEvent(
				"project.board_save_started",
				{ expectedRevision: input.expectedRevision },
				{ projectId: projectScope.projectId, operationId },
				{ essential: true },
			);
			try {
				const terminalManager = await ctx.deps.terminals.ensureTerminalManagerForProject(
					projectScope.projectId,
					projectScope.projectPath,
				);
				const authoritativeSessions = Object.fromEntries(
					terminalManager.store.listSummaries().map((summary) => [summary.taskId, summary]),
				);
				const response = await saveProjectState(projectScope.projectPath, {
					board: input.board,
					sessions: pruneOrphanSessionsForPersist(authoritativeSessions, input.board),
					expectedRevision: input.expectedRevision,
				});
				ctx.applyEffects(createBoardStateSavedEffects(projectScope));
				ctx.deps.diagnostics?.recordEvent(
					"project.board_save_completed",
					{
						expectedRevision: input.expectedRevision,
						resultRevision: response.revision,
						durationMs: Date.now() - startedAt,
					},
					{ projectId: projectScope.projectId, operationId },
					{ essential: true },
				);

				// Fire-and-forget: generate titles for any new cards that have title === null.
				// Cap concurrency to avoid flooding the LLM proxy when many cards are created at once.
				const untitledCards = input.board.columns.flatMap((col) => col.cards.filter((card) => card.title === null));
				const generateTitle = async (card: (typeof untitledCards)[number]) => {
					const generationKey = JSON.stringify([projectScope.projectId, card.id]);
					if (automaticTitleGenerationInFlight.has(generationKey)) {
						return;
					}
					automaticTitleGenerationInFlight.add(generationKey);
					try {
						const title = await generateTaskTitle(card.prompt);
						if (!title) return;
						// Send the title to the UI via the explicit post-mutation effect path.
						// The client still applies it to board state and persists through
						// its normal single-writer cycle.
						ctx.applyEffects(
							createTaskTitleUpdatedEffects({
								projectId: projectScope.projectId,
								taskId: card.id,
								title,
								autoGenerated: true,
							}),
						);
					} finally {
						automaticTitleGenerationInFlight.delete(generationKey);
					}
				};
				if (untitledCards.length > 0) {
					void (async () => {
						for (let i = 0; i < untitledCards.length; i += MAX_CONCURRENT_TITLE_REQUESTS) {
							const batch = untitledCards.slice(i, i + MAX_CONCURRENT_TITLE_REQUESTS);
							await Promise.allSettled(batch.map(generateTitle));
						}
					})();
				}

				return response;
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
				throw error;
			}
		},

		notifyTaskTitleUpdated: (projectScope, taskId, title) => {
			ctx.applyEffects(
				createTaskTitleUpdatedEffects({
					projectId: projectScope.projectId,
					taskId,
					title,
				}),
			);
		},

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
