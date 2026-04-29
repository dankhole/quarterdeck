import { resolveAgentCommand } from "../../config";
import {
	createTaggedLogger,
	findCardInBoard,
	type IRuntimeConfigProvider,
	isRuntimeTaskBaseRefResolved,
	parseTaskSessionStartRequest,
	type RuntimeTaskSessionSummary,
} from "../../core";
import { loadProjectState } from "../../state";
import type { TerminalSessionManager } from "../../terminal";
import { hasFailedStoredCodexResume, STORED_CODEX_RESUME_FAILED_WARNING } from "../../terminal/codex-resume-failure";
import { captureTaskTurnCheckpoint, pathExists, resolveTaskCwd } from "../../workdir";
import type { RuntimeTrpcProjectScope } from "../app-router-context";
import { queueTaskDisplaySummaryPolish } from "../display-summary-polish";

const log = createTaggedLogger("task-session-start");

export interface StartTaskSessionDeps {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	getScopedTerminalManager: (scope: RuntimeTrpcProjectScope) => Promise<TerminalSessionManager>;
}

function getResumeContextWarning(options: {
	resumeConversation: boolean | undefined;
	useWorktree: boolean;
	agentId: string;
	persistedWorkingDirectory: string | null;
	previousSessionLaunchPath: string | null | undefined;
	projectPath: string;
}): string | null {
	if (!options.resumeConversation || !options.useWorktree || options.agentId !== "claude") {
		return null;
	}
	if (options.persistedWorkingDirectory) {
		return null;
	}
	const previousSessionLaunchPath = options.previousSessionLaunchPath?.trim() ?? "";
	if (!previousSessionLaunchPath || previousSessionLaunchPath === options.projectPath) {
		return null;
	}
	return "Claude resume after trash restore is best-effort only: the original task worktree was deleted, so --continue may not reopen the previous chat.";
}

function getCodexResumeSessionWarning(options: {
	resumeConversation: boolean | undefined;
	agentId: string;
	resumeSessionId: string | null | undefined;
	failedStoredResumeSession: boolean;
}): string | null {
	if (!options.resumeConversation || options.agentId !== "codex") {
		return null;
	}
	if (options.failedStoredResumeSession) {
		return STORED_CODEX_RESUME_FAILED_WARNING;
	}
	if (options.resumeSessionId) {
		return null;
	}
	return "Codex resume did not have a stored session id, so Quarterdeck fell back to the most recent Codex session for this checkout. If this opens the wrong conversation, start a fresh task.";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function queueStartTurnCheckpointCapture(options: {
	terminalManager: TerminalSessionManager;
	taskId: string;
	taskCwd: string;
	summary: RuntimeTaskSessionSummary;
}): void {
	const nextTurn = (options.summary.latestTurnCheckpoint?.turn ?? 0) + 1;
	const checkpointLogData = {
		taskId: options.taskId,
		taskCwd: options.taskCwd,
		checkpointTurn: nextTurn,
		sessionStartedAt: options.summary.startedAt,
	};
	log.debug("Start turn checkpoint capture queued", checkpointLogData);
	void captureTaskTurnCheckpoint({
		cwd: options.taskCwd,
		taskId: options.taskId,
		turn: nextTurn,
	})
		.then((checkpoint) => {
			const currentSummary = options.terminalManager.store.getSummary(options.taskId);
			if (currentSummary?.startedAt !== options.summary.startedAt) {
				log.debug("Start turn checkpoint capture skipped for stale session", checkpointLogData);
				return;
			}
			options.terminalManager.store.applyTurnCheckpoint(options.taskId, checkpoint);
			log.debug("Start turn checkpoint captured", {
				...checkpointLogData,
				checkpointRef: checkpoint.ref,
				checkpointCommit: checkpoint.commit,
			});
		})
		.catch((error) => {
			log.warn("Start turn checkpoint capture failed", {
				...checkpointLogData,
				error: errorMessage(error),
			});
		});
}

export async function handleStartTaskSession(
	projectScope: RuntimeTrpcProjectScope,
	input: unknown,
	deps: StartTaskSessionDeps,
) {
	try {
		const body = parseTaskSessionStartRequest(input);
		log.debug("start-task-session request received", {
			taskId: body.taskId,
			projectId: projectScope.projectId,
			projectPath: projectScope.projectPath,
			resumeConversation: body.resumeConversation ?? false,
			awaitReview: body.awaitReview ?? false,
			useWorktree: body.useWorktree ?? true,
			requestedAgentId: body.agentId ?? null,
			hasPrompt: Boolean(body.prompt && body.prompt.trim().length > 0),
			imageCount: body.images?.length ?? 0,
			baseRef: body.baseRef ?? null,
		});
		const scopedRuntimeConfig = await deps.config.loadScopedRuntimeConfig(projectScope);
		const useWorktree = body.useWorktree !== false;
		if (!isRuntimeTaskBaseRefResolved({ baseRef: body.baseRef })) {
			return {
				ok: false,
				summary: null,
				error: "Select a base branch before starting this task.",
			};
		}
		// Prefer the persisted working directory if it still exists on disk.
		const state = await loadProjectState(projectScope.projectPath);
		const existingCard = findCardInBoard(state.board, body.taskId);
		const persisted = existingCard?.workingDirectory ?? null;
		const taskAgentId = existingCard?.agentId ?? body.agentId ?? null;
		// Branch must be threaded to resolveTaskCwd for branch-aware worktree creation.
		// The other path to ensureTaskWorktreeIfDoesntExist is workdir-api.ts:ensureWorktree,
		// which receives branch from the client request instead.
		const savedBranch = existingCard?.branch ?? null;
		const persistedExists = persisted !== null && (await pathExists(persisted));

		// The persisted workingDirectory is the source of truth. We only fall
		// back to useWorktree for legacy or first-run cards.
		let taskCwd: string;
		if (persistedExists) {
			taskCwd = persisted;
		} else if (useWorktree) {
			taskCwd = await resolveTaskCwd({
				cwd: projectScope.projectPath,
				taskId: body.taskId,
				baseRef: body.baseRef,
				ensure: true,
				branch: savedBranch,
			});
		} else {
			taskCwd = projectScope.projectPath;
		}

		// workingDirectory is persisted by the client after the response
		// arrives (via summary.sessionLaunchPath). This avoids a dual-writer
		// race where the server bumps the revision while the client's
		// persist debounce is in flight.

		const shouldCaptureTurnCheckpoint = !body.resumeConversation;

		const terminalManager = await deps.getScopedTerminalManager(projectScope);
		const previousSummary = body.resumeConversation ? terminalManager.store.getSummary(body.taskId) : null;
		const previousTerminalAgentId = previousSummary?.agentId ?? null;
		const previousResumeSessionId = previousSummary?.resumeSessionId ?? null;
		const effectiveAgentId = previousTerminalAgentId ?? taskAgentId ?? scopedRuntimeConfig.selectedAgentId;
		const failedStoredResumeSession = hasFailedStoredCodexResume(previousSummary);
		const resumeSessionIdForStart = failedStoredResumeSession ? null : previousResumeSessionId;
		if (body.resumeConversation) {
			log.debug("resume path: loaded previous session summary", {
				taskId: body.taskId,
				hasPreviousSummary: Boolean(previousSummary),
				previousAgentId: previousTerminalAgentId,
				previousResumeSessionId,
				failedStoredResumeSession,
				previousState: previousSummary?.state ?? null,
				previousReviewReason: previousSummary?.reviewReason ?? null,
				previousLaunchPath: previousSummary?.sessionLaunchPath ?? null,
				previousPid: previousSummary?.pid ?? null,
				previousStartedAt: previousSummary?.startedAt ?? null,
				taskAgentId,
				effectiveAgentId,
			});
		}
		if (body.resumeConversation && effectiveAgentId === "codex" && failedStoredResumeSession) {
			log.warn("stored Codex resumeSessionId disabled after previous resume failure", {
				taskId: body.taskId,
				agentId: effectiveAgentId,
				previousResumeSessionId,
				previousState: previousSummary?.state ?? null,
				previousReviewReason: previousSummary?.reviewReason ?? null,
				previousLaunchPath: previousSummary?.sessionLaunchPath ?? null,
			});
		} else if (body.resumeConversation && effectiveAgentId === "codex" && !resumeSessionIdForStart) {
			log.warn("resume requested without stored resumeSessionId", {
				taskId: body.taskId,
				agentId: effectiveAgentId,
				previousState: previousSummary?.state ?? null,
				previousReviewReason: previousSummary?.reviewReason ?? null,
				previousLaunchPath: previousSummary?.sessionLaunchPath ?? null,
			});
		}

		const resolvedConfig =
			effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
				? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
				: scopedRuntimeConfig;
		const resolved = await resolveAgentCommand(resolvedConfig);
		if (!resolved) {
			return {
				ok: false,
				summary: null,
				error: "No runnable agent command is configured. Install a supported CLI or choose another agent when creating the task.",
			};
		}
		const resumeContextWarning = getResumeContextWarning({
			resumeConversation: body.resumeConversation,
			useWorktree,
			agentId: resolved.agentId,
			persistedWorkingDirectory: persisted,
			previousSessionLaunchPath: previousSummary?.sessionLaunchPath,
			projectPath: projectScope.projectPath,
		});
		if (resumeContextWarning) {
			log.warn("resume requested after task worktree identity was lost", {
				taskId: body.taskId,
				agentId: resolved.agentId,
				previousSessionLaunchPath: previousSummary?.sessionLaunchPath ?? null,
				projectPath: projectScope.projectPath,
				resolvedTaskCwd: taskCwd,
			});
		}
		const codexResumeSessionWarning = getCodexResumeSessionWarning({
			resumeConversation: body.resumeConversation,
			agentId: resolved.agentId,
			resumeSessionId: resumeSessionIdForStart,
			failedStoredResumeSession,
		});
		log.debug("handing start-task-session request to terminal manager", {
			taskId: body.taskId,
			agentId: resolved.agentId,
			binary: resolved.binary,
			taskCwd,
			resumeConversation: body.resumeConversation ?? false,
			resumeSessionIdPassed: resumeSessionIdForStart ?? null,
			awaitReview: body.awaitReview ?? false,
		});
		const summary = await terminalManager.startTaskSession({
			taskId: body.taskId,
			agentId: resolved.agentId,
			binary: resolved.binary,
			args: resolved.args,
			cwd: taskCwd,
			prompt: body.prompt,
			images: body.images,
			resumeConversation: body.resumeConversation,
			resumeSessionId: resumeSessionIdForStart ?? undefined,
			awaitReview: body.awaitReview,
			cols: body.cols,
			rows: body.rows,
			projectId: projectScope.projectId,
			projectPath: projectScope.projectPath,
			statuslineEnabled: scopedRuntimeConfig.statuslineEnabled,
			worktreeSystemPromptTemplate: scopedRuntimeConfig.worktreeSystemPromptTemplate,
			agentTerminalRowMultiplier: scopedRuntimeConfig.agentTerminalRowMultiplier,
			env: body.baseRef ? { QUARTERDECK_BASE_REF: body.baseRef } : undefined,
		});
		if (scopedRuntimeConfig.llmSummaryPolishEnabled) {
			queueTaskDisplaySummaryPolish({
				projectScope,
				taskId: body.taskId,
				deps,
				reason: "task-started",
				promptOverride: body.prompt,
			});
		}

		let nextSummary = summary;
		if (shouldCaptureTurnCheckpoint) {
			queueStartTurnCheckpointCapture({
				terminalManager,
				taskId: body.taskId,
				taskCwd,
				summary,
			});
		}
		if (resumeContextWarning) {
			nextSummary =
				terminalManager.store.update(body.taskId, {
					warningMessage: resumeContextWarning,
				}) ?? nextSummary;
		} else if (codexResumeSessionWarning) {
			nextSummary =
				terminalManager.store.update(body.taskId, {
					warningMessage: codexResumeSessionWarning,
				}) ?? nextSummary;
		}
		log.debug("start-task-session returning ok", {
			taskId: body.taskId,
			agentId: nextSummary?.agentId ?? null,
			state: nextSummary?.state ?? null,
			reviewReason: nextSummary?.reviewReason ?? null,
			pid: nextSummary?.pid ?? null,
			startedAt: nextSummary?.startedAt ?? null,
			resumeSessionIdOnSummary: nextSummary?.resumeSessionId ?? null,
			sessionLaunchPath: nextSummary?.sessionLaunchPath ?? null,
		});
		return {
			ok: true,
			summary: nextSummary,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn("start-task-session returning error", { error: message });
		return {
			ok: false,
			summary: null,
			error: message,
		};
	}
}
