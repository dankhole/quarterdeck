import { resolveAgentCommandForLaunch } from "../config";
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
	deriveSessionResumeSemanticState,
	PtyRuntimeDependencyError,
	type SessionResumeSemanticState,
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
	/** Server-owned execution fencing checked while holding the task resource lock. */
	assertStartAllowed?: () => Promise<void>;
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
	/** Restore the process without changing the task meaning already shown to the user. */
	startupRecoverySemanticState?: SessionResumeSemanticState;
	/** Distinguish an honest modern Interrupted recovery from semantically incomplete legacy persistence. */
	startupRecoverySemanticStateUncertain?: boolean;
	/** Explain why a legacy recovery remains semantically neutral until new agent evidence arrives. */
	startupRecoveryWarningMessage?: string;
	/** Reuse the exact launch path during an execution-owner handoff; never recreate it. */
	requiredExistingLaunchPath?: string;
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
	startupRecoveryWarningMessage?: string | null;
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
	if (options.agentId === "pi" && !options.resumeSessionId) {
		return "Pi resume did not have a stored session id, so Quarterdeck will use Pi's most recent session for this checkout. Verify the conversation before continuing.";
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
	const taskColumnId = state.board.columns.find((column) => column.cards.some((card) => card.id === body.taskId))?.id;
	// Lifecycle-owned launches carry an operation id. Re-check the durable board
	// after acquiring the task resource lock so a rejected or superseded board
	// transition can never leak into a process launch.
	if (body.launchOperationId && (!existingCard || taskColumnId === "backlog" || taskColumnId === "trash")) {
		const error = !existingCard
			? "Task no longer exists."
			: taskColumnId === "trash"
				? "Restore the task before starting its session."
				: "Move the task to in progress before starting its session.";
		log.warn("task session start rejected by durable board state", {
			projectId: projectScope.projectId,
			taskId: body.taskId,
			taskColumnId,
			launchOperationId: body.launchOperationId,
			error,
		});
		throw new Error(error);
	}
	const persisted = existingCard?.workingDirectory ?? null;
	const taskAgentId = existingCard?.agentId ?? body.agentId ?? null;
	const savedBranch = existingCard?.branch ?? null;
	const persistedExists = persisted !== null && (await pathExists(persisted));

	// A still-existing persisted path is authoritative. Missing isolated paths
	// go through the same branch-aware worktree recreation used by manual
	// Restart; shared-checkout tasks fall back to the project root.
	let taskCwd: string;
	if (options.requiredExistingLaunchPath) {
		const requiredPath = options.requiredExistingLaunchPath;
		if (!(await pathExists(requiredPath))) {
			throw new Error("The existing task launch path is unavailable.");
		}
		if (persisted !== null && persisted !== requiredPath) {
			throw new Error("The durable task worktree no longer matches the session launch path.");
		}
		if (persisted === null && requiredPath !== projectScope.projectPath) {
			throw new Error("The task worktree identity is no longer durable.");
		}
		taskCwd = requiredPath;
	} else if (persistedExists) {
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
	// Do not write the recreated working directory directly here. RuntimeStateHub
	// projects launch metadata through ProjectBoardCommandService, which remains
	// the sole durable board writer.

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
	if (
		options.startupRecoveryToken &&
		body.resumeConversation &&
		(effectiveAgentId === "codex" || effectiveAgentId === "claude" || effectiveAgentId === "pi") &&
		!resumeSessionIdForStart?.trim()
	) {
		throw new Error(`Automatic ${effectiveAgentId} recovery requires the exact stored provider session ID.`);
	}

	if (body.resumeConversation) {
		log.debug("resume path: loaded previous session summary", {
			taskId: body.taskId,
			hasPreviousSummary: Boolean(previousSummary),
			previousAgentId: previousTerminalAgentId,
			hasPreviousResumeSessionId: Boolean(previousResumeSessionId),
			hasResumeSessionIdOverride: hasResumeOverride && Boolean(options.resumeSessionIdOverride),
			failedStoredResumeSession,
			previousState: previousSummary?.state ?? null,
			previousReviewReason: previousSummary?.reviewReason ?? null,
			hasPreviousLaunchPath: Boolean(previousSummary?.sessionLaunchPath),
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
			hasPreviousResumeSessionId: Boolean(previousResumeSessionId),
			previousState: previousSummary?.state ?? null,
			previousReviewReason: previousSummary?.reviewReason ?? null,
			hasPreviousLaunchPath: Boolean(previousSummary?.sessionLaunchPath),
		});
	} else if (
		body.resumeConversation &&
		(effectiveAgentId === "codex" || effectiveAgentId === "claude" || effectiveAgentId === "pi") &&
		!resumeSessionIdForStart
	) {
		log.warn("resume requested without stored resumeSessionId", {
			taskId: body.taskId,
			agentId: effectiveAgentId,
			previousState: previousSummary?.state ?? null,
			previousReviewReason: previousSummary?.reviewReason ?? null,
			hasPreviousLaunchPath: Boolean(previousSummary?.sessionLaunchPath),
		});
	}

	const resolvedConfig =
		effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
			? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
			: scopedRuntimeConfig;
	const resolved = options.startupRecoveryToken
		? await resolveAgentCommandForLaunch(resolvedConfig, { retryTransient: true })
		: await resolveAgentCommandForLaunch(resolvedConfig);

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
			hadPreviousSessionLaunchPath: Boolean(previousSummary?.sessionLaunchPath),
			resolvedToProjectRoot: taskCwd === projectScope.projectPath,
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
		hasResolvedBinary: Boolean(resolved.binary),
		resumeConversation: body.resumeConversation ?? false,
		hasResumeSessionId: Boolean(resumeSessionIdForStart),
		awaitReview: body.awaitReview ?? false,
		startupRecovery: Boolean(options.startupRecoveryToken),
	});

	const request: StartTaskSessionRequest = {
		taskId: body.taskId,
		launchOperationId: body.launchOperationId,
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
		claudeLaunchPermissionMode: scopedRuntimeConfig.claudeLaunchPermissionMode,
		statuslineEnabled: scopedRuntimeConfig.statuslineEnabled,
		codexApprovalsReviewer: scopedRuntimeConfig.codexApprovalsReviewer,
		piToolApprovalsEnabled: scopedRuntimeConfig.piToolApprovalsEnabled,
		worktreeSystemPromptTemplate: scopedRuntimeConfig.worktreeSystemPromptTemplate,
		env: body.baseRef ? { QUARTERDECK_BASE_REF: body.baseRef } : undefined,
		startupRecoveryToken: options.startupRecoveryToken,
		resumeSemanticState:
			options.startupRecoverySemanticState ??
			(body.resumeConversation && body.awaitReview && previousSummary
				? deriveSessionResumeSemanticState(previousSummary)
				: undefined),
		startupRecoverySemanticStateUncertain: options.startupRecoverySemanticStateUncertain,
		startupRecoveryWarningMessage: options.startupRecoveryWarningMessage,
	};

	return {
		terminalManager,
		request,
		taskCwd,
		llmSummaryPolishEnabled: scopedRuntimeConfig.llmSummaryPolishEnabled,
		resumeContextWarning,
		resumeSessionWarning,
		startupRecoveryWarningMessage: options.startupRecoveryWarningMessage ?? null,
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
	const warningMessage = [
		prepared.startupRecoveryWarningMessage,
		prepared.resumeContextWarning,
		prepared.resumeSessionWarning,
	]
		.filter((warning): warning is string => Boolean(warning))
		.join(" ");
	if (warningMessage && nextSummary.warningMessage !== warningMessage) {
		nextSummary = terminalManager.store.update(request.taskId, { warningMessage }) ?? nextSummary;
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
		await options.assertStartAllowed?.();
		const prepared = await prepareTaskSessionStart(projectScope, body, deps, options);
		return await launchPreparedTaskSession(prepared);
	});
}
