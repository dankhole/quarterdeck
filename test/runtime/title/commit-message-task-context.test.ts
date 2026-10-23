import { describe, expect, it } from "vitest";

import { buildCommitMessageTaskContext } from "../../../src/title";

describe("buildCommitMessageTaskContext", () => {
	it("uses a non-duplicate final message as the most recent activity when completedResponses already exist", () => {
		const context = buildCommitMessageTaskContext({
			prompt: "Fix the auth timeout",
			completedResponses: [
				{ text: "Investigated timeout source", capturedAt: 100, sessionIndex: 0 },
				{ text: "Updated retry helper", capturedAt: 200, sessionIndex: 1 },
			],
			finalMessage: "Verified auth timeout fix",
		});

		expect(context).toContain("Most recent agent response:\nVerified auth timeout fix");
		expect(context).toContain("Previous agent response:\nUpdated retry helper");
	});

	it("does not duplicate final message text that already appears in conversation completedResponses", () => {
		const context = buildCommitMessageTaskContext({
			prompt: "Fix the auth timeout",
			completedResponses: [
				{ text: "Investigated timeout source", capturedAt: 100, sessionIndex: 0 },
				{ text: "Verified auth timeout fix", capturedAt: 200, sessionIndex: 1 },
			],
			finalMessage: "Verified auth timeout fix",
		});

		expect(context?.match(/Verified auth timeout fix/g)).toHaveLength(1);
	});
});
