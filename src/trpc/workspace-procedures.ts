import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
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
	runtimeGitSummaryResponseSchema,
	runtimeGitSyncActionSchema,
	runtimeGitSyncResponseSchema,
	runtimeListFilesRequestSchema,
	runtimeListFilesResponseSchema,
	runtimeStashActionRequestSchema,
	runtimeStashDropResponseSchema,
	runtimeStashListResponseSchema,
	runtimeStashPopApplyResponseSchema,
	runtimeStashPushRequestSchema,
	runtimeStashPushResponseSchema,
	runtimeStashShowResponseSchema,
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
import { createTaggedLogger } from "../core/runtime-logger";
import { findCardInBoard } from "../core/task-board-mutations";
import { generateCommitMessage } from "../title/commit-message-generator";
import { generateDisplaySummary } from "../title/summary-generator";
import { generateBranchName, generateTaskTitle } from "../title/title-generator";
import { t, workspaceProcedure } from "./app-router-init";

const log = createTaggedLogger("task-gen");

/** Tracks taskIds with in-flight LLM summary generation to prevent duplicate concurrent calls. */
const summaryGenerationInFlight = new Set<string>();

const optionalTaskWorkspaceInfoRequestSchema = runtimeTaskWorkspaceInfoRequestSchema.nullable().optional();
const gitSyncActionInputSchema = z.object({
	action: runtimeGitSyncActionSchema,
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
	/** When set, targets a specific branch instead of the currently checked-out one. */
	branch: z.string().nullable().optional(),
});

export const workspaceRouter = t.router({
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
	mergeBranch: workspaceProcedure
		.input(runtimeGitMergeRequestSchema)
		.output(runtimeGitMergeResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.mergeBranch(ctx.workspaceScope, input);
		}),
	getConflictFiles: workspaceProcedure
		.input(runtimeConflictFilesRequestSchema)
		.output(runtimeConflictFilesResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.getConflictFiles(ctx.workspaceScope, input);
		}),
	getAutoMergedFiles: workspaceProcedure
		.input(runtimeAutoMergedFilesRequestSchema)
		.output(runtimeAutoMergedFilesResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.getAutoMergedFiles(ctx.workspaceScope, input);
		}),
	resolveConflictFile: workspaceProcedure
		.input(runtimeConflictResolveRequestSchema)
		.output(z.object({ ok: z.boolean(), error: z.string().optional() }))
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.resolveConflictFile(ctx.workspaceScope, input);
		}),
	continueConflictResolution: workspaceProcedure
		.input(runtimeConflictContinueRequestSchema)
		.output(runtimeConflictContinueResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.continueConflictResolution(ctx.workspaceScope, input);
		}),
	abortConflictResolution: workspaceProcedure
		.input(runtimeConflictAbortRequestSchema)
		.output(runtimeConflictAbortResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.abortConflictResolution(ctx.workspaceScope, input);
		}),
	createBranch: workspaceProcedure
		.input(runtimeGitCreateBranchRequestSchema)
		.output(runtimeGitCreateBranchResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.createBranch(ctx.workspaceScope, input);
		}),
	deleteBranch: workspaceProcedure
		.input(runtimeGitDeleteBranchRequestSchema)
		.output(runtimeGitDeleteBranchResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.deleteBranch(ctx.workspaceScope, input);
		}),
	renameBranch: workspaceProcedure
		.input(runtimeGitRenameBranchRequestSchema)
		.output(runtimeGitRenameBranchResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.renameBranch(ctx.workspaceScope, input);
		}),
	rebaseBranch: workspaceProcedure
		.input(runtimeGitRebaseRequestSchema)
		.output(runtimeGitRebaseResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.rebaseBranch(ctx.workspaceScope, input);
		}),
	resetToRef: workspaceProcedure
		.input(runtimeGitResetToRefRequestSchema)
		.output(runtimeGitResetToRefResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.resetToRef(ctx.workspaceScope, input);
		}),
	cherryPickCommit: workspaceProcedure
		.input(runtimeGitCherryPickRequestSchema)
		.output(runtimeGitCherryPickResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.cherryPickCommit(ctx.workspaceScope, input);
		}),
	discardGitChanges: workspaceProcedure
		.input(optionalTaskWorkspaceInfoRequestSchema)
		.output(runtimeGitDiscardResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.discardGitChanges(ctx.workspaceScope, input ?? null);
		}),
	commitSelectedFiles: workspaceProcedure
		.input(runtimeGitCommitRequestSchema)
		.output(runtimeGitCommitResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.commitSelectedFiles(ctx.workspaceScope, input);
		}),
	discardFile: workspaceProcedure
		.input(runtimeGitDiscardFileRequestSchema)
		.output(runtimeGitDiscardResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.discardFile(ctx.workspaceScope, input);
		}),
	getChanges: workspaceProcedure
		.input(runtimeWorkspaceChangesRequestSchema)
		.output(runtimeWorkspaceChangesResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.workspaceApi.loadChanges(ctx.workspaceScope, input);
		}),
	getFileDiff: workspaceProcedure
		.input(runtimeFileDiffRequestSchema)
		.output(runtimeFileDiffResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.workspaceApi.loadFileDiff(ctx.workspaceScope, input);
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
	setFocusedTask: workspaceProcedure.input(z.object({ taskId: z.string().nullable() })).mutation(({ ctx, input }) => {
		ctx.workspaceApi.setFocusedTask(ctx.workspaceScope, input.taskId);
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

			// Build context with latest activity FIRST so it survives truncation.
			let agentContext: string | null = null;
			if (summaries.length > 0) {
				const earlier = summaries.slice(0, -1).map((s) => s.text);
				const latest = summaries.at(-1)?.text ?? "";
				const parts =
					earlier.length > 0
						? [`Most recent activity:\n${latest}`, `Earlier activity:\n${earlier.join("\n")}`]
						: [`Most recent activity:\n${latest}`];
				agentContext = parts.join("\n\n");
			}

			// Fall back to finalMessage if no conversation summaries.
			agentContext ??= session?.latestHookActivity?.finalMessage
				? `Most recent activity:\n${session.latestHookActivity.finalMessage.slice(0, 500)}`
				: null;

			// Put agent context before the original prompt so recent work
			// is what the LLM sees first (and survives truncation).
			const context = agentContext ? `${agentContext}\n\nOriginal prompt:\n${prompt}` : prompt;
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

			// Server-side staleness check — always respect the user-configured
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
	// User-triggered — client guards against duplicate in-flight calls via isGenerating state.
	generateCommitMessage: workspaceProcedure
		.input(
			z.object({
				taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(),
				paths: z.array(z.string()).optional(),
			}),
		)
		.output(z.object({ ok: z.boolean(), message: z.string().nullable() }))
		.mutation(async ({ ctx, input }) => {
			const taskScope = input.taskScope ?? null;
			const diffText = await ctx.workspaceApi.getDiffText(ctx.workspaceScope, taskScope, input.paths);
			if (!diffText.trim()) {
				return { ok: false, message: null };
			}
			const message = await generateCommitMessage(diffText);
			return { ok: message !== null, message };
		}),
	stashPush: workspaceProcedure
		.input(runtimeStashPushRequestSchema)
		.output(runtimeStashPushResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.stashPush(ctx.workspaceScope, input);
		}),
	stashList: workspaceProcedure
		.input(z.object({ taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable() }))
		.output(runtimeStashListResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.workspaceApi.stashList(ctx.workspaceScope, input);
		}),
	stashPop: workspaceProcedure
		.input(runtimeStashActionRequestSchema)
		.output(runtimeStashPopApplyResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.stashPop(ctx.workspaceScope, input);
		}),
	stashApply: workspaceProcedure
		.input(runtimeStashActionRequestSchema)
		.output(runtimeStashPopApplyResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.stashApply(ctx.workspaceScope, input);
		}),
	stashDrop: workspaceProcedure
		.input(runtimeStashActionRequestSchema)
		.output(runtimeStashDropResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.stashDrop(ctx.workspaceScope, input);
		}),
	stashShow: workspaceProcedure
		.input(runtimeStashActionRequestSchema)
		.output(runtimeStashShowResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.workspaceApi.stashShow(ctx.workspaceScope, input);
		}),
});
