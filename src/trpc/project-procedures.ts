import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	createTaggedLogger,
	findCardInBoard,
	runtimeAutoMergedFilesRequestSchema,
	runtimeAutoMergedFilesResponseSchema,
	runtimeConflictAbortRequestSchema,
	runtimeConflictAbortResponseSchema,
	runtimeConflictContinueRequestSchema,
	runtimeConflictContinueResponseSchema,
	runtimeConflictFilesRequestSchema,
	runtimeConflictFilesResponseSchema,
	runtimeConflictResolveRequestSchema,
	runtimeFileContentRequestSchema,
	runtimeFileContentResponseSchema,
	runtimeFileDiffRequestSchema,
	runtimeFileDiffResponseSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeGitCheckoutResponseSchema,
	runtimeGitCherryPickRequestSchema,
	runtimeGitCherryPickResponseSchema,
	runtimeGitCommitDiffRequestSchema,
	runtimeGitCommitDiffResponseSchema,
	runtimeGitCommitRequestSchema,
	runtimeGitCommitResponseSchema,
	runtimeGitCreateBranchRequestSchema,
	runtimeGitCreateBranchResponseSchema,
	runtimeGitDeleteBranchRequestSchema,
	runtimeGitDeleteBranchResponseSchema,
	runtimeGitDiscardFileRequestSchema,
	runtimeGitDiscardResponseSchema,
	runtimeGitLogRequestSchema,
	runtimeGitLogResponseSchema,
	runtimeGitMergeRequestSchema,
	runtimeGitMergeResponseSchema,
	runtimeGitRebaseRequestSchema,
	runtimeGitRebaseResponseSchema,
	runtimeGitRefsResponseSchema,
	runtimeGitRenameBranchRequestSchema,
	runtimeGitRenameBranchResponseSchema,
	runtimeGitResetToRefRequestSchema,
	runtimeGitResetToRefResponseSchema,
	runtimeGitSyncActionSchema,
	runtimeGitSyncResponseSchema,
	runtimeListFilesRequestSchema,
	runtimeListFilesResponseSchema,
	runtimeProjectStateResponseSchema,
	runtimeProjectStateSaveRequestSchema,
	runtimeStashActionRequestSchema,
	runtimeStashDropResponseSchema,
	runtimeStashListResponseSchema,
	runtimeStashPopApplyResponseSchema,
	runtimeStashPushRequestSchema,
	runtimeStashPushResponseSchema,
	runtimeStashShowResponseSchema,
	runtimeTaskRepositoryInfoResponseSchema,
	runtimeTaskWorktreeInfoRequestSchema,
	runtimeWorkdirChangesRequestSchema,
	runtimeWorkdirChangesResponseSchema,
	runtimeWorkdirFileSearchRequestSchema,
	runtimeWorkdirFileSearchResponseSchema,
	runtimeWorkdirTextSearchRequestSchema,
	runtimeWorkdirTextSearchResponseSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeDeleteResponseSchema,
	runtimeWorktreeEnsureRequestSchema,
	runtimeWorktreeEnsureResponseSchema,
} from "../core";
import {
	buildTaskGenerationContext,
	generateBranchName,
	generateCommitMessage,
	generateDisplaySummary,
	generateTaskTitle,
	SUMMARY_FIRST_ACTIVITY_LIMIT,
	SUMMARY_LATEST_ACTIVITY_LIMIT,
	SUMMARY_ORIGINAL_PROMPT_LIMIT,
	SUMMARY_PREVIOUS_ACTIVITY_LIMIT,
	TITLE_FIRST_ACTIVITY_LIMIT,
	TITLE_LATEST_ACTIVITY_LIMIT,
	TITLE_ORIGINAL_PROMPT_LIMIT,
	TITLE_PREVIOUS_ACTIVITY_LIMIT,
} from "../title";
import { projectProcedure, t } from "./app-router-init";

const log = createTaggedLogger("task-gen");

/** Tracks taskIds with in-flight LLM summary generation to prevent duplicate concurrent calls. */
const summaryGenerationInFlight = new Set<string>();

const optionalTaskWorktreeInfoRequestSchema = runtimeTaskWorktreeInfoRequestSchema.nullable().optional();
const gitSyncActionInputSchema = z.object({
	action: runtimeGitSyncActionSchema,
	taskScope: runtimeTaskWorktreeInfoRequestSchema.nullable().optional(),
	/** When set, targets a specific branch instead of the currently checked-out one. */
	branch: z.string().nullable().optional(),
});

export const projectRouter = t.router({
	runGitSyncAction: projectProcedure
		.input(gitSyncActionInputSchema)
		.output(runtimeGitSyncResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.runGitSyncAction(ctx.projectScope, input);
		}),
	checkoutGitBranch: projectProcedure
		.input(runtimeGitCheckoutRequestSchema)
		.output(runtimeGitCheckoutResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.checkoutGitBranch(ctx.projectScope, input);
		}),
	mergeBranch: projectProcedure
		.input(runtimeGitMergeRequestSchema)
		.output(runtimeGitMergeResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.mergeBranch(ctx.projectScope, input);
		}),
	getConflictFiles: projectProcedure
		.input(runtimeConflictFilesRequestSchema)
		.output(runtimeConflictFilesResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.getConflictFiles(ctx.projectScope, input);
		}),
	getAutoMergedFiles: projectProcedure
		.input(runtimeAutoMergedFilesRequestSchema)
		.output(runtimeAutoMergedFilesResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.getAutoMergedFiles(ctx.projectScope, input);
		}),
	resolveConflictFile: projectProcedure
		.input(runtimeConflictResolveRequestSchema)
		.output(z.object({ ok: z.boolean(), error: z.string().optional() }))
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.resolveConflictFile(ctx.projectScope, input);
		}),
	continueConflictResolution: projectProcedure
		.input(runtimeConflictContinueRequestSchema)
		.output(runtimeConflictContinueResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.continueConflictResolution(ctx.projectScope, input);
		}),
	abortConflictResolution: projectProcedure
		.input(runtimeConflictAbortRequestSchema)
		.output(runtimeConflictAbortResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.abortConflictResolution(ctx.projectScope, input);
		}),
	createBranch: projectProcedure
		.input(runtimeGitCreateBranchRequestSchema)
		.output(runtimeGitCreateBranchResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.createBranch(ctx.projectScope, input);
		}),
	deleteBranch: projectProcedure
		.input(runtimeGitDeleteBranchRequestSchema)
		.output(runtimeGitDeleteBranchResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.deleteBranch(ctx.projectScope, input);
		}),
	renameBranch: projectProcedure
		.input(runtimeGitRenameBranchRequestSchema)
		.output(runtimeGitRenameBranchResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.renameBranch(ctx.projectScope, input);
		}),
	rebaseBranch: projectProcedure
		.input(runtimeGitRebaseRequestSchema)
		.output(runtimeGitRebaseResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.rebaseBranch(ctx.projectScope, input);
		}),
	resetToRef: projectProcedure
		.input(runtimeGitResetToRefRequestSchema)
		.output(runtimeGitResetToRefResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.resetToRef(ctx.projectScope, input);
		}),
	cherryPickCommit: projectProcedure
		.input(runtimeGitCherryPickRequestSchema)
		.output(runtimeGitCherryPickResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.cherryPickCommit(ctx.projectScope, input);
		}),
	discardGitChanges: projectProcedure
		.input(optionalTaskWorktreeInfoRequestSchema)
		.output(runtimeGitDiscardResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.discardGitChanges(ctx.projectScope, input ?? null);
		}),
	commitSelectedFiles: projectProcedure
		.input(runtimeGitCommitRequestSchema)
		.output(runtimeGitCommitResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.commitSelectedFiles(ctx.projectScope, input);
		}),
	discardFile: projectProcedure
		.input(runtimeGitDiscardFileRequestSchema)
		.output(runtimeGitDiscardResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.discardFile(ctx.projectScope, input);
		}),
	getChanges: projectProcedure
		.input(runtimeWorkdirChangesRequestSchema)
		.output(runtimeWorkdirChangesResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.loadChanges(ctx.projectScope, input);
		}),
	getFileDiff: projectProcedure
		.input(runtimeFileDiffRequestSchema)
		.output(runtimeFileDiffResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.loadFileDiff(ctx.projectScope, input);
		}),
	ensureWorktree: projectProcedure
		.input(runtimeWorktreeEnsureRequestSchema)
		.output(runtimeWorktreeEnsureResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.ensureWorktree(ctx.projectScope, input);
		}),
	deleteWorktree: projectProcedure
		.input(runtimeWorktreeDeleteRequestSchema)
		.output(runtimeWorktreeDeleteResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.deleteWorktree(ctx.projectScope, input);
		}),
	getTaskContext: projectProcedure
		.input(runtimeTaskWorktreeInfoRequestSchema)
		.output(runtimeTaskRepositoryInfoResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.loadTaskContext(ctx.projectScope, input);
		}),
	searchFiles: projectProcedure
		.input(runtimeWorkdirFileSearchRequestSchema)
		.output(runtimeWorkdirFileSearchResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.searchFiles(ctx.projectScope, input);
		}),
	searchText: projectProcedure
		.input(runtimeWorkdirTextSearchRequestSchema)
		.output(runtimeWorkdirTextSearchResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.searchText(ctx.projectScope, input);
		}),
	listFiles: projectProcedure
		.input(runtimeListFilesRequestSchema)
		.output(runtimeListFilesResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.listFiles(ctx.projectScope, input);
		}),
	getFileContent: projectProcedure
		.input(runtimeFileContentRequestSchema)
		.output(runtimeFileContentResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.getFileContent(ctx.projectScope, input);
		}),
	getState: projectProcedure.output(runtimeProjectStateResponseSchema).query(async ({ ctx }) => {
		return await ctx.projectApi.loadState(ctx.projectScope);
	}),
	saveState: projectProcedure
		.input(runtimeProjectStateSaveRequestSchema)
		.output(runtimeProjectStateResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.saveState(ctx.projectScope, input);
		}),
	setFocusedTask: projectProcedure.input(z.object({ taskId: z.string().nullable() })).mutation(({ ctx, input }) => {
		ctx.projectApi.setFocusedTask(ctx.projectScope, input.taskId);
	}),
	setDocumentVisible: projectProcedure
		.input(z.object({ isDocumentVisible: z.boolean() }))
		.mutation(({ ctx, input }) => {
			ctx.projectApi.setDocumentVisible(ctx.projectScope, ctx.runtimeClientId, input.isDocumentVisible);
		}),
	getWorkdirChanges: projectProcedure.output(runtimeWorkdirChangesResponseSchema).query(async ({ ctx }) => {
		return await ctx.projectApi.loadWorkdirChanges(ctx.projectScope);
	}),
	getGitLog: projectProcedure
		.input(runtimeGitLogRequestSchema)
		.output(runtimeGitLogResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.loadGitLog(ctx.projectScope, input);
		}),
	getGitRefs: projectProcedure
		.input(optionalTaskWorktreeInfoRequestSchema)
		.output(runtimeGitRefsResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.loadGitRefs(ctx.projectScope, input ?? null);
		}),
	getCommitDiff: projectProcedure
		.input(runtimeGitCommitDiffRequestSchema)
		.output(runtimeGitCommitDiffResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.loadCommitDiff(ctx.projectScope, input);
		}),
	regenerateTaskTitle: projectProcedure
		.input(z.object({ taskId: z.string() }))
		.output(z.object({ ok: z.boolean(), title: z.string().nullable() }))
		.mutation(async ({ ctx, input }) => {
			const state = await ctx.projectApi.loadState(ctx.projectScope);
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

			const context =
				buildTaskGenerationContext({
					prompt,
					summaries,
					finalMessage: session?.latestHookActivity?.finalMessage,
					limits: {
						originalPrompt: TITLE_ORIGINAL_PROMPT_LIMIT,
						firstActivity: TITLE_FIRST_ACTIVITY_LIMIT,
						latestActivity: TITLE_LATEST_ACTIVITY_LIMIT,
						previousActivity: TITLE_PREVIOUS_ACTIVITY_LIMIT,
					},
				}) ?? prompt;
			const title = await generateTaskTitle(context);
			if (!title) {
				return { ok: false, title: null };
			}
			ctx.projectApi.notifyTaskTitleUpdated(ctx.projectScope, input.taskId, title);
			return { ok: true, title };
		}),
	updateTaskTitle: projectProcedure
		.input(z.object({ taskId: z.string(), title: z.string().min(1).max(200) }))
		.output(z.object({ ok: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			ctx.projectApi.notifyTaskTitleUpdated(ctx.projectScope, input.taskId, input.title);
			return { ok: true };
		}),
	generateDisplaySummary: projectProcedure
		.input(
			z.object({
				taskId: z.string(),
				staleAfterSeconds: z.number().min(5).default(300),
			}),
		)
		.output(z.object({ ok: z.boolean(), summary: z.string().nullable() }))
		.mutation(async ({ ctx, input }) => {
			const state = await ctx.projectApi.loadState(ctx.projectScope);
			const session = state.sessions[input.taskId];
			if (!session) {
				return { ok: false, summary: null };
			}

			const summaries = session.conversationSummaries ?? [];
			const card = findCardInBoard(state.board, input.taskId);

			// Server-side staleness check — always respect the caller-provided
			// staleAfterSeconds window. Only regenerate after the window expires
			// AND newer conversation data has arrived since the last generation.
			if (session.displaySummaryGeneratedAt) {
				const ageSeconds = (Date.now() - session.displaySummaryGeneratedAt) / 1000;
				if (ageSeconds < input.staleAfterSeconds) {
					return { ok: true, summary: session.displaySummary };
				}
				// Window expired — only regenerate if there's newer conversation data.
				const latestCapturedAt = summaries.length > 0 ? Math.max(...summaries.map((s) => s.capturedAt)) : 0;
				const hasNewerData = latestCapturedAt > session.displaySummaryGeneratedAt;
				if (!hasNewerData) {
					return { ok: true, summary: session.displaySummary };
				}
			}
			const sourceText = buildTaskGenerationContext({
				prompt: card?.prompt,
				summaries,
				finalMessage: session.latestHookActivity?.finalMessage,
				limits: {
					originalPrompt: SUMMARY_ORIGINAL_PROMPT_LIMIT,
					firstActivity: SUMMARY_FIRST_ACTIVITY_LIMIT,
					latestActivity: SUMMARY_LATEST_ACTIVITY_LIMIT,
					previousActivity: SUMMARY_PREVIOUS_ACTIVITY_LIMIT,
				},
			});
			if (!sourceText?.trim()) {
				return { ok: false, summary: null };
			}
			log.debug("generateDisplaySummary", {
				taskId: input.taskId,
				summaryCount: summaries.length,
				sourceTextSnippet: sourceText.slice(0, 120),
				usedFinalMessage: summaries.length === 0 && Boolean(session.latestHookActivity?.finalMessage),
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

				await ctx.projectApi.setTaskDisplaySummary(ctx.projectScope, input.taskId, generated, Date.now());
				return { ok: true, summary: generated };
			} finally {
				summaryGenerationInFlight.delete(input.taskId);
			}
		}),
	// No server-side rate limiting: this is user-triggered (not batch) and the client
	// guards against duplicate in-flight calls via isGeneratingBranchName state.
	generateBranchName: projectProcedure
		.input(z.object({ prompt: z.string().min(1) }))
		.output(z.object({ ok: z.boolean(), branchName: z.string().nullable() }))
		.mutation(async ({ input }) => {
			const branchName = await generateBranchName(input.prompt);
			return { ok: branchName !== null, branchName };
		}),
	// User-triggered — client guards against duplicate in-flight calls via isGenerating state.
	generateCommitMessage: projectProcedure
		.input(
			z.object({
				taskScope: runtimeTaskWorktreeInfoRequestSchema.nullable(),
				paths: z.array(z.string()).optional(),
			}),
		)
		.output(z.object({ ok: z.boolean(), message: z.string().nullable() }))
		.mutation(async ({ ctx, input }) => {
			const taskScope = input.taskScope ?? null;
			let generationContext = await ctx.projectApi.getCommitMessageContext(ctx.projectScope, taskScope, input.paths);
			if (generationContext.files.length === 0 && !generationContext.diffText.trim()) {
				return { ok: false, message: null };
			}
			if (taskScope) {
				const state = await ctx.projectApi.loadState(ctx.projectScope);
				const card = findCardInBoard(state.board, taskScope.taskId);
				const session = state.sessions[taskScope.taskId];
				generationContext = {
					...generationContext,
					taskTitle: card?.title ?? null,
					taskContext: buildTaskGenerationContext({
						prompt: card?.prompt,
						summaries: session?.conversationSummaries ?? [],
						finalMessage: session?.latestHookActivity?.finalMessage,
						limits: {
							originalPrompt: SUMMARY_ORIGINAL_PROMPT_LIMIT,
							firstActivity: SUMMARY_FIRST_ACTIVITY_LIMIT,
							latestActivity: SUMMARY_LATEST_ACTIVITY_LIMIT,
							previousActivity: SUMMARY_PREVIOUS_ACTIVITY_LIMIT,
						},
					}),
				};
			}
			const message = await generateCommitMessage(generationContext);
			return { ok: message !== null, message };
		}),
	stashPush: projectProcedure
		.input(runtimeStashPushRequestSchema)
		.output(runtimeStashPushResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.stashPush(ctx.projectScope, input);
		}),
	stashList: projectProcedure
		.input(z.object({ taskScope: runtimeTaskWorktreeInfoRequestSchema.nullable() }))
		.output(runtimeStashListResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.stashList(ctx.projectScope, input);
		}),
	stashPop: projectProcedure
		.input(runtimeStashActionRequestSchema)
		.output(runtimeStashPopApplyResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.stashPop(ctx.projectScope, input);
		}),
	stashApply: projectProcedure
		.input(runtimeStashActionRequestSchema)
		.output(runtimeStashPopApplyResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.stashApply(ctx.projectScope, input);
		}),
	stashDrop: projectProcedure
		.input(runtimeStashActionRequestSchema)
		.output(runtimeStashDropResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectApi.stashDrop(ctx.projectScope, input);
		}),
	stashShow: projectProcedure
		.input(runtimeStashActionRequestSchema)
		.output(runtimeStashShowResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.projectApi.stashShow(ctx.projectScope, input);
		}),
});
