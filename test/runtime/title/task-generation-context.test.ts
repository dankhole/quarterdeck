import { describe, expect, it } from "vitest";

import { buildTaskGenerationContext } from "../../../src/title";

describe("buildTaskGenerationContext", () => {
	it("uses a non-duplicate final message as the most recent activity when summaries already exist", () => {
		const context = buildTaskGenerationContext({
			prompt: "Fix the auth timeout",
			summaries: [
				{ text: "Investigated timeout source", capturedAt: 100, sessionIndex: 0 },
				{ text: "Updated retry helper", capturedAt: 200, sessionIndex: 1 },
			],
			finalMessage: "Verified auth timeout fix",
			limits: {
				originalPrompt: 100,
				firstActivity: 100,
				latestActivity: 100,
				previousActivity: 100,
			},
		});

		expect(context).toContain("Most recent agent summary:\nVerified auth timeout fix");
		expect(context).toContain("Previous agent summary:\nUpdated retry helper");
	});

	it("does not duplicate final message text that already appears in conversation summaries", () => {
		const context = buildTaskGenerationContext({
			prompt: "Fix the auth timeout",
			summaries: [
				{ text: "Investigated timeout source", capturedAt: 100, sessionIndex: 0 },
				{ text: "Verified auth timeout fix", capturedAt: 200, sessionIndex: 1 },
			],
			finalMessage: "Verified auth timeout fix",
			limits: {
				originalPrompt: 100,
				firstActivity: 100,
				latestActivity: 100,
				previousActivity: 100,
			},
		});

		expect(context?.match(/Verified auth timeout fix/g)).toHaveLength(1);
	});
});
