import { describe, expect, it } from "vitest";

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
			state: "interrupted",
			reviewReason: "interrupted",
			pid: null,
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(true);
	});

	it("resumes stale awaiting-review attention sessions from an unclean shutdown", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "attention",
			pid: 12345,
			resumeSessionId: "session-id",
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(true);
	});

	it("preserves completed awaiting-review hook sessions", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: 12345,
			resumeSessionId: "session-id",
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(false);
	});

	it("preserves processless awaiting-review attention sessions", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "attention",
			pid: null,
			resumeSessionId: "session-id",
		});

		expect(shouldResumeSessionOnStartup(summary)).toBe(false);
	});

	it("preserves deliberately stopped awaiting-review sessions", () => {
		const summary = createTestTaskSessionSummary({
			state: "awaiting_review",
			reviewReason: "interrupted",
			pid: null,
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
			hasGitRepository: async () => true,
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
			hasGitRepository: async () => {
				gitProbeCount += 1;
				return true;
			},
			pathIsDirectory: async () => false,
		});

		expect(gitProbeCount).toBe(0);
		expect(result?.removalMessage).toContain("Project no longer exists on disk");
	});
});
