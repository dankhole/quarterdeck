import { describe, expect, it } from "vitest";
import { buildHookIngestRequest, parseMetadataFromOptions } from "../../../src/commands/hook-metadata.js";
import { createConversationProgressCursor } from "../../../src/conversation/conversation-progress-cursor.js";
import { ConversationSourceHintStore } from "../../../src/conversation/source-hint-store.js";
import { parseHookIngestRequest } from "../../../src/core/api-validation.js";

describe("Pi conversation source hints", () => {
	it.each(["cli", "http"])("preserves repeated path whitespace through %s hook metadata", (transport) => {
		const sourcePath = "/custom/My  Repo\t/session.jsonl";
		const request = parseHookIngestRequest(
			buildHookIngestRequest({
				event: "activity",
				identity: { projectId: "project", taskId: "task", sessionInstanceId: "launch" },
				flagMetadata: parseMetadataFromOptions({
					source: "pi",
					...(transport === "cli" ? { sessionId: "session", transcriptPath: sourcePath } : {}),
				}),
				payload: transport === "http" ? { session_id: "session", transcript_path: sourcePath } : null,
			}),
		);
		const store = new ConversationSourceHintStore();
		store.recordProviderHookHint({
			projectId: request.projectId,
			taskId: request.taskId,
			expectedProviderSessionId: "session",
			metadata: request.metadata,
		});
		expect(store.getHint("project", "task", "session")?.sourcePath).toBe(sourcePath);
	});

	it("retains the exact authenticated hook path and launch identity, including native storage overrides", () => {
		const store = new ConversationSourceHintStore();
		store.recordProviderHookHint({
			projectId: "project",
			taskId: "task",
			expectedProviderSessionId: "session",
			metadata: {
				source: "pi",
				sessionId: "session",
				sessionInstanceId: "launch",
				transcriptPath: "/custom/profile/session.jsonl",
			},
		});
		expect(store.getHint("project", "task", "session")).toEqual({
			providerId: "pi",
			providerSessionId: "session",
			sessionInstanceId: "launch",
			sourcePath: "/custom/profile/session.jsonl",
		});
		expect(store.getHint("other", "task", "session")).toBeNull();
		expect(store.getHint("project", "other", "session")).toBeNull();
		expect(store.getHint("project", "task", "other")).toBeNull();
	});
	it.each([
		{ sessionId: null, sessionInstanceId: "launch", transcriptPath: "/session.jsonl" },
		{ sessionId: "session", sessionInstanceId: null, transcriptPath: "/session.jsonl" },
		{ sessionId: "session", sessionInstanceId: "launch", transcriptPath: "x".repeat(4097) },
	])("requires bounded path, explicit session and launch: %j", (metadata) => {
		const store = new ConversationSourceHintStore();
		store.recordProviderHookHint({
			projectId: "project",
			taskId: "task",
			expectedProviderSessionId: "session",
			metadata: { source: "pi", ...metadata },
		});
		expect(store.getHint("project", "task", "session")).toBeNull();
	});
	it("does not feed Pi sources to the Claude/Codex-only progress parser", async () => {
		const cursor = createConversationProgressCursor({
			since: 0,
			hint: {
				providerId: "pi",
				providerSessionId: "session",
				sessionInstanceId: "launch",
				sourcePath: "/session.jsonl",
			},
		});
		cursor.beginEpoch(1);
		cursor.pause();
		await expect(cursor.read()).resolves.toEqual({ text: null, hasMore: false, sourceBytesExamined: 0 });
	});
});
