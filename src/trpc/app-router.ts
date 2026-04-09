// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type {
	RuntimeCommandRunRequest,
	RuntimeCommandRunResponse,
	RuntimeConfigResponse,
	RuntimeConfigSaveRequest,
	RuntimeDebugResetAllStateResponse,
	RuntimeFileContentRequest,
	RuntimeFileContentResponse,
	RuntimeGitCheckoutRequest,
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitDiffRequest,
	RuntimeGitCommitDiffResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitLogRequest,
	RuntimeGitLogResponse,
	RuntimeGitRefsResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeListFilesRequest,
	RuntimeListFilesResponse,
	RuntimeMigrateTaskWorkingDirectoryRequest,
	RuntimeMigrateTaskWorkingDirectoryResponse,
	RuntimeOpenFileRequest,
	RuntimeOpenFileResponse,
	RuntimeProjectAddRequest,
	RuntimeProjectAddResponse,
	RuntimeProjectDirectoryPickerResponse,
	RuntimeProjectRemoveRequest,
	RuntimeProjectRemoveResponse,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartRequest,
	RuntimeShellSessionStartResponse,
	RuntimeTaskSessionInputRequest,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionStopRequest,
	RuntimeTaskSessionStopResponse,
	RuntimeTaskWorkspaceInfoRequest,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorkspaceChangesRequest,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileSearchRequest,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateNotifyResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
	RuntimeWorktreeDeleteRequest,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureRequest,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import {
	runtimeCommandRunRequestSchema,
	runtimeCommandRunResponseSchema,
	runtimeConfigResponseSchema,
	runtimeConfigSaveRequestSchema,
	runtimeDebugResetAllStateResponseSchema,
	runtimeFileContentRequestSchema,
	runtimeFileContentResponseSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeGitCheckoutResponseSchema,
	runtimeGitCommitDiffRequestSchema,
	runtimeGitCommitDiffResponseSchema,
	runtimeGitDiscardResponseSchema,
	runtimeGitLogRequestSchema,
	runtimeGitLogResponseSchema,
	runtimeGitRefsResponseSchema,
	runtimeGitSummaryResponseSchema,
	runtimeGitSyncActionSchema,
	runtimeGitSyncResponseSchema,
	runtimeHookIngestRequestSchema,
	runtimeHookIngestResponseSchema,
	runtimeListFilesRequestSchema,
	runtimeListFilesResponseSchema,
	runtimeMigrateTaskWorkingDirectoryRequestSchema,
	runtimeMigrateTaskWorkingDirectoryResponseSchema,
	runtimeOpenFileRequestSchema,
	runtimeOpenFileResponseSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectAddResponseSchema,
	runtimeProjectDirectoryPickerResponseSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeProjectRemoveResponseSchema,
	runtimeProjectsResponseSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeShellSessionStartResponseSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionInputResponseSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStartResponseSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskSessionStopResponseSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTaskWorkspaceInfoResponseSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceChangesResponseSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceFileSearchResponseSchema,
	runtimeWorkspaceStateNotifyResponseSchema,
	runtimeWorkspaceStateResponseSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeDeleteResponseSchema,
	runtimeWorktreeEnsureRequestSchema,
	runtimeWorktreeEnsureResponseSchema,
} from "../core/api-contract";
import { createTaggedLogger } from "../core/debug-logger";
import { findCardInBoard } from "../core/task-board-mutations";
import { generateDisplaySummary } from "../title/summary-generator";
import { generateBranchName, generateTaskTitle } from "../title/title-generator";

const log = createTaggedLogger("task-gen");

/** Tracks taskIds with in-flight LLM summary generation to prevent duplicate concurrent calls. */
const summaryGenerationInFlight = new Set<string>();

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
	runtimeApi: {
		loadConfig: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeConfigResponse>;
		saveConfig: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeConfigSaveRequest,
		) => Promise<RuntimeConfigResponse>;
		startTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStartRequest,
		) => Promise<RuntimeTaskSessionStartResponse>;
		stopTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		sendTaskSessionInput: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionInputRequest,
		) => Promise<RuntimeTaskSessionInputResponse>;
		startShellSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeShellSessionStartRequest,
		) => Promise<RuntimeShellSessionStartResponse>;
		runCommand: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeCommandRunRequest,
		) => Promise<RuntimeCommandRunResponse>;
		resetAllState: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeDebugResetAllStateResponse>;
		openFile: (input: RuntimeOpenFileRequest) => Promise<RuntimeOpenFileResponse>;
		migrateTaskWorkingDirectory: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeMigrateTaskWorkingDirectoryRequest,
		) => Promise<RuntimeMigrateTaskWorkingDirectoryResponse>;
		setDebugLogging: (enabled: boolean) => { ok: boolean; enabled: boolean };
	};
	workspaceApi: {
		loadGitSummary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitSummaryResponse>;
		runGitSyncAction: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { action: RuntimeGitSyncAction },
		) => Promise<RuntimeGitSyncResponse>;
		checkoutGitBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCheckoutRequest,
		) => Promise<RuntimeGitCheckoutResponse>;
		discardGitChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitDiscardResponse>;
		loadChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceChangesRequest,
		) => Promise<RuntimeWorkspaceChangesResponse>;
		ensureWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeEnsureRequest,
		) => Promise<RuntimeWorktreeEnsureResponse>;
		deleteWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeDeleteRequest,
		) => Promise<RuntimeWorktreeDeleteResponse>;
		loadTaskContext: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest,
		) => Promise<RuntimeTaskWorkspaceInfoResponse>;
		searchFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceFileSearchRequest,
		) => Promise<RuntimeWorkspaceFileSearchResponse>;
		listFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeListFilesRequest,
		) => Promise<RuntimeListFilesResponse>;
		getFileContent: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeFileContentRequest,
		) => Promise<RuntimeFileContentResponse>;
		loadState: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateResponse>;
		notifyStateUpdated: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateNotifyResponse>;
		saveState: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceStateSaveRequest,
		) => Promise<RuntimeWorkspaceStateResponse>;
		loadWorkspaceChanges: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceChangesResponse>;
		loadGitLog: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeGitLogRequest) => Promise<RuntimeGitLogResponse>;
		loadGitRefs: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitRefsResponse>;
		loadCommitDiff: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitDiffRequest,
		) => Promise<RuntimeGitCommitDiffResponse>;
		notifyTaskTitleUpdated: (scope: RuntimeTrpcWorkspaceScope, taskId: string, title: string) => void;
		setTaskDisplaySummary: (
			scope: RuntimeTrpcWorkspaceScope,
			taskId: string,
			text: string,
			generatedAt: number | null,
		) => Promise<void>;
	};
	projectsApi: {
		listProjects: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectsResponse>;
		addProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectAddRequest,
		) => Promise<RuntimeProjectAddResponse>;
		removeProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectRemoveRequest,
		) => Promise<RuntimeProjectRemoveResponse>;
		pickProjectDirectory: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectDirectoryPickerResponse>;
	};
	hooksApi: {
		ingest: (input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	};
}

interface RuntimeTrpcContextWithWorkspaceScope extends RuntimeTrpcContext {
	workspaceScope: RuntimeTrpcWorkspaceScope;
}

function readConflictRevision(cause: unknown): number | null {
	if (!cause || typeof cause !== "object" || !("currentRevision" in cause)) {
		return null;
	}
	const revision = (cause as { currentRevision?: unknown }).currentRevision;
	if (typeof revision !== "number") {
		return null;
	}
	return Number.isFinite(revision) ? revision : null;
}

const t = initTRPC.context<RuntimeTrpcContext>().create({
	errorFormatter({ shape, error }) {
		const conflictRevision = error.code === "CONFLICT" ? readConflictRevision(error.cause) : null;
		return {
			...shape,
			data: {
				...shape.data,
				conflictRevision,
			},
		};
	},
});

const workspaceProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.requestedWorkspaceId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Missing workspace scope. Include x-quarterdeck-workspace-id header or workspaceId query parameter.",
		});
	}
	if (!ctx.workspaceScope) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Unknown workspace ID: ${ctx.requestedWorkspaceId}`,
		});
	}
	return next({
		ctx: {
			...ctx,
			workspaceScope: ctx.workspaceScope,
		} satisfies RuntimeTrpcContextWithWorkspaceScope,
	});
});

const optionalTaskWorkspaceInfoRequestSchema = runtimeTaskWorkspaceInfoRequestSchema.nullable().optional();
const gitSyncActionInputSchema = z.object({
	action: runtimeGitSyncActionSchema,
});

export const runtimeAppRouter = t.router({
	runtime: t.router({
		getConfig: t.procedure.output(runtimeConfigResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.loadConfig(ctx.workspaceScope);
		}),
		saveConfig: t.procedure
			.input(runtimeConfigSaveRequestSchema)
			.output(runtimeConfigResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveConfig(ctx.workspaceScope, input);
			}),
		startTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStartRequestSchema)
			.output(runtimeTaskSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startTaskSession(ctx.workspaceScope, input);
			}),
		stopTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStopRequestSchema)
			.output(runtimeTaskSessionStopResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.stopTaskSession(ctx.workspaceScope, input);
			}),
		sendTaskSessionInput: workspaceProcedure
			.input(runtimeTaskSessionInputRequestSchema)
			.output(runtimeTaskSessionInputResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.sendTaskSessionInput(ctx.workspaceScope, input);
			}),
		startShellSession: workspaceProcedure
			.input(runtimeShellSessionStartRequestSchema)
			.output(runtimeShellSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startShellSession(ctx.workspaceScope, input);
			}),
		runCommand: workspaceProcedure
			.input(runtimeCommandRunRequestSchema)
			.output(runtimeCommandRunResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runCommand(ctx.workspaceScope, input);
			}),
		resetAllState: t.procedure.output(runtimeDebugResetAllStateResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.resetAllState(ctx.workspaceScope);
		}),
		setDebugLogging: t.procedure
			.input(z.object({ enabled: z.boolean() }))
			.output(z.object({ ok: z.boolean(), enabled: z.boolean() }))
			.mutation(({ ctx, input }) => {
				return ctx.runtimeApi.setDebugLogging(input.enabled);
			}),
		openFile: t.procedure
			.input(runtimeOpenFileRequestSchema)
			.output(runtimeOpenFileResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.openFile(input);
			}),
		migrateTaskWorkingDirectory: workspaceProcedure
			.input(runtimeMigrateTaskWorkingDirectoryRequestSchema)
			.output(runtimeMigrateTaskWorkingDirectoryResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.migrateTaskWorkingDirectory(ctx.workspaceScope, input);
			}),
	}),
	workspace: t.router({
		getGitSummary: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitSummaryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitSummary(ctx.workspaceScope, input ?? null);
			}),
		runGitSyncAction: workspaceProcedure
			.input(gitSyncActionInputSchema)
			.output(runtimeGitSyncResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.runGitSyncAction(ctx.workspaceScope, input);
			}),
		checkoutGitBranch: workspaceProcedure
			.input(runtimeGitCheckoutRequestSchema)
			.output(runtimeGitCheckoutResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.checkoutGitBranch(ctx.workspaceScope, input);
			}),
		discardGitChanges: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitDiscardResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.discardGitChanges(ctx.workspaceScope, input ?? null);
			}),
		getChanges: workspaceProcedure
			.input(runtimeWorkspaceChangesRequestSchema)
			.output(runtimeWorkspaceChangesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadChanges(ctx.workspaceScope, input);
			}),
		ensureWorktree: workspaceProcedure
			.input(runtimeWorktreeEnsureRequestSchema)
			.output(runtimeWorktreeEnsureResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.ensureWorktree(ctx.workspaceScope, input);
			}),
		deleteWorktree: workspaceProcedure
			.input(runtimeWorktreeDeleteRequestSchema)
			.output(runtimeWorktreeDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteWorktree(ctx.workspaceScope, input);
			}),
		getTaskContext: workspaceProcedure
			.input(runtimeTaskWorkspaceInfoRequestSchema)
			.output(runtimeTaskWorkspaceInfoResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadTaskContext(ctx.workspaceScope, input);
			}),
		searchFiles: workspaceProcedure
			.input(runtimeWorkspaceFileSearchRequestSchema)
			.output(runtimeWorkspaceFileSearchResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.searchFiles(ctx.workspaceScope, input);
			}),
		listFiles: workspaceProcedure
			.input(runtimeListFilesRequestSchema)
			.output(runtimeListFilesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.listFiles(ctx.workspaceScope, input);
			}),
		getFileContent: workspaceProcedure
			.input(runtimeFileContentRequestSchema)
			.output(runtimeFileContentResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.getFileContent(ctx.workspaceScope, input);
			}),
		getState: workspaceProcedure.output(runtimeWorkspaceStateResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadState(ctx.workspaceScope);
		}),
		notifyStateUpdated: workspaceProcedure
			.output(runtimeWorkspaceStateNotifyResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.workspaceApi.notifyStateUpdated(ctx.workspaceScope);
			}),
		saveState: workspaceProcedure
			.input(runtimeWorkspaceStateSaveRequestSchema)
			.output(runtimeWorkspaceStateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.saveState(ctx.workspaceScope, input);
			}),
		getWorkspaceChanges: workspaceProcedure.output(runtimeWorkspaceChangesResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadWorkspaceChanges(ctx.workspaceScope);
		}),
		getGitLog: workspaceProcedure
			.input(runtimeGitLogRequestSchema)
			.output(runtimeGitLogResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitLog(ctx.workspaceScope, input);
			}),
		getGitRefs: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitRefsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitRefs(ctx.workspaceScope, input ?? null);
			}),
		getCommitDiff: workspaceProcedure
			.input(runtimeGitCommitDiffRequestSchema)
			.output(runtimeGitCommitDiffResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadCommitDiff(ctx.workspaceScope, input);
			}),
		regenerateTaskTitle: workspaceProcedure
			.input(z.object({ taskId: z.string() }))
			.output(z.object({ ok: z.boolean(), title: z.string().nullable() }))
			.mutation(async ({ ctx, input }) => {
				const state = await ctx.workspaceApi.loadState(ctx.workspaceScope);
				const card = findCardInBoard(state.board, input.taskId);
				if (!card) {
					throw new TRPCError({ code: "NOT_FOUND", message: `Task "${input.taskId}" not found.` });
				}
				const prompt = card.prompt;
				const session = state.sessions[card.id];
				const summaries = session?.conversationSummaries ?? [];
				log.debug("regenerateTaskTitle", {
					taskId: input.taskId,
					promptSnippet: prompt.slice(0, 80),
					summaryCount: summaries.length,
					latestSummary: summaries.at(-1)?.text?.slice(0, 100),
				});

				// Build context with summaries labeled so the LLM can prioritize the latest.
				let agentContext: string | null = null;
				if (summaries.length > 0) {
					const earlier = summaries.slice(0, -1).map((s) => s.text);
					const latest = summaries[summaries.length - 1]?.text ?? "";
					const parts =
						earlier.length > 0
							? [`Earlier activity:\n${earlier.join("\n")}`, `Latest activity:\n${latest}`]
							: [`Latest activity:\n${latest}`];
					agentContext = parts.join("\n\n");
				}

				// Fall back to finalMessage if no conversation summaries.
				agentContext ??= session?.latestHookActivity?.finalMessage?.slice(0, 500) ?? null;

				const context = agentContext ? `${prompt}\n\nAgent summary:\n${agentContext}` : prompt;
				const title = await generateTaskTitle(context);
				if (!title) {
					return { ok: false, title: null };
				}
				ctx.workspaceApi.notifyTaskTitleUpdated(ctx.workspaceScope, input.taskId, title);
				return { ok: true, title };
			}),
		updateTaskTitle: workspaceProcedure
			.input(z.object({ taskId: z.string(), title: z.string().min(1).max(200) }))
			.output(z.object({ ok: z.boolean() }))
			.mutation(async ({ ctx, input }) => {
				ctx.workspaceApi.notifyTaskTitleUpdated(ctx.workspaceScope, input.taskId, input.title);
				return { ok: true };
			}),
		generateDisplaySummary: workspaceProcedure
			.input(
				z.object({
					taskId: z.string(),
					staleAfterSeconds: z.number().min(5).default(300),
				}),
			)
			.output(z.object({ ok: z.boolean(), summary: z.string().nullable() }))
			.mutation(async ({ ctx, input }) => {
				const state = await ctx.workspaceApi.loadState(ctx.workspaceScope);
				const session = state.sessions[input.taskId];
				if (!session) {
					return { ok: false, summary: null };
				}

				const summaries = session.conversationSummaries ?? [];

				// Server-side staleness check — skip if recently generated AND no newer
				// conversation data has arrived since. appendConversationSummary preserves
				// displaySummaryGeneratedAt as a sentinel, so we detect staleness by
				// comparing the generation timestamp against conversationSummaries capturedAt.
				if (session.displaySummaryGeneratedAt) {
					const latestCapturedAt = summaries.length > 0 ? Math.max(...summaries.map((s) => s.capturedAt)) : 0;
					const hasNewerData = latestCapturedAt > session.displaySummaryGeneratedAt;
					if (!hasNewerData) {
						const ageSeconds = (Date.now() - session.displaySummaryGeneratedAt) / 1000;
						if (ageSeconds < input.staleAfterSeconds) {
							return { ok: true, summary: session.displaySummary };
						}
					}
				}
				const conversationText = summaries.length > 0 ? summaries.map((s) => s.text).join("\n") : null;
				// Fall back to finalMessage if no conversation summaries.
				const sourceText = conversationText ?? session.latestHookActivity?.finalMessage ?? null;
				if (!sourceText?.trim()) {
					return { ok: false, summary: null };
				}
				log.debug("generateDisplaySummary", {
					taskId: input.taskId,
					summaryCount: summaries.length,
					sourceTextSnippet: sourceText.slice(0, 120),
					usedFinalMessage: conversationText === null,
				});

				// Prevent duplicate concurrent LLM calls for the same task.
				if (summaryGenerationInFlight.has(input.taskId)) {
					return { ok: true, summary: session.displaySummary };
				}
				summaryGenerationInFlight.add(input.taskId);
				try {
					const generated = await generateDisplaySummary(sourceText);
					if (!generated) {
						return { ok: false, summary: null };
					}

					await ctx.workspaceApi.setTaskDisplaySummary(ctx.workspaceScope, input.taskId, generated, Date.now());
					return { ok: true, summary: generated };
				} finally {
					summaryGenerationInFlight.delete(input.taskId);
				}
			}),
		// No server-side rate limiting: this is user-triggered (not batch) and the client
		// guards against duplicate in-flight calls via isGeneratingBranchName state.
		generateBranchName: workspaceProcedure
			.input(z.object({ prompt: z.string().min(1) }))
			.output(z.object({ ok: z.boolean(), branchName: z.string().nullable() }))
			.mutation(async ({ input }) => {
				const branchName = await generateBranchName(input.prompt);
				return { ok: branchName !== null, branchName };
			}),
	}),
	projects: t.router({
		list: t.procedure.output(runtimeProjectsResponseSchema).query(async ({ ctx }) => {
			return await ctx.projectsApi.listProjects(ctx.requestedWorkspaceId);
		}),
		add: t.procedure
			.input(runtimeProjectAddRequestSchema)
			.output(runtimeProjectAddResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input);
			}),
		remove: t.procedure
			.input(runtimeProjectRemoveRequestSchema)
			.output(runtimeProjectRemoveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.removeProject(ctx.requestedWorkspaceId, input);
			}),
		pickDirectory: t.procedure.output(runtimeProjectDirectoryPickerResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.projectsApi.pickProjectDirectory(ctx.requestedWorkspaceId);
		}),
	}),
	hooks: t.router({
		ingest: t.procedure
			.input(runtimeHookIngestRequestSchema)
			.output(runtimeHookIngestResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.hooksApi.ingest(input);
			}),
	}),
});

export type RuntimeAppRouter = typeof runtimeAppRouter;
export type RuntimeAppRouterInputs = inferRouterInputs<RuntimeAppRouter>;
export type RuntimeAppRouterOutputs = inferRouterOutputs<RuntimeAppRouter>;
