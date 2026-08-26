import { randomUUID } from "node:crypto";

import { createTaggedLogger, type RuntimeTaskSessionStartRequest } from "../core";
import type { SessionResumeSemanticState, StartupRecoveryReviewState, TerminalSessionManager } from "../terminal";
import type { TaskSessionLaunchReadinessOutcome } from "../terminal/session-launch-readiness";
import type {
	PreparedTaskSessionStart,
	TaskSessionProjectScope,
	TaskSessionStartServiceResult,
} from "./task-session-start-service";

const log = createTaggedLogger("startup-session-recovery");

export const STARTUP_RECOVERY_MAX_ATTEMPTS = 2;
// The first launch gets a deliberately conservative window because initial
// runtime startup can be busy. The retry window is shorter because a second
// timeout leaves that process running instead of triggering another restart.
export const STARTUP_RECOVERY_FIRST_READINESS_TIMEOUT_MS = 45_000;
export const STARTUP_RECOVERY_RETRY_READINESS_TIMEOUT_MS = 20_000;
export const STARTUP_RECOVERY_STABILITY_MS = 500;
export const STARTUP_RECOVERY_RETRY_DELAY_MS = 1_000;
export const STARTUP_RECOVERY_LAUNCH_SPACING_MS = 1_000;
export const STARTUP_RECOVERY_STOP_TIMEOUT_MS = 3_000;

export type StartupRecoveryStopResult = "stopped" | "inactive" | "superseded" | "timeout";
export type StartupRecoveryFailureReason =
	| "preparation_failed"
	| "launch_failed"
	| "exited"
	| "identity_mismatch"
	| "stop_timeout";

export type StartupRecoveryTerminalManager = Pick<
	TerminalSessionManager,
	| "beginStartupRecovery"
	| "isStartupRecoveryCurrent"
	| "isTaskSessionLaunchActive"
	| "completeStartupRecovery"
	| "finalizeStartupRecoveryFailure"
	| "waitForTaskSessionLaunch"
	| "stopTaskSessionForStartupRecovery"
	| "store"
>;

export interface StartupSessionRecoveryCandidate {
	scope: TaskSessionProjectScope;
	request: RuntimeTaskSessionStartRequest;
	manager: TerminalSessionManager;
	originalResumeSessionId: string | null;
	semanticState: SessionResumeSemanticState;
	/** Whether the semantic state is neutral because it came from incomplete legacy persistence. */
	semanticStateUncertain: boolean;
	/** Semantic state to restore if chat recovery fails without invalidating completed work. */
	fallbackReviewState: StartupRecoveryReviewState | null;
	/** Present only when a legacy record no longer contains enough information to classify prior task meaning. */
	semanticStateWarning?: string;
}

export type StartupSessionRecoveryResult =
	| { status: "ready" | "user_engaged"; attempts: number; taskId: string }
	| {
			status: "unconfirmed";
			attempts: number;
			taskId: string;
			reason: "timeout";
			sessionInstanceId: string;
	  }
	| { status: "cancelled" | "duplicate" | "closed"; attempts: number; taskId: string }
	| {
			status: "exhausted";
			attempts: number;
			taskId: string;
			reason: StartupRecoveryFailureReason;
	  };

export interface StartupSessionRecoveryCoordinatorOptions {
	waitForPrerequisite?: () => Promise<void>;
	prepare: (
		candidate: StartupSessionRecoveryCandidate,
		options: {
			startupRecoveryToken: string;
			resumeSessionIdOverride: string | null;
			startupRecoverySemanticState: SessionResumeSemanticState;
			startupRecoverySemanticStateUncertain: boolean;
			startupRecoveryWarningMessage?: string;
		},
	) => Promise<PreparedTaskSessionStart>;
	launch: (prepared: PreparedTaskSessionStart) => Promise<TaskSessionStartServiceResult>;
	firstReadinessTimeoutMs?: number;
	retryReadinessTimeoutMs?: number;
	stabilityMs?: number;
	retryDelayMs?: number;
	launchSpacingMs?: number;
	stopTimeoutMs?: number;
	now?: () => number;
	delay?: (milliseconds: number) => Promise<void>;
}

function defaultDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readinessFailureReason(outcome: TaskSessionLaunchReadinessOutcome): "exited" | "identity_mismatch" | null {
	switch (outcome.status) {
		case "exited":
			return "exited";
		case "identity_mismatch":
			return "identity_mismatch";
		default:
			return null;
	}
}

function recoveryWarning(reason: StartupRecoveryFailureReason, detail?: string): string {
	switch (reason) {
		case "preparation_failed":
			return `Startup restore could not prepare this task${detail ? `: ${detail}` : "."} Use Restart to try again.`;
		case "identity_mismatch":
			return "Startup restore did not reopen the expected conversation after its bounded retry, so Quarterdeck stopped. Use Restart to try the task again.";
		case "stop_timeout":
			return "Startup restore could not stop the previous launch safely, so Quarterdeck did not start another copy. Use Restart after the process finishes exiting.";
		case "exited":
			return "Startup restore still exited before the chat initialized after its bounded retry. Use Restart to try the task again.";
		case "launch_failed":
			return "Startup restore could not launch the chat after two attempts. Use Restart to try the task again.";
	}
}

function shouldClearFailedResumeSessionId(
	candidate: StartupSessionRecoveryCandidate,
	lastExitCode: number | null | undefined,
): boolean {
	if (
		!candidate.originalResumeSessionId ||
		lastExitCode === null ||
		lastExitCode === undefined ||
		lastExitCode === 0
	) {
		return false;
	}
	const agentId = candidate.manager.store.getSummary(candidate.request.taskId)?.agentId;
	return agentId === "codex" || agentId === "claude" || agentId === "pi";
}

/**
 * Coordinates automatic startup recovery across every project. Actual process
 * launches are serialized globally while task readiness waits proceed
 * independently. A launch-scoped hook confirms conversation identity; a live
 * hookless launch remains available as unconfirmed. Explicit input/start/stop
 * actions clear the manager token and cancel queued or in-flight recovery.
 */
export class StartupSessionRecoveryCoordinator {
	private readonly waitForPrerequisite: () => Promise<void>;
	private readonly prepare: StartupSessionRecoveryCoordinatorOptions["prepare"];
	private readonly launch: StartupSessionRecoveryCoordinatorOptions["launch"];
	private readonly firstReadinessTimeoutMs: number;
	private readonly retryReadinessTimeoutMs: number;
	private readonly stabilityMs: number;
	private readonly retryDelayMs: number;
	private readonly launchSpacingMs: number;
	private readonly stopTimeoutMs: number;
	private readonly now: () => number;
	private readonly delay: (milliseconds: number) => Promise<void>;
	private prerequisite: Promise<void> | null = null;
	private launchQueueTail: Promise<void> = Promise.resolve();
	private readonly attemptedTasksByManager = new WeakMap<TerminalSessionManager, Set<string>>();
	private lastLaunchAt = 0;
	private closed = false;

	constructor(options: StartupSessionRecoveryCoordinatorOptions) {
		this.waitForPrerequisite = options.waitForPrerequisite ?? (async () => {});
		this.prepare = options.prepare;
		this.launch = options.launch;
		this.firstReadinessTimeoutMs = options.firstReadinessTimeoutMs ?? STARTUP_RECOVERY_FIRST_READINESS_TIMEOUT_MS;
		this.retryReadinessTimeoutMs = options.retryReadinessTimeoutMs ?? STARTUP_RECOVERY_RETRY_READINESS_TIMEOUT_MS;
		this.stabilityMs = options.stabilityMs ?? STARTUP_RECOVERY_STABILITY_MS;
		this.retryDelayMs = options.retryDelayMs ?? STARTUP_RECOVERY_RETRY_DELAY_MS;
		this.launchSpacingMs = options.launchSpacingMs ?? STARTUP_RECOVERY_LAUNCH_SPACING_MS;
		this.stopTimeoutMs = options.stopTimeoutMs ?? STARTUP_RECOVERY_STOP_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		this.delay = options.delay ?? defaultDelay;
	}

	close(): void {
		this.closed = true;
	}

	enqueue(candidate: StartupSessionRecoveryCandidate): Promise<StartupSessionRecoveryResult> {
		if (this.closed) {
			return Promise.resolve({ status: "closed", attempts: 0, taskId: candidate.request.taskId });
		}
		const attemptedTasks = this.attemptedTasksByManager.get(candidate.manager) ?? new Set<string>();
		if (attemptedTasks.has(candidate.request.taskId)) {
			return Promise.resolve({ status: "duplicate", attempts: 0, taskId: candidate.request.taskId });
		}
		attemptedTasks.add(candidate.request.taskId);
		this.attemptedTasksByManager.set(candidate.manager, attemptedTasks);
		const token = randomUUID();
		if (!candidate.manager.beginStartupRecovery(candidate.request.taskId, token)) {
			return Promise.resolve({ status: "duplicate", attempts: 0, taskId: candidate.request.taskId });
		}
		return this.recover(candidate, token);
	}

	private async awaitPrerequisite(): Promise<void> {
		this.prerequisite ??= this.waitForPrerequisite().catch((error) => {
			log.warn("startup recovery prerequisite failed; continuing with bounded recovery", {
				error: errorMessage(error),
			});
		});
		await this.prerequisite;
	}

	private async launchInGlobalSlot(
		candidate: StartupSessionRecoveryCandidate,
		token: string,
		prepared: PreparedTaskSessionStart,
		onLaunchStart: () => void,
	): Promise<TaskSessionStartServiceResult | null> {
		let releaseSlot: (() => void) | undefined;
		const previousSlot = this.launchQueueTail;
		this.launchQueueTail = new Promise<void>((resolve) => {
			releaseSlot = resolve;
		});
		await previousSlot;
		try {
			const remaining = this.lastLaunchAt + this.launchSpacingMs - this.now();
			if (remaining > 0) {
				await this.delay(remaining);
			}
			if (this.closed || !candidate.manager.isStartupRecoveryCurrent(candidate.request.taskId, token)) {
				return null;
			}
			this.lastLaunchAt = this.now();
			onLaunchStart();
			return await this.launch(prepared);
		} finally {
			releaseSlot?.();
		}
	}

	private async stopFailedLaunch(
		candidate: StartupSessionRecoveryCandidate,
		token: string,
		sessionInstanceId: string,
	): Promise<StartupRecoveryStopResult> {
		return await candidate.manager.stopTaskSessionForStartupRecovery(
			candidate.request.taskId,
			sessionInstanceId,
			token,
			this.stopTimeoutMs,
		);
	}

	private readinessTimeoutForAttempt(attempt: number): number {
		return attempt === 1 ? this.firstReadinessTimeoutMs : this.retryReadinessTimeoutMs;
	}

	private finalizeFailure(
		candidate: StartupSessionRecoveryCandidate,
		token: string,
		reason: StartupRecoveryFailureReason,
		lastSessionInstanceId: string | null,
		lastExitCode: number | null | undefined,
		detail?: string,
	): void {
		const taskId = candidate.request.taskId;
		const processStillRunning = lastSessionInstanceId
			? candidate.manager.isTaskSessionLaunchActive(taskId, lastSessionInstanceId, token)
			: false;
		const clearResumeSessionId = shouldClearFailedResumeSessionId(candidate, lastExitCode);
		const baseWarning = recoveryWarning(reason, detail);
		const warningMessage = clearResumeSessionId
			? `${baseWarning} The stored conversation id failed during bounded recovery, so Restart will use the agent's best-effort resume path.`
			: baseWarning;
		candidate.manager.finalizeStartupRecoveryFailure(taskId, token, {
			processStillRunning,
			clearResumeSessionId,
			warningMessage,
			fallbackReviewState: candidate.fallbackReviewState,
		});
	}

	private async recover(
		candidate: StartupSessionRecoveryCandidate,
		token: string,
	): Promise<StartupSessionRecoveryResult> {
		const taskId = candidate.request.taskId;
		let attempts = 0;
		let lastSessionInstanceId: string | null = null;
		let lastExitCode: number | null | undefined;
		let finalReason: StartupRecoveryFailureReason = "launch_failed";
		let failureDetail: string | undefined;
		try {
			await this.awaitPrerequisite();
			if (this.closed || !candidate.manager.isStartupRecoveryCurrent(taskId, token)) {
				return { status: "cancelled", attempts, taskId };
			}

			const preparationStartedAt = this.now();
			let prepared: PreparedTaskSessionStart;
			try {
				prepared = await this.prepare(candidate, {
					startupRecoveryToken: token,
					resumeSessionIdOverride: candidate.originalResumeSessionId,
					startupRecoverySemanticState: candidate.semanticState,
					startupRecoverySemanticStateUncertain: candidate.semanticStateUncertain,
					startupRecoveryWarningMessage: candidate.semanticStateWarning,
				});
			} catch (error) {
				if (this.closed || !candidate.manager.isStartupRecoveryCurrent(taskId, token)) {
					return { status: "cancelled", attempts, taskId };
				}
				failureDetail = errorMessage(error);
				finalReason = "preparation_failed";
				this.finalizeFailure(candidate, token, finalReason, null, undefined, failureDetail);
				log.warn("startup recovery preparation failed without retrying deterministic setup", {
					projectId: candidate.scope.projectId,
					taskId,
					preparationElapsedMs: Math.max(0, this.now() - preparationStartedAt),
					error: failureDetail,
				});
				return { status: "exhausted", attempts, taskId, reason: finalReason };
			}
			log.info("startup recovery prepared frozen task launch", {
				projectId: candidate.scope.projectId,
				taskId,
				agentId: prepared.request.agentId,
				cwd: prepared.request.cwd,
				hasResumeSessionId: Boolean(prepared.request.resumeSessionId),
				preparationElapsedMs: Math.max(0, this.now() - preparationStartedAt),
			});

			for (let attempt = 1; attempt <= STARTUP_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
				if (this.closed || !candidate.manager.isStartupRecoveryCurrent(taskId, token)) {
					return { status: "cancelled", attempts, taskId };
				}
				if (attempt > 1 && this.retryDelayMs > 0) {
					await this.delay(this.retryDelayMs);
				}
				let started: TaskSessionStartServiceResult;
				const launchStartedAt = this.now();
				try {
					const launchResult = await this.launchInGlobalSlot(candidate, token, prepared, () => {
						attempts = attempt;
					});
					if (!launchResult) {
						return { status: "cancelled", attempts, taskId };
					}
					started = launchResult;
				} catch (error) {
					finalReason = "launch_failed";
					failureDetail = errorMessage(error);
					log.warn("startup recovery launch failed", {
						projectId: candidate.scope.projectId,
						taskId,
						attempt,
						launchElapsedMs: Math.max(0, this.now() - launchStartedAt),
						error: failureDetail,
					});
					continue;
				}

				if (!started.startedNewSession || !started.sessionInstanceId) {
					return { status: "cancelled", attempts, taskId };
				}
				lastSessionInstanceId = started.sessionInstanceId;
				lastExitCode = undefined;
				const readinessTimeoutMs = this.readinessTimeoutForAttempt(attempt);
				const readinessStartedAt = this.now();
				const outcome = await candidate.manager.waitForTaskSessionLaunch(
					taskId,
					started.sessionInstanceId,
					readinessTimeoutMs,
				);
				const readinessElapsedMs = Math.max(0, this.now() - readinessStartedAt);
				if (outcome.status === "ready") {
					if (this.stabilityMs > 0) {
						await this.delay(this.stabilityMs);
					}
					if (!candidate.manager.isStartupRecoveryCurrent(taskId, token)) {
						return { status: "cancelled", attempts, taskId };
					}
					if (!candidate.manager.isTaskSessionLaunchActive(taskId, started.sessionInstanceId, token)) {
						finalReason = "exited";
						lastExitCode = candidate.manager.store.getSummary(taskId)?.exitCode;
						log.warn("startup recovery task exited during readiness stabilization", {
							projectId: candidate.scope.projectId,
							taskId,
							attempt,
							sessionInstanceId: started.sessionInstanceId,
						});
						continue;
					}
					// Hand subsequent process exits back to the normal crash policy before
					// returning success; this closes the gap between stabilization and the
					// finally cleanup below.
					candidate.manager.completeStartupRecovery(taskId, token);
					log.info("startup recovery confirmed task chat readiness", {
						projectId: candidate.scope.projectId,
						taskId,
						attempt,
						sessionInstanceId: started.sessionInstanceId,
						observedSessionId: outcome.observedSessionId,
						launchElapsedMs: Math.max(0, readinessStartedAt - launchStartedAt),
						readinessElapsedMs,
						readinessTimeoutMs,
					});
					return { status: "ready", attempts, taskId };
				}
				if (outcome.status === "user_engaged") {
					return { status: "user_engaged", attempts, taskId };
				}
				if (outcome.status === "cancelled" || outcome.status === "superseded") {
					return { status: "cancelled", attempts, taskId };
				}

				finalReason = readinessFailureReason(outcome) ?? "launch_failed";
				if (outcome.status === "exited") {
					lastExitCode = outcome.exitCode;
				}
				log.warn("startup recovery did not confirm task chat readiness", {
					projectId: candidate.scope.projectId,
					taskId,
					attempt,
					outcome: outcome.status,
					sessionInstanceId: started.sessionInstanceId,
					readinessElapsedMs,
					readinessTimeoutMs,
				});
				if (
					outcome.status === "timeout" &&
					candidate.manager.isTaskSessionLaunchActive(taskId, started.sessionInstanceId, token)
				) {
					// A resumed interactive TUI can be fully restored and idle without
					// emitting a launch hook. Absence of that optional identity confirmation is not
					// positive evidence that the live PTY failed. Keep the process that the
					// user can inspect instead of destroying it and replaying the same launch.
					candidate.manager.completeStartupRecovery(taskId, token);
					log.warn("startup recovery left live task chat running without hook confirmation", {
						projectId: candidate.scope.projectId,
						taskId,
						attempt,
						sessionInstanceId: started.sessionInstanceId,
						readinessElapsedMs,
						readinessTimeoutMs,
					});
					return {
						status: "unconfirmed",
						attempts,
						taskId,
						reason: "timeout",
						sessionInstanceId: started.sessionInstanceId,
					};
				}
				if (outcome.status === "timeout") {
					// The process disappeared without settling the launch monitor. Treat
					// that race as an exit so timeout warnings never claim a process was
					// preserved when no matching launch remains active.
					finalReason = "exited";
					lastExitCode = candidate.manager.store.getSummary(taskId)?.exitCode;
				}
				if (attempt === STARTUP_RECOVERY_MAX_ATTEMPTS) {
					if (outcome.status === "identity_mismatch") {
						const stopResult = await this.stopFailedLaunch(candidate, token, started.sessionInstanceId);
						if (stopResult === "timeout") {
							finalReason = "stop_timeout";
						} else if (stopResult === "superseded") {
							return { status: "cancelled", attempts, taskId };
						}
					}
					break;
				}
				if (outcome.status !== "exited") {
					const stopResult = await this.stopFailedLaunch(candidate, token, started.sessionInstanceId);
					if (stopResult === "timeout") {
						finalReason = "stop_timeout";
						break;
					}
					if (stopResult === "superseded") {
						return { status: "cancelled", attempts, taskId };
					}
				}
			}

			if (this.closed || !candidate.manager.isStartupRecoveryCurrent(taskId, token)) {
				return { status: "cancelled", attempts, taskId };
			}
			this.finalizeFailure(candidate, token, finalReason, lastSessionInstanceId, lastExitCode, failureDetail);
			log.warn("startup recovery exhausted bounded attempts", {
				projectId: candidate.scope.projectId,
				taskId,
				attempts,
				reason: finalReason,
			});
			return { status: "exhausted", attempts, taskId, reason: finalReason };
		} catch (error) {
			if (this.closed || !candidate.manager.isStartupRecoveryCurrent(taskId, token)) {
				return { status: "cancelled", attempts, taskId };
			}
			failureDetail = errorMessage(error);
			this.finalizeFailure(candidate, token, "launch_failed", lastSessionInstanceId, lastExitCode, failureDetail);
			log.warn("startup recovery failed unexpectedly", {
				projectId: candidate.scope.projectId,
				taskId,
				attempts,
				error: failureDetail,
			});
			return { status: "exhausted", attempts, taskId, reason: "launch_failed" };
		} finally {
			candidate.manager.completeStartupRecovery(taskId, token);
		}
	}
}
