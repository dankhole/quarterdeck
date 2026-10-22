import { describe, expect, it } from "vitest";

import type { GitRepositoryProbeFailure, GitRepositoryProbeResult } from "../../../src/projects/git-repository-probe";
import {
	createCoalescingGitRepositoryProbe,
	GIT_VALIDATION_FAILED_EVENT,
	GIT_VALIDATION_STREAK_ENDED_EVENT,
	GIT_VALIDATION_STREAK_HEARTBEAT_EVENT,
	ProjectGitValidationDiagnostics,
} from "../../../src/server/project-git-validation-diagnostics";

/** Mirrors the module-local heartbeat interval; this is the public, testable contract. */
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

interface RecordedEvent {
	name: string;
	payload: unknown;
	context: { projectId?: string };
	options: { level?: string; essential: boolean };
}

function createFakeSink() {
	const events: RecordedEvent[] = [];
	return {
		events,
		recordEvent: (
			name: string,
			payload: unknown,
			context: { projectId?: string },
			options: { level?: string; essential: boolean },
		) => {
			events.push({ name, payload, context, options });
			return null;
		},
	};
}

function createClock(startedAt = 0) {
	let now = startedAt;
	return {
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
	};
}

const TIMEOUT_FAILURE: GitRepositoryProbeFailure = {
	failureKind: "timed_out",
	errorCode: null,
	exitCode: null,
	terminatedBySignal: false,
};

const NOT_REPOSITORY_FAILURE: GitRepositoryProbeFailure = {
	failureKind: "empty_root",
	errorCode: null,
	exitCode: 0,
	terminatedBySignal: false,
};

describe("ProjectGitValidationDiagnostics", () => {
	it("records one failed event per project for N projects x M identical failures, not N x M", () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);
		const projectIds = ["project-1", "project-2", "project-3"];
		const repeatsPerProject = 5;

		for (const projectId of projectIds) {
			for (let i = 0; i < repeatsPerProject; i++) {
				policy.recordFailure(projectId, TIMEOUT_FAILURE);
			}
		}

		const failedEvents = sink.events.filter((event) => event.name === GIT_VALIDATION_FAILED_EVENT);
		expect(failedEvents).toHaveLength(projectIds.length);
		expect(failedEvents.map((event) => event.context.projectId).sort()).toEqual(projectIds.slice().sort());
		expect(sink.events).toHaveLength(projectIds.length);
		for (const event of failedEvents) {
			expect(event.payload).toEqual(TIMEOUT_FAILURE);
			expect(event.options).toEqual({ level: "warn", essential: true });
		}
	});

	it("ends the active streak as changed and records a new failed event when the failure signature differs", () => {
		const clock = createClock();
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink, clock.now);

		policy.recordFailure("project-1", TIMEOUT_FAILURE); // first of streak A
		clock.advance(10);
		policy.recordFailure("project-1", TIMEOUT_FAILURE); // suppressed repeat of streak A
		clock.advance(20);
		policy.recordFailure("project-1", NOT_REPOSITORY_FAILURE); // signature change -> ends A, starts B

		expect(sink.events.map((event) => event.name)).toEqual([
			GIT_VALIDATION_FAILED_EVENT,
			GIT_VALIDATION_STREAK_ENDED_EVENT,
			GIT_VALIDATION_FAILED_EVENT,
		]);

		const ended = sink.events[1];
		expect(ended?.payload).toEqual({
			...TIMEOUT_FAILURE,
			suppressedCount: 1,
			durationMs: 30,
			outcome: "changed",
		});
		expect(ended?.context).toEqual({ projectId: "project-1" });
		expect(ended?.options).toEqual({ level: "warn", essential: true });

		const secondFailed = sink.events[2];
		expect(secondFailed?.payload).toEqual(NOT_REPOSITORY_FAILURE);
	});

	it("ends the streak as recovered with the exact suppressed count on a successful probe", () => {
		const clock = createClock();
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink, clock.now);

		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		clock.advance(5);
		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		clock.advance(5);
		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		clock.advance(15);
		policy.recordSuccess("project-1");

		const ended = sink.events.at(-1);
		expect(ended?.name).toEqual(GIT_VALIDATION_STREAK_ENDED_EVENT);
		expect(ended?.payload).toEqual({
			...TIMEOUT_FAILURE,
			suppressedCount: 2,
			durationMs: 25,
			outcome: "recovered",
		});
		expect(ended?.options).toEqual({ level: "info", essential: true });
	});

	it("does nothing on success when there is no active streak", () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);

		policy.recordSuccess("project-1");

		expect(sink.events).toHaveLength(0);
	});

	it("records again on the first failure after recovery", () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);

		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		policy.recordSuccess("project-1");
		policy.recordFailure("project-1", TIMEOUT_FAILURE);

		const failedEvents = sink.events.filter((event) => event.name === GIT_VALIDATION_FAILED_EVENT);
		expect(failedEvents).toHaveLength(2);
	});

	it("drops streak state on project disposal without recording an event", () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);

		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		policy.disposeProject("project-1");

		expect(sink.events).toHaveLength(1);
		expect(policy.getSnapshot().activeStreakCount).toBe(0);

		// A failure after disposal starts a fresh streak rather than resuming the dropped one.
		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		const failedEvents = sink.events.filter((event) => event.name === GIT_VALIDATION_FAILED_EVENT);
		expect(failedEvents).toHaveLength(2);
	});

	it("reports a bounded, metadata-only snapshot with the full failure signature and observation age", () => {
		const clock = createClock();
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink, clock.now);

		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		policy.recordFailure("project-2", NOT_REPOSITORY_FAILURE);
		clock.advance(50);

		const snapshot = policy.getSnapshot();
		expect(snapshot.activeStreakCount).toBe(2);
		expect(snapshot.countsByFailureKind).toEqual({ timed_out: 1, empty_root: 1 });
		expect(snapshot.streaks).toEqual(
			expect.arrayContaining([
				{ projectId: "project-1", ...TIMEOUT_FAILURE, suppressedCount: 1, durationMs: 50, sinceLastObservedMs: 50 },
				{
					projectId: "project-2",
					...NOT_REPOSITORY_FAILURE,
					suppressedCount: 0,
					durationMs: 50,
					sinceLastObservedMs: 50,
				},
			]),
		);
	});

	it("filters the snapshot to the requested project scope", () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);

		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		policy.recordFailure("project-2", NOT_REPOSITORY_FAILURE);

		const scoped = policy.getSnapshot({ projectId: "project-1" });
		expect(scoped.activeStreakCount).toBe(1);
		expect(scoped.streaks).toHaveLength(1);
		expect(scoped.streaks[0]?.projectId).toBe("project-1");
	});

	it("ends a streak silently (no streak_ended) when it never suppressed a repeat", () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);

		// Flap: signature change on the very next call, with no repeat in between.
		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		policy.recordFailure("project-1", NOT_REPOSITORY_FAILURE);
		// Immediate recovery: a single failure then success, with no repeat in between.
		policy.recordFailure("project-2", TIMEOUT_FAILURE);
		policy.recordSuccess("project-2");

		expect(sink.events.filter((event) => event.name === GIT_VALIDATION_STREAK_ENDED_EVENT)).toHaveLength(0);
		expect(sink.events.filter((event) => event.name === GIT_VALIDATION_FAILED_EVENT)).toHaveLength(3);
	});

	it("emits a bounded heartbeat for a long streak via timestamps, at most once per interval", () => {
		const clock = createClock();
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink, clock.now);

		policy.recordFailure("project-1", TIMEOUT_FAILURE); // t=0, starts the streak
		clock.advance(HEARTBEAT_INTERVAL_MS - 1);
		policy.recordFailure("project-1", TIMEOUT_FAILURE); // just under the interval: no heartbeat yet
		expect(sink.events.filter((event) => event.name === GIT_VALIDATION_STREAK_HEARTBEAT_EVENT)).toHaveLength(0);

		clock.advance(1); // crosses the interval boundary
		policy.recordFailure("project-1", TIMEOUT_FAILURE);
		const firstHeartbeats = sink.events.filter((event) => event.name === GIT_VALIDATION_STREAK_HEARTBEAT_EVENT);
		expect(firstHeartbeats).toHaveLength(1);
		expect(firstHeartbeats[0]?.payload).toEqual({
			...TIMEOUT_FAILURE,
			suppressedCount: 2,
			durationMs: HEARTBEAT_INTERVAL_MS,
		});
		expect(firstHeartbeats[0]?.context).toEqual({ projectId: "project-1" });
		expect(firstHeartbeats[0]?.options).toEqual({ level: "warn", essential: true });

		clock.advance(1);
		policy.recordFailure("project-1", TIMEOUT_FAILURE); // still inside the same window: no second heartbeat
		expect(sink.events.filter((event) => event.name === GIT_VALIDATION_STREAK_HEARTBEAT_EVENT)).toHaveLength(1);

		clock.advance(HEARTBEAT_INTERVAL_MS - 1);
		policy.recordFailure("project-1", TIMEOUT_FAILURE); // crosses the next interval
		expect(sink.events.filter((event) => event.name === GIT_VALIDATION_STREAK_HEARTBEAT_EVENT)).toHaveLength(2);
	});

	it("ends a streak as stale and starts fresh when a failure resumes after a long observation gap", () => {
		const clock = createClock();
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink, clock.now);

		policy.recordFailure("project-1", TIMEOUT_FAILURE); // t=0, starts the streak
		clock.advance(10);
		policy.recordFailure("project-1", TIMEOUT_FAILURE); // t=10, suppressed repeat, lastObservedAt=10
		clock.advance(HEARTBEAT_INTERVAL_MS); // gap since last observation >= the interval
		policy.recordFailure("project-1", TIMEOUT_FAILURE); // same signature, but stale: ends old, starts new

		expect(sink.events.map((event) => event.name)).toEqual([
			GIT_VALIDATION_FAILED_EVENT,
			GIT_VALIDATION_STREAK_ENDED_EVENT,
			GIT_VALIDATION_FAILED_EVENT,
		]);
		const ended = sink.events[1];
		expect(ended?.payload).toEqual({
			...TIMEOUT_FAILURE,
			suppressedCount: 1,
			durationMs: 10 + HEARTBEAT_INTERVAL_MS,
			outcome: "stale",
		});
		expect(ended?.options).toEqual({ level: "warn", essential: true });

		// The new streak starts fresh: it has not been idle at all yet.
		expect(policy.getSnapshot().streaks[0]?.sinceLastObservedMs).toBe(0);
		expect(policy.getSnapshot().streaks[0]?.suppressedCount).toBe(0);
	});

	it("produces the exact event sequence for a realistic run across projects (coalescing, recovery, flap, staleness)", () => {
		const clock = createClock();
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink, clock.now);

		policy.recordFailure("project-1", TIMEOUT_FAILURE); // new streak -> failed
		policy.recordFailure("project-1", TIMEOUT_FAILURE); // suppressed, no event
		policy.recordFailure("project-1", TIMEOUT_FAILURE); // suppressed, no event
		policy.recordSuccess("project-1"); // ends (recovered), suppressedCount 2

		policy.recordFailure("project-2", TIMEOUT_FAILURE); // new streak -> failed
		policy.recordFailure("project-2", NOT_REPOSITORY_FAILURE); // flap, no prior repeat: ends silently, then failed

		policy.recordFailure("project-3", TIMEOUT_FAILURE); // new streak -> failed
		policy.recordFailure("project-3", TIMEOUT_FAILURE); // suppressed
		clock.advance(HEARTBEAT_INTERVAL_MS); // gap triggers staleness on the next observation
		policy.recordFailure("project-3", TIMEOUT_FAILURE); // ends as stale, then a fresh failed

		expect(sink.events.map((event) => event.name)).toEqual([
			GIT_VALIDATION_FAILED_EVENT, // project-1 starts
			GIT_VALIDATION_STREAK_ENDED_EVENT, // project-1 recovered
			GIT_VALIDATION_FAILED_EVENT, // project-2 starts (timed_out)
			GIT_VALIDATION_FAILED_EVENT, // project-2 flap -> empty_root, no streak_ended (nothing suppressed)
			GIT_VALIDATION_FAILED_EVENT, // project-3 starts
			GIT_VALIDATION_STREAK_ENDED_EVENT, // project-3 stale end
			GIT_VALIDATION_FAILED_EVENT, // project-3 fresh restart
		]);

		const project1End = sink.events.find(
			(event) => event.name === GIT_VALIDATION_STREAK_ENDED_EVENT && event.context.projectId === "project-1",
		);
		expect(project1End?.payload).toMatchObject({ outcome: "recovered", suppressedCount: 2 });

		const project3End = sink.events.find(
			(event) => event.name === GIT_VALIDATION_STREAK_ENDED_EVENT && event.context.projectId === "project-3",
		);
		expect(project3End?.payload).toMatchObject({ outcome: "stale", suppressedCount: 1 });
	});
});

describe("createCoalescingGitRepositoryProbe", () => {
	function createScriptedProbe(
		script: ReadonlyArray<{ failure?: GitRepositoryProbeFailure; result: GitRepositoryProbeResult }>,
	) {
		let index = 0;
		return async (
			_path: string,
			options: { onFailure?: (failure: GitRepositoryProbeFailure) => void } = {},
		): Promise<GitRepositoryProbeResult> => {
			const step = script[index++];
			if (!step) throw new Error("scripted probe exhausted");
			if (step.failure) options.onFailure?.(step.failure);
			return step.result;
		};
	}

	it("coalesces repeat failures for a known project through the policy", async () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);
		const probe = createScriptedProbe([
			{ failure: TIMEOUT_FAILURE, result: "indeterminate" },
			{ failure: TIMEOUT_FAILURE, result: "indeterminate" },
			{ failure: TIMEOUT_FAILURE, result: "indeterminate" },
		]);
		const adapter = createCoalescingGitRepositoryProbe(policy, sink, probe);

		await adapter("/repo", "project-1");
		await adapter("/repo", "project-1");
		await adapter("/repo", "project-1");

		const failedEvents = sink.events.filter((event) => event.name === GIT_VALIDATION_FAILED_EVENT);
		expect(failedEvents).toHaveLength(1);
		expect(failedEvents[0]?.context).toEqual({ projectId: "project-1" });
	});

	it("records failures without a projectId directly, bypassing the policy", async () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);
		const probe = createScriptedProbe([
			{ failure: TIMEOUT_FAILURE, result: "indeterminate" },
			{ failure: TIMEOUT_FAILURE, result: "indeterminate" },
		]);
		const adapter = createCoalescingGitRepositoryProbe(policy, sink, probe);

		await adapter("/repo"); // the one-off launched-from-cwd check: no projectId
		await adapter("/repo");

		const failedEvents = sink.events.filter((event) => event.name === GIT_VALIDATION_FAILED_EVENT);
		expect(failedEvents).toHaveLength(2); // recorded directly every time, never coalesced
		expect(failedEvents.every((event) => event.context.projectId === undefined)).toBe(true);
		expect(policy.getSnapshot().activeStreakCount).toBe(0); // the policy never saw these
	});

	it("ends the streak once the probe reports a repository", async () => {
		const sink = createFakeSink();
		const policy = new ProjectGitValidationDiagnostics(sink);
		const probe = createScriptedProbe([
			{ failure: TIMEOUT_FAILURE, result: "indeterminate" },
			{ failure: TIMEOUT_FAILURE, result: "indeterminate" },
			{ result: "repository" },
		]);
		const adapter = createCoalescingGitRepositoryProbe(policy, sink, probe);

		await adapter("/repo", "project-1");
		await adapter("/repo", "project-1");
		const result = await adapter("/repo", "project-1");

		expect(result).toBe("repository");
		const ended = sink.events.find((event) => event.name === GIT_VALIDATION_STREAK_ENDED_EVENT);
		expect(ended?.payload).toMatchObject({ outcome: "recovered", suppressedCount: 1 });
		expect(policy.getSnapshot().activeStreakCount).toBe(0);
	});
});
