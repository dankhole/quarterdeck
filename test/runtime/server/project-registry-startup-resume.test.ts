import { describe, expect, it, vi } from "vitest";

import {
	PROJECT_STREAM_VALIDATION_CONCURRENCY,
	shouldResumeSessionOnStartup,
	validateIndexedProjectsForStream,
} from "../../../src/server/project-registry";
import type { RuntimeProjectIndexEntry } from "../../../src/state";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

describe("shouldResumeSessionOnStartup", () => {
	it("resumes interrupted sessions", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
			startupRecoveryRequired: true,
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(true);
	});

	it("retains recovery eligibility after a prior runtime already cleared the stale pid", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			startupRecoveryRequired: true,
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(true);
	});

	it("resumes stale awaiting-review attention sessions from an unclean shutdown", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "attention",
			pid: 12345,
			resumeSessionId: "session-id",
			outstandingInteraction: {
				provider: "claude",
				kind: "question",
				status: "waiting",
				requestEventName: "PreToolUse",
				openedAt: 1,
				updatedAt: 1,
				responseSubmittedAt: null,
				responseKind: null,
				sessionInstanceId: "process-1",
				providerSessionId: "session-id",
				turnId: null,
				promptId: null,
				toolUseId: "tool-1",
				elicitationId: null,
				providerAgentId: null,
				toolName: "AskUserQuestion",
			},
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(true);
	});

	it("resumes awaiting-review hook sessions that still referenced a live chat", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: 12345,
			resumeSessionId: "session-id",
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(true);
	});

	it("resumes processless awaiting-review attention sessions", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "attention",
			pid: null,
			resumeSessionId: "session-id",
			outstandingInteraction: {
				provider: "claude",
				kind: "question",
				status: "waiting",
				requestEventName: "PreToolUse",
				openedAt: 1,
				updatedAt: 1,
				responseSubmittedAt: null,
				responseKind: null,
				sessionInstanceId: "process-1",
				providerSessionId: "session-id",
				turnId: null,
				promptId: null,
				toolUseId: "tool-1",
				elicitationId: null,
				providerAgentId: null,
				toolName: "AskUserQuestion",
			},
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(true);
	});

	it("does not resume an unproven legacy attention reason", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "attention",
			pid: null,
			resumeSessionId: "session-id",
			startupRecoveryRequired: true,
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(false);
	});

	it("preserves processless completed awaiting-review hook sessions", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
			resumeSessionId: "session-id",
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(false);
	});

	it("preserves deliberately stopped awaiting-review sessions", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: 12345,
			resumeSessionId: "session-id",
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(false);
	});
});

describe("validateIndexedProjectsForStream", () => {
	it("validates indexed projects with bounded parallelism", async () => {
		const projects: RuntimeProjectIndexEntry[] = Array.from(
			{ length: PROJECT_STREAM_VALIDATION_CONCURRENCY * 3 },
			(_, index) => ({
				projectId: `project-${index}`,
				repoPath: `/tmp/project-${index}`,
			}),
		);
		let activeDirectoryChecks = 0;
		let maxActiveDirectoryChecks = 0;

		const results = await validateIndexedProjectsForStream(projects, {
			probeGitRepository: async () => "repository",
			pathIsDirectory: async () => {
				activeDirectoryChecks += 1;
				maxActiveDirectoryChecks = Math.max(maxActiveDirectoryChecks, activeDirectoryChecks);
				await new Promise((resolve) => setTimeout(resolve, 1));
				activeDirectoryChecks -= 1;
				return true;
			},
		});

		expect(results).toHaveLength(projects.length);
		expect(maxActiveDirectoryChecks).toBeGreaterThan(1);
		expect(maxActiveDirectoryChecks).toBeLessThanOrEqual(PROJECT_STREAM_VALIDATION_CONCURRENCY);
	});

	it("skips git probing for projects that are no longer directories", async () => {
		const projects: RuntimeProjectIndexEntry[] = [
			{
				projectId: "missing",
				repoPath: "/tmp/missing",
			},
		];
		let gitProbeCount = 0;

		const [result] = await validateIndexedProjectsForStream(projects, {
			probeGitRepository: async () => {
				gitProbeCount += 1;
				return "repository";
			},
			pathIsDirectory: async () => false,
		});

		expect(gitProbeCount).toBe(0);
		expect(result?.availability).toEqual({ status: "unavailable", reason: "missing" });
	});

	it("reports an indeterminate probe as provisionally available with exactly one probe call (no pre-listen retry)", async () => {
		// Startup runs before the server listens: retrying an indeterminate probe
		// here would multiply pre-listen latency per indeterminate project and can
		// blow past the desktop supervisor's startup window under the very load
		// this is meant to tolerate. The accessible folder stays provisionally
		// available so startup still hydrates it; launches require a definite answer.
		const projects: RuntimeProjectIndexEntry[] = [{ projectId: "p1", repoPath: "/tmp/p1" }];
		const probeGitRepository = vi.fn(async () => "indeterminate" as const);

		const [result] = await validateIndexedProjectsForStream(projects, {
			probeGitRepository,
			pathIsDirectory: async () => true,
		});

		expect(probeGitRepository).toHaveBeenCalledTimes(1);
		expect(result?.availability).toEqual({ status: "available" });
		expect(result?.indeterminate).toBe(true);
	});

	it("reports a definitive result with exactly one probe call", async () => {
		const projects: RuntimeProjectIndexEntry[] = [{ projectId: "p1", repoPath: "/tmp/p1" }];
		const probeGitRepository = vi.fn(async () => "repository" as const);

		const [result] = await validateIndexedProjectsForStream(projects, {
			probeGitRepository,
			pathIsDirectory: async () => true,
		});

		expect(probeGitRepository).toHaveBeenCalledTimes(1);
		expect(result?.availability).toEqual({ status: "available" });
		expect(result?.indeterminate).toBe(false);
	});
});
