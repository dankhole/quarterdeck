import { describe, expect, it } from "vitest";

import {
	parseHookIngestRequest,
	parseTaskSessionStartRequest,
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
			baseRef: "  main  ",
			resumeConversation: true,
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			prompt: "",
			baseRef: "main",
			resumeConversation: true,
		});
	});
});
