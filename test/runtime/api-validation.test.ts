import { describe, expect, it } from "vitest";

import { parseHookIngestRequest, parseTaskSessionStartRequest, parseWorktreeEnsureRequest } from "../../src/core";

describe("parseHookIngestRequest", () => {
	it("parses and trims task and workspace identifiers", () => {
		const parsed = parseHookIngestRequest({
			taskId: "  task-123  ",
			workspaceId: "  workspace-456  ",
			event: "to_review",
			metadata: {
				source: " claude ",
				activityText: " Using Read ",
			},
		});
		expect(parsed).toEqual({
			taskId: "task-123",
			workspaceId: "workspace-456",
			event: "to_review",
			metadata: {
				source: "claude",
				activityText: "Using Read",
				hookEventName: undefined,
				toolName: undefined,
				toolInputSummary: null,
				finalMessage: undefined,
				notificationType: undefined,
				conversationSummaryText: null,
			},
		});
	});

	it("throws when workspaceId is missing", () => {
		expect(() => {
			parseHookIngestRequest({
				taskId: "task-1",
				workspaceId: "   ",
				event: "to_review",
			});
		}).toThrow("Missing workspaceId");
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
