import { describe, expect, it } from "vitest";

import { deriveSessionResumeSemanticState, deriveStartupRecoveryPolicy } from "../../../src/terminal";
import {
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../utilities/task-session-factory";

describe("deriveStartupRecoveryPolicy", () => {
	it.each([
		{
			label: "running work",
			summary: createTestTaskSessionSummary({ state: "running", pid: 100 }),
			required: true,
			semanticState: "awaiting_review",
			fallback: null,
		},
		{
			label: "completed review with stale process ownership",
			summary: createTestTaskSessionSummary({ state: "awaiting_review", reviewReason: "hook", pid: 200 }),
			required: true,
			semanticState: "awaiting_review",
			fallback: "hook",
		},
		{
			label: "processless completed review",
			summary: createTestTaskSessionSummary({ state: "awaiting_review", reviewReason: "hook", pid: null }),
			required: false,
			semanticState: null,
			fallback: "hook",
		},
		{
			label: "genuine permission wait",
			summary: createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
				outstandingInteraction: createTestTaskOutstandingInteraction({ kind: "permission" }),
				latestHookActivity: {
					hookEventName: "PermissionRequest",
					notificationType: "permission_prompt",
				},
			}),
			required: true,
			semanticState: "awaiting_review",
			fallback: null,
		},
		{
			label: "error review",
			summary: createTestTaskSessionSummary({ state: "awaiting_review", reviewReason: "error", pid: 300 }),
			required: false,
			semanticState: null,
			fallback: null,
		},
	])("classifies $label", ({ summary, required, semanticState, fallback }) => {
		const policy = deriveStartupRecoveryPolicy(summary);

		expect(policy.required).toBe(required);
		expect(policy.semanticState?.state ?? null).toBe(semanticState);
		expect(policy.fallbackReviewState?.reviewReason ?? null).toBe(fallback);
	});

	it("keeps a durable interrupted handoff Interrupted until native work is confirmed", () => {
		const policy = deriveStartupRecoveryPolicy(
			createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
				pid: null,
				startupRecoveryRequired: true,
				startupRecoverySemanticStateUncertain: false,
			}),
		);

		expect(policy).toMatchObject({
			required: true,
			semanticStateUncertain: false,
			semanticState: {
				state: "awaiting_review",
				reviewReason: "interrupted",
			},
		});
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

	it("restores response-pending interaction meaning without relabeling it as Running or Needs Input", () => {
		const policy = deriveStartupRecoveryPolicy(
			createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "attention",
				pid: null,
				outstandingInteraction: {
					provider: "claude",
					kind: "question",
					status: "response_submitted",
					requestEventName: "PreToolUse",
					openedAt: 100,
					updatedAt: 110,
					responseSubmittedAt: 110,
					responseKind: "submit",
					sessionInstanceId: "old-process",
					providerSessionId: "session-1",
					turnId: null,
					promptId: "prompt-1",
					toolUseId: "tool-1",
					elicitationId: null,
					providerAgentId: null,
					toolName: "AskUserQuestion",
				},
			}),
		);

		expect(policy).toMatchObject({
			required: true,
			semanticState: {
				state: "awaiting_review",
				reviewReason: "attention",
				outstandingInteraction: { status: "response_submitted", toolUseId: "tool-1" },
			},
		});
	});

	it("rejects a stale durable recovery handoff for unproven legacy attention", () => {
		const policy = deriveStartupRecoveryPolicy(
			createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "attention",
				pid: null,
				startupRecoveryRequired: true,
				latestHookActivity: null,
			}),
		);

		expect(policy).toMatchObject({
			required: false,
			semanticState: null,
			fallbackReviewState: null,
			semanticStateUncertain: false,
		});
	});

	it("keeps explicitly uncertain interrupted Review neutral instead of guessing prior task meaning", () => {
		const policy = deriveStartupRecoveryPolicy(
			createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
				pid: null,
				startupRecoveryRequired: true,
				startupRecoverySemanticStateUncertain: true,
			}),
		);

		expect(policy).toMatchObject({
			required: true,
			semanticStateUncertain: true,
			semanticState: { state: "awaiting_review", reviewReason: "interrupted" },
			fallbackReviewState: null,
		});
	});

	it("honors an explicit durable decision not to recover an interrupted task", () => {
		const policy = deriveStartupRecoveryPolicy(
			createTestTaskSessionSummary({
				state: "awaiting_review",
				reviewReason: "interrupted",
				pid: null,
				startupRecoveryRequired: false,
			}),
		);

		expect(policy.required).toBe(false);
		expect(policy.semanticStateUncertain).toBe(false);
	});
});

describe("deriveSessionResumeSemanticState", () => {
	it("preserves ordinary completed Review across a process replacement", () => {
		expect(
			deriveSessionResumeSemanticState(
				createTestTaskSessionSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					lastHookAt: 123,
				}),
			),
		).toMatchObject({ state: "awaiting_review", reviewReason: "hook", lastHookAt: 123 });
	});

	it("keeps explicit failure visible until current provider evidence replaces it", () => {
		expect(
			deriveSessionResumeSemanticState(
				createTestTaskSessionSummary({ state: "awaiting_review", reviewReason: "error" }),
			),
		).toMatchObject({ state: "awaiting_review", reviewReason: "error" });
	});

	it("does not preserve unstructured attention as a fabricated input wait", () => {
		expect(
			deriveSessionResumeSemanticState(
				createTestTaskSessionSummary({
					state: "awaiting_review",
					reviewReason: "attention",
					latestHookActivity: null,
					outstandingInteraction: null,
				}),
			),
		).toMatchObject({ state: "awaiting_review", reviewReason: "interrupted" });
	});
});
