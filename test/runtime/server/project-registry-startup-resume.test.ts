import { describe, expect, it } from "vitest";

import { shouldResumeSessionOnStartup } from "../../../src/server/project-registry";
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
});
