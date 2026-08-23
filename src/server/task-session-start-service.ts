import { resolveAgentCommand } from "../config";
import {
	createTaggedLogger,
	findCardInBoard,
	type IRuntimeConfigProvider,
	isRuntimeTaskBaseRefResolved,
	type RuntimeTaskSessionStartRequest,
	type RuntimeTaskSessionSummary,
	type TaskResourceOperationRunner,
} from "../core";
import { loadProjectState } from "../state";
import {
	assertPtyRuntimeAvailable,
	cloneStartTaskSessionRequest,
	PtyRuntimeDependencyError,
	type StartTaskSessionRequest,
	type TerminalSessionManager,
} from "../terminal";
import { hasFailedStoredCodexResume, STORED_CODEX_RESUME_FAILED_WARNING } from "../terminal/codex-resume-failure";
import { pathExists, resolveTaskCwd } from "../workdir";

const log = createTaggedLogger("task-session-start");

export interface TaskSessionProjectScope {
	projectId: string;
	projectPath: string;
}

export interface TaskSessionStartServiceDependencies {
	config: Pick<IRuntimeConfigProvider, "loadScopedRuntimeConfig">;
	getScopedTerminalManager: (scope: TaskSessionProjectScope) => Promise<TerminalSessionManager>;
	assertTerminalRuntimeAvailable?: () => void;
}

export interface SerializedTaskSessionStartServiceDependencies extends TaskSessionStartServiceDependencies {
	taskResourceOperations: TaskResourceOperationRunner;
}

export interface TaskSessionStartServiceOptions {
	/**
	 * Ties an automatic startup recovery launch to the coordinator that owns it.
	 * Explicit user starts omit this token and cancel any queued recovery.
	 */
	startupRecoveryToken?: string;
	/**
	 * Preserve the original startup resume choice, including an explicit absence
	 * of a stored id. A targeted retry cannot silently change to --last; a null
	 * target intentionally repeats the same best-effort resume strategy.
	 */
	resumeSessionIdOverride?: string | null;
}

export interface TaskSessionStartServiceResult {
	summary: RuntimeTaskSessionSummary;
	terminalManager: TerminalSessionManager;
	taskCwd: string;
	sessionInstanceId: string | null;
	startedNewSession: boolean;
	llmSummaryPolishEnabled: boolean;
}

export interface PreparedTaskSessionStart {
	terminalManager: TerminalSessionManager;
	request: StartTaskSessionRequest;
	taskCwd: string;
	llmSummaryPolishEnabled: boolean;
	resumeContextWarning: string | null;
	resumeSessionWarning: string | null;
}

function getResumeContextWarning(options: {
	resumeConversation: boolean | undefined;
	useWorktree: boolean;
	agentId: string;
	resumeSessionId: string | null | undefined;
	persistedWorkingDirectory: string | null;
	previousSessionLaunchPath: string | null | undefined;
	projectPath: string;
}): string | null {
	if (!options.resumeConversation || !options.useWorktree || options.agentId !== "claude") {
		return null;
	}
	if (options.resumeSessionId || options.persistedWorkingDirectory) {
		return null;
	}
	const previousSessionLaunchPath = options.previousSessionLaunchPath?.trim() ?? "";
	if (!previousSessionLaunchPath || previousSessionLaunchPath === options.projectPath) {
		return null;
	}
	return "Claude resume after trash restore is best-effort only: no stored session id is available and the original task worktree was deleted, so --continue may not reopen the previous chat.";
}

function getResumeSessionWarning(options: {
	resumeConversation: boolean | undefined;
	useWorktree: boolean;
	agentId: string;
	resumeSessionId: string | null | undefined;
	failedStoredResumeSession: boolean;
}): string | null {
	if (!options.resumeConversation) {
		return null;
	}
	if (options.agentId === "codex") {
		if (options.failedStoredResumeSession) {
			return STORED_CODEX_RESUME_FAILED_WARNING;
		}
		if (options.resumeSessionId) {
			return null;
		}
		return "Codex resume did not have a stored session id, so Quarterdeck fell back to the most recent Codex session for this checkout. If this opens the wrong conversation, start a fresh task.";
	}
	if (options.agentId === "claude" && !options.useWorktree && !options.resumeSessionId) {
		return "Claude resume did not have a stored session id, so Quarterdeck fell back to the most recent Claude session for this checkout. If this opens the wrong conversation, start a fresh task.";
	}
	return null;
}

/**
 * The single preparation path for both explicit task starts and automatic
 * startup recovery. Keeping worktree recreation, per-task agent selection,
 * resume identity, and launch settings here makes recovery equivalent to the
 * manual restart that previously repaired these sessions.
 */
export async function prepareTaskSessionStart(
	projectScope: TaskSessionProjectScope,
	body: RuntimeTaskSessionStartRequest,
	deps: TaskSessionStartServiceDependencies,
	options: TaskSessionStartServiceOptions = {},
): Promise<PreparedTaskSessionStart> {
	const scopedRuntimeConfig = await deps.config.loadScopedRuntimeConfig(projectScope);
	const useWorktree = body.useWorktree !== false;
	if (useWorktree && !isRuntimeTaskBaseRefResolved({ baseRef: body.baseRef })) {
		throw new Error("Select a base branch before starting this task.");
	}
	try {
		(deps.assertTerminalRuntimeAvailable ?? assertPtyRuntimeAvailable)();
	} catch (error) {
		if (error instanceof PtyRuntimeDependencyError) {
			log.error("terminal runtime dependency health check failed before task preparation", {
				taskId: body.taskId,
				issue: error.health.issue,
				platform: error.health.platform,
				arch: error.health.arch,
			});
		}
		throw error;
	}

	const state = await loadProjectState(projectScope.projectPath);
	const existingCard = findCardInBoard(state.board, body.taskId);
	const persisted = existingCard?.workingDirectory ?? null;
	const taskAgentId = existingCard?.agentId ?? body.agentId ?? null;
	const savedBranch = existingCard?.branch ?? null;
	const persistedExists = persisted !== null && (await pathExists(persisted));

	// A still-existing persisted path is authoritative. Missing isolated paths
	// go through the same branch-aware worktree recreation used by manual
	// Restart; shared-checkout tasks fall back to the project root.
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
	// Do not write the recreated working directory into board state here. The
	// browser remains the single board writer and persists summary.sessionLaunchPath
	// through its normal optimistic save cycle.

	const terminalManager = await deps.getScopedTerminalManager(projectScope);
	const previousSummary = body.resumeConversation ? terminalManager.store.getSummary(body.taskId) : null;
	const previousTerminalAgentId = previousSummary?.agentId ?? null;
	const previousResumeSessionId = previousSummary?.resumeSessionId ?? null;
	const effectiveAgentId = previousTerminalAgentId ?? taskAgentId ?? scopedRuntimeConfig.selectedAgentId;
	const hasResumeOverride = Object.hasOwn(options, "resumeSessionIdOverride");
	const failedStoredResumeSession = !hasResumeOverride && hasFailedStoredCodexResume(previousSummary);
	const resumeSessionIdForStart = hasResumeOverride
		? options.resumeSessionIdOverride
		: failedStoredResumeSession
			? null
			: previousResumeSessionId;

	if (body.resumeConversation) {
		log.debug("resume path: loaded previous session summary", {
			taskId: body.taskId,
			hasPreviousSummary: Boolean(previousSummary),
			previousAgentId: previousTerminalAgentId,
			previousResumeSessionId,
			resumeSessionIdOverride: hasResumeOverride ? (options.resumeSessionIdOverride ?? null) : undefined,
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
	} else if (
		body.resumeConversation &&
		(effectiveAgentId === "codex" || effectiveAgentId === "claude") &&
		!resumeSessionIdForStart
	) {
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
		throw new Error(
			"No runnable agent command is configured. Install a supported CLI or choose another agent when creating the task.",
		);
	}

	const resumeContextWarning = getResumeContextWarning({
		resumeConversation: body.resumeConversation,
		useWorktree,
		agentId: resolved.agentId,
		resumeSessionId: resumeSessionIdForStart,
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
	const resumeSessionWarning = getResumeSessionWarning({
		resumeConversation: body.resumeConversation,
		useWorktree,
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
		startupRecovery: Boolean(options.startupRecoveryToken),
	});

	const request: StartTaskSessionRequest = {
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
		claudeFullscreenEnabled: scopedRuntimeConfig.claudeFullscreenEnabled,
		statuslineEnabled: scopedRuntimeConfig.statuslineEnabled,
		worktreeSystemPromptTemplate: scopedRuntimeConfig.worktreeSystemPromptTemplate,
		env: body.baseRef ? { QUARTERDECK_BASE_REF: body.baseRef } : undefined,
		startupRecoveryToken: options.startupRecoveryToken,
	};

	return {
		terminalManager,
		request,
		taskCwd,
		llmSummaryPolishEnabled: scopedRuntimeConfig.llmSummaryPolishEnabled,
		resumeContextWarning,
		resumeSessionWarning,
	};
}

/**
 * Launches an already-resolved task session. Startup recovery prepares once,
 * then repeats only this frozen launch request so both attempts use the same
 * agent, command, cwd, settings, and resume identity.
 */
export async function launchPreparedTaskSession(
	prepared: PreparedTaskSessionStart,
): Promise<TaskSessionStartServiceResult> {
	const { terminalManager } = prepared;
	const request = cloneStartTaskSessionRequest(prepared.request);
	let summary: RuntimeTaskSessionSummary;
	let sessionInstanceId: string | null = null;
	let startedNewSession = true;
	if (request.startupRecoveryToken) {
		const startResult = await terminalManager.startTaskSessionWithReadiness(request);
		summary = startResult.summary;
		sessionInstanceId = startResult.sessionInstanceId;
		startedNewSession = startResult.startedNewSession;
	} else {
		summary = await terminalManager.startTaskSession(request);
	}

	let nextSummary = summary;
	if (prepared.resumeContextWarning) {
		nextSummary =
			terminalManager.store.update(request.taskId, { warningMessage: prepared.resumeContextWarning }) ?? nextSummary;
	} else if (prepared.resumeSessionWarning) {
		nextSummary =
			terminalManager.store.update(request.taskId, { warningMessage: prepared.resumeSessionWarning }) ?? nextSummary;
	}

	return {
		summary: nextSummary,
		terminalManager,
		taskCwd: prepared.taskCwd,
		sessionInstanceId,
		startedNewSession,
		llmSummaryPolishEnabled: prepared.llmSummaryPolishEnabled,
	};
}

export async function startTaskSessionThroughService(
	projectScope: TaskSessionProjectScope,
	body: RuntimeTaskSessionStartRequest,
	deps: SerializedTaskSessionStartServiceDependencies,
	options: TaskSessionStartServiceOptions = {},
): Promise<TaskSessionStartServiceResult> {
	return await deps.taskResourceOperations.run(projectScope.projectId, body.taskId, async () => {
		const prepared = await prepareTaskSessionStart(projectScope, body, deps, options);
		return await launchPreparedTaskSession(prepared);
	});
}
