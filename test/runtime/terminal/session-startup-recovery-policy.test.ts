import { describe, expect, it } from "vitest";

import { deriveStartupRecoveryPolicy } from "../../../src/terminal";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

describe("deriveStartupRecoveryPolicy", () => {
	it.each([
		{
			label: "running work",
			summary: createTestTaskSessionSummary({ state: "running", pid: 100 }),
			required: true,
			fallback: null,
		},
		{
			label: "completed review with stale process ownership",
			summary: createTestTaskSessionSummary({ state: "awaiting_review", reviewReason: "hook", pid: 200 }),
			required: true,
			fallback: "hook",
		},
		{
			label: "processless completed review",
			summary: createTestTaskSessionSummary({ state: "awaiting_review", reviewReason: "hook", pid: null }),
			required: false,
			fallback: "hook",
		},
		{
			label: "genuine permission wait",
			summary: createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
				latestHookActivity: {
					hookEventName: "PermissionRequest",
					notificationType: "permission_prompt",
				},
			}),
			required: true,
			fallback: null,
		},
		{
			label: "error review",
			summary: createTestTaskSessionSummary({ state: "awaiting_review", reviewReason: "error", pid: 300 }),
			required: false,
			fallback: null,
		},
	])("classifies $label", ({ summary, required, fallback }) => {
		const policy = deriveStartupRecoveryPolicy(summary);

		expect(policy.required).toBe(required);
		expect(policy.fallbackReviewState?.reviewReason ?? null).toBe(fallback);
	});

	it("honors a durable recovery handoff after process ownership was already cleared", () => {
		const policy = deriveStartupRecoveryPolicy(
			createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
				startupRecoveryRequired: true,
			}),
		);

		expect(policy.required).toBe(true);
		expect(policy.fallbackReviewState?.reviewReason).toBe("hook");
	});

	it("keeps ambiguous legacy interrupted state neutral instead of guessing prior task meaning", () => {
		const policy = deriveStartupRecoveryPolicy(
			createTestTaskSessionSummary({
				state: "interrupted",
				reviewReason: "interrupted",
				pid: null,
			}),
		);

		expect(policy).toMatchObject({
			required: true,
			semanticStateUncertain: true,
			reviewState: { reviewReason: "interrupted" },
			fallbackReviewState: null,
		});
	});

	it("honors an explicit durable decision not to recover an interrupted task", () => {
		const policy = deriveStartupRecoveryPolicy(
			createTestTaskSessionSummary({
				state: "interrupted",
				reviewReason: "interrupted",
				pid: null,
				startupRecoveryRequired: false,
			}),
		);

		expect(policy.required).toBe(false);
		expect(policy.semanticStateUncertain).toBe(false);
	});
});
