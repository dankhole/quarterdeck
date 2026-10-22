import type { DiagnosticCaptureScope, DiagnosticContext, DiagnosticLevel } from "../core/api/diagnostics";
import type {
	GitRepositoryProbeFailure,
	GitRepositoryProbeOptions,
	GitRepositoryProbeResult,
} from "../projects/git-repository-probe";

/** Bounds how many individual streaks the snapshot provider ever lists. */
const MAX_SNAPSHOT_STREAKS = 50;

/** Keeps a long-running streak visible in the retained journal between its start and its end. */
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

export const GIT_VALIDATION_FAILED_EVENT = "project.git_validation_failed";
export const GIT_VALIDATION_STREAK_ENDED_EVENT = "project.git_validation_streak_ended";
export const GIT_VALIDATION_STREAK_HEARTBEAT_EVENT = "project.git_validation_streak_heartbeat";

export type GitValidationStreakEndOutcome = "recovered" | "changed" | "stale";

interface GitValidationFailureSignature {
	failureKind: GitRepositoryProbeFailure["failureKind"];
	errorCode: GitRepositoryProbeFailure["errorCode"];
	exitCode: GitRepositoryProbeFailure["exitCode"];
	terminatedBySignal: boolean;
}

function signatureOf(failure: GitRepositoryProbeFailure): GitValidationFailureSignature {
	return {
		failureKind: failure.failureKind,
		errorCode: failure.errorCode,
		exitCode: failure.exitCode,
		terminatedBySignal: failure.terminatedBySignal,
	};
}

function signaturesMatch(a: GitValidationFailureSignature, b: GitValidationFailureSignature): boolean {
	return (
		a.failureKind === b.failureKind &&
		a.errorCode === b.errorCode &&
		a.exitCode === b.exitCode &&
		a.terminatedBySignal === b.terminatedBySignal
	);
}

interface ActiveGitValidationStreak {
	signature: GitValidationFailureSignature;
	suppressedCount: number;
	startedAt: number;
	lastHeartbeatAt: number;
	/** Timestamp of the most recent observed failure for this streak (every call, not just heartbeats); used to detect a resumed streak after a gap. */
	lastObservedAt: number;
}

export interface GitValidationStreakSnapshot extends GitValidationFailureSignature {
	projectId: string;
	suppressedCount: number;
	durationMs: number;
	/** Time since the last observed failure for this streak; a large value flags a streak that stopped being probed without ever closing. */
	sinceLastObservedMs: number;
}

export interface GitValidationDiagnosticsSnapshot {
	activeStreakCount: number;
	countsByFailureKind: Record<string, number>;
	streaks: GitValidationStreakSnapshot[];
}

/** Minimal recorder surface this policy depends on; matches `RuntimeDiagnostics.recordEvent`. */
export interface GitValidationDiagnosticsSink {
	recordEvent(
		name: string,
		payload: unknown,
		context: DiagnosticContext,
		options: { level?: DiagnosticLevel; essential: boolean },
	): unknown;
}

/**
 * Coalesces repeated `probeGitRepository` failures per project: the first
 * failure of a signature records `project.git_validation_failed`; exact
 * repeats only increment a suppressed counter. A streak only ever closes
 * with `project.git_validation_streak_ended` when it actually suppressed at
 * least one repeat, so a flap that never repeated costs no extra event. A
 * gap of `HEARTBEAT_INTERVAL_MS` or more since the last observed failure
 * ends the streak as `"stale"` and starts a fresh one, so a resumed failure
 * is never silently folded into an old streak behind a stale heartbeat
 * clock. While a streak keeps suppressing repeats, a bounded
 * `project.git_validation_streak_heartbeat` fires at most once per interval
 * (via timestamps checked on each observed repeat, not a timer) so a
 * long-lived streak stays visible in the retained journal between its start
 * and its end.
 */
export class ProjectGitValidationDiagnostics {
	private readonly streaksByProjectId = new Map<string, ActiveGitValidationStreak>();

	constructor(
		private readonly sink: GitValidationDiagnosticsSink,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Record a failed probe for `projectId`. The first failure, the first
	 * failure of a new signature, and the first failure after an observation
	 * gap of `HEARTBEAT_INTERVAL_MS` or more all record
	 * `project.git_validation_failed` exactly as an unconditional call would.
	 * A fresh repeat of the active streak's signature only increments its
	 * suppressed counter (plus an occasional heartbeat; see class doc).
	 */
	recordFailure(projectId: string, failure: GitRepositoryProbeFailure): void {
		const now = this.now();
		const signature = signatureOf(failure);
		const active = this.streaksByProjectId.get(projectId);
		if (active) {
			const stale = now - active.lastObservedAt >= HEARTBEAT_INTERVAL_MS;
			if (!stale && signaturesMatch(active.signature, signature)) {
				active.suppressedCount += 1;
				active.lastObservedAt = now;
				this.maybeRecordHeartbeat(projectId, active, now);
				return;
			}
			this.endStreakIfSuppressed(projectId, active, stale ? "stale" : "changed", now);
		}
		this.sink.recordEvent(GIT_VALIDATION_FAILED_EVENT, failure, { projectId }, { level: "warn", essential: true });
		this.streaksByProjectId.set(projectId, {
			signature,
			suppressedCount: 0,
			startedAt: now,
			lastHeartbeatAt: now,
			lastObservedAt: now,
		});
	}

	/** Record a successful ("repository") probe for `projectId`, ending any active streak as "recovered". */
	recordSuccess(projectId: string): void {
		const active = this.streaksByProjectId.get(projectId);
		if (!active) return;
		this.endStreakIfSuppressed(projectId, active, "recovered", this.now());
		this.streaksByProjectId.delete(projectId);
	}

	/** Drop streak state for a project leaving the registry. Disposal is bookkeeping, not a streak outcome, so it records nothing. */
	disposeProject(projectId: string): void {
		this.streaksByProjectId.delete(projectId);
	}

	/** Bounded, metadata-only current-streak snapshot for a diagnostics snapshot provider. No paths. */
	getSnapshot(scope: Readonly<DiagnosticCaptureScope> = {}): GitValidationDiagnosticsSnapshot {
		const now = this.now();
		const entries = Array.from(this.streaksByProjectId.entries()).filter(
			([projectId]) => !scope.projectId || projectId === scope.projectId,
		);
		const countsByFailureKind: Record<string, number> = {};
		for (const [, streak] of entries) {
			countsByFailureKind[streak.signature.failureKind] =
				(countsByFailureKind[streak.signature.failureKind] ?? 0) + 1;
		}
		const streaks = entries
			.slice()
			.sort(([, a], [, b]) => b.suppressedCount - a.suppressedCount)
			.slice(0, MAX_SNAPSHOT_STREAKS)
			.map(([projectId, streak]) => ({
				projectId,
				...streak.signature,
				suppressedCount: streak.suppressedCount,
				durationMs: Math.max(0, now - streak.startedAt),
				sinceLastObservedMs: Math.max(0, now - streak.lastObservedAt),
			}));
		return { activeStreakCount: entries.length, countsByFailureKind, streaks };
	}

	/** Only a streak that actually suppressed a repeat is worth announcing the end of; a flap that never repeated ends silently. */
	private endStreakIfSuppressed(
		projectId: string,
		streak: ActiveGitValidationStreak,
		outcome: GitValidationStreakEndOutcome,
		now: number,
	): void {
		if (streak.suppressedCount <= 0) return;
		this.sink.recordEvent(
			GIT_VALIDATION_STREAK_ENDED_EVENT,
			{
				...streak.signature,
				suppressedCount: streak.suppressedCount,
				durationMs: Math.max(0, now - streak.startedAt),
				outcome,
			},
			{ projectId },
			// "recovered" closes an already-reported problem (informational); "changed" and "stale"
			// both mean the project is still failing (under a new signature, or resumed after a gap),
			// so they keep the warn level.
			{ level: outcome === "recovered" ? "info" : "warn", essential: true },
		);
	}

	private maybeRecordHeartbeat(projectId: string, streak: ActiveGitValidationStreak, now: number): void {
		if (now - streak.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
		streak.lastHeartbeatAt = now;
		this.sink.recordEvent(
			GIT_VALIDATION_STREAK_HEARTBEAT_EVENT,
			{
				...streak.signature,
				suppressedCount: streak.suppressedCount,
				durationMs: Math.max(0, now - streak.startedAt),
			},
			{ projectId },
			{ level: "warn", essential: true },
		);
	}
}

export type GitRepositoryProbeFn = (
	path: string,
	options?: GitRepositoryProbeOptions,
) => Promise<GitRepositoryProbeResult>;

/**
 * Wraps a real `probeGitRepository` so that failures observed for a known
 * project go through the coalescing `policy` instead of recording one
 * diagnostic event per call. Failures with no `projectId` (the one-off
 * launched-from-cwd check at startup, which is not per-project) are recorded
 * directly via `sink`, uncoalesced. A `"repository"` result ends that
 * project's active streak. Never changes `probe`'s own signature or result.
 */
export function createCoalescingGitRepositoryProbe(
	policy: ProjectGitValidationDiagnostics,
	sink: GitValidationDiagnosticsSink,
	probe: GitRepositoryProbeFn,
): (path: string, projectId?: string) => Promise<GitRepositoryProbeResult> {
	return async (path, projectId) => {
		const result = await probe(path, {
			onFailure: (failure) => {
				if (projectId) {
					policy.recordFailure(projectId, failure);
				} else {
					sink.recordEvent(GIT_VALIDATION_FAILED_EVENT, failure, {}, { level: "warn", essential: true });
				}
			},
		});
		if (result === "repository" && projectId) policy.recordSuccess(projectId);
		return result;
	};
}
