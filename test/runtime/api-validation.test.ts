import { describe, expect, it } from "vitest";

import {
	parseHookIngestRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
	parseWorktreeEnsureRequest,
	runtimeTaskSessionSummarySchema,
} from "../../src/core";

const baseSessionSummaryPayload = {
	taskId: "task-1",
	state: "running",
	agentId: null,
	pid: 1234,
	startedAt: 1000,
	updatedAt: 2000,
	lastOutputAt: null,
	reviewReason: null,
	exitCode: null,
} satisfies Record<string, unknown>;

describe("runtimeTaskSessionSummarySchema", () => {
	it("defaults missing sessionLaunchPath to null", () => {
		const parsed = runtimeTaskSessionSummarySchema.parse(baseSessionSummaryPayload);

		expect(parsed.sessionLaunchPath).toBeNull();
	});

	it("does not read legacy projectPath as the session launch path", () => {
		const parsed = runtimeTaskSessionSummarySchema.parse({
			...baseSessionSummaryPayload,
			projectPath: "/tmp/legacy-project",
		});

		expect(parsed.sessionLaunchPath).toBeNull();
		expect("projectPath" in parsed).toBe(false);
	});

	it.each([
		["failed", "error"],
		["interrupted", "interrupted"],
	] as const)("normalizes legacy %s state into canonical Review detail", (state, reviewReason) => {
		const parsed = runtimeTaskSessionSummarySchema.parse({
			...baseSessionSummaryPayload,
			state,
		});

		expect(parsed.state).toBe("awaiting_review");
		expect(parsed.reviewReason).toBe(reviewReason);
		expect(parsed.nativeWorkEvidence).toBeNull();
	});

	it.each(["codex", "pi"] as const)("normalizes unsupported %s Running claims into unconfirmed Review", (agentId) => {
		const parsed = runtimeTaskSessionSummarySchema.parse({
			...baseSessionSummaryPayload,
			agentId,
			sessionInstanceId: "process-1",
		});

		expect(parsed.state).toBe("awaiting_review");
		expect(parsed.reviewReason).toBe("unconfirmed");
	});

	it("lets a durable waiting interaction override otherwise valid Running evidence", () => {
		const parsed = runtimeTaskSessionSummarySchema.parse({
			...baseSessionSummaryPayload,
			agentId: "codex",
			sessionInstanceId: "process-1",
			nativeWorkEvidence: {
				provider: "codex",
				sessionInstanceId: "process-1",
				providerSessionId: "session-1",
				turnId: "turn-1",
				hookEventName: "UserPromptSubmit",
				confirmedAt: 1_500,
				expiresAt: 301_500,
			},
			outstandingInteraction: {
				provider: "codex",
				kind: "permission",
				status: "waiting",
				requestEventName: "PermissionRequest",
				openedAt: 1_600,
				updatedAt: 1_600,
				responseSubmittedAt: null,
				responseKind: null,
				sessionInstanceId: "process-1",
				providerSessionId: "session-1",
				turnId: "turn-1",
				promptId: "prompt-1",
				toolUseId: null,
				elicitationId: null,
				providerAgentId: null,
				toolName: null,
			},
		});

		expect(parsed.state).toBe("awaiting_review");
		expect(parsed.reviewReason).toBe("hook");
		expect(parsed.nativeWorkEvidence).toBeNull();
		expect(parsed.outstandingInteraction?.status).toBe("waiting");
	});
});

describe("parseHookIngestRequest", () => {
	it("parses and trims task and project identifiers", () => {
		const parsed = parseHookIngestRequest({
			taskId: "  task-123  ",
			projectId: "  project-456  ",
			event: "to_review",
			metadata: {
				source: " claude ",
				activityText: " Using Read ",
				sessionId: "  session-789  ",
			},
		});
		expect(parsed).toEqual({
			taskId: "task-123",
			projectId: "project-456",
			event: "to_review",
			metadata: {
				source: "claude",
				activityText: "Using Read",
				hookEventName: undefined,
				toolName: undefined,
				toolInputSummary: null,
				finalMessage: undefined,
				notificationType: undefined,
				sessionId: "session-789",
				sessionInstanceId: null,
				turnId: null,
				promptId: null,
				toolUseId: null,
				elicitationId: null,
				providerAgentId: null,
				transcriptPath: null,
				conversationSummaryText: null,
			},
		});
	});

	it("throws when projectId is missing", () => {
		expect(() => {
			parseHookIngestRequest({
				taskId: "task-1",
				projectId: "   ",
				event: "to_review",
			});
		}).toThrow("Missing projectId");
	});
});

describe("parseWorktreeEnsureRequest", () => {
	it("includes branch when present", () => {
		const parsed = parseWorktreeEnsureRequest({
			taskId: "task-1",
			baseRef: "main",
			branch: "feat/foo",
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			baseRef: "main",
			branch: "feat/foo",
		});
	});

	it("includes branch as null when explicitly null", () => {
		const parsed = parseWorktreeEnsureRequest({
			taskId: "task-1",
			baseRef: "main",
			branch: null,
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			baseRef: "main",
			branch: null,
		});
	});

	it("includes branch as undefined when omitted", () => {
		const parsed = parseWorktreeEnsureRequest({
			taskId: "task-1",
			baseRef: "main",
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			baseRef: "main",
			branch: undefined,
		});
	});
});

describe("parseTaskSessionStartRequest", () => {
	it("parses resumeConversation and trims task identifiers", () => {
		const parsed = parseTaskSessionStartRequest({
			taskId: "  task-1  ",
			prompt: "",
			agentId: "codex",
			baseRef: "  main  ",
			resumeConversation: true,
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			prompt: "",
			agentId: "codex",
			baseRef: "main",
			resumeConversation: true,
		});
	});
});

describe("parseTaskSessionStopRequest", () => {
	it("preserves waitForExit while trimming the task id", () => {
		expect(parseTaskSessionStopRequest({ taskId: "  task-1  ", waitForExit: true })).toEqual({
			taskId: "task-1",
			waitForExit: true,
		});
	});
});
