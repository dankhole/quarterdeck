import { describe, expect, it } from "vitest";
import {
	appendMetadataFlags,
	buildHookIngestRequest,
	normalizeHookMetadata,
	parseMetadataFromOptions,
	resolveHookEventFromPayload,
} from "../../src/commands/hook-metadata";
import { normalizeHookTransitionReplayMetadata } from "../../src/hook-transition-outbox-core";

describe("buildHookIngestRequest", () => {
	it("binds a provider payload to the launch identity shared by every hook transport", () => {
		const request = buildHookIngestRequest({
			event: "to_review",
			identity: { taskId: "task-1", projectId: "project-1", sessionInstanceId: " instance-1 " },
			flagMetadata: parseMetadataFromOptions({ source: "claude" }),
			payload: {
				hook_event_name: "Stop",
				session_id: "claude-session-1",
				background_tasks: [{ type: "subagent" }],
			},
		});

		// Pending background work keeps a Claude Stop activity-only, as for the CLI.
		expect(request).toMatchObject({
			taskId: "task-1",
			projectId: "project-1",
			event: "activity",
			metadata: { source: "claude", sessionId: "claude-session-1", sessionInstanceId: "instance-1" },
			delivery: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), occurredAt: expect.any(Number) },
		});
	});

	it("omits delivery ordering identity without a session instance", () => {
		const request = buildHookIngestRequest({
			event: "activity",
			identity: { taskId: "task-1", projectId: "project-1", sessionInstanceId: null },
			flagMetadata: {},
			payload: null,
		});
		expect(request).toEqual({
			taskId: "task-1",
			projectId: "project-1",
			event: "activity",
			metadata: undefined,
			delivery: undefined,
		});
	});
});

const MARKDOWN_REPLY = [
	"**Read:** the updated files.",
	"",
	"- First item",
	"  - Nested item",
	"",
	"```ts",
	"function example() {",
	"  return true;",
	"}",
	"```",
].join("\n");

describe("hook metadata", () => {
	it("preserves Markdown in final-message flags without changing compact activity, tool, or identity flags", () => {
		const metadata = parseMetadataFromOptions({
			source: " pi\n ",
			sessionId: " session\n id ",
			activityText: " Working\n  on tests ",
			toolName: " Bash\n tool ",
			toolInputSummary: " npm\n  test ",
			finalMessage: `\r\n${MARKDOWN_REPLY.replaceAll("\n", "\r\n")}\r\n`,
			hookEventName: "AgentSettled",
		});
		expect(metadata).toMatchObject({
			source: "pi",
			sessionId: "session id",
			activityText: "Working on tests",
			toolName: "Bash tool",
			toolInputSummary: "npm test",
			finalMessage: MARKDOWN_REPLY,
		});
		expect(appendMetadataFlags([], metadata)).toContain(MARKDOWN_REPLY);
		expect(normalizeHookMetadata("to_review", null, metadata)?.finalMessage).toBe(MARKDOWN_REPLY);
		expect(normalizeHookTransitionReplayMetadata("to_review", metadata)?.finalMessage).toBe(MARKDOWN_REPLY);
	});

	it.each([
		{ last_assistant_message: MARKDOWN_REPLY },
		{ lastAssistantMessage: MARKDOWN_REPLY },
		{ "last-assistant-message": MARKDOWN_REPLY },
		{ taskComplete: { taskMetadata: { result: MARKDOWN_REPLY } } },
		{ taskComplete: { result: MARKDOWN_REPLY } },
	])("preserves final payload Markdown while inferred activity remains compact: %o", (payload) => {
		const metadata = normalizeHookMetadata(
			"to_review",
			{ hook_event_name: "Stop", ...payload },
			{ source: "claude" },
		);
		expect(metadata?.finalMessage).toBe(MARKDOWN_REPLY);
		expect(metadata?.conversationSummaryText).toBe(MARKDOWN_REPLY);
		expect(metadata?.activityText).toBe(`Final: ${MARKDOWN_REPLY.replace(/\s+/g, " ")}`);
	});

	it.each([
		{ conversation_summary_text: MARKDOWN_REPLY },
		{ conversationSummaryText: MARKDOWN_REPLY },
		{ taskComplete: { taskMetadata: { summary: MARKDOWN_REPLY } } },
	])("preserves legacy reply Markdown through the bounded recovery copy: %o", (payload) => {
		const metadata = normalizeHookMetadata(
			"to_review",
			{ hook_event_name: "AgentSettled", ...payload },
			{ source: "pi" },
		);
		expect(metadata?.conversationSummaryText).toBe(MARKDOWN_REPLY);
		const replayMetadata = normalizeHookTransitionReplayMetadata("to_review", metadata);
		expect(replayMetadata?.finalMessage).toBe(MARKDOWN_REPLY);
		expect(replayMetadata).not.toHaveProperty("conversationSummaryText");
		expect(normalizeHookMetadata("to_review", null, replayMetadata ?? {})?.finalMessage).toBe(MARKDOWN_REPLY);
	});

	it("retains reply flag precedence and the existing character caps on direct and compatibility ingress", () => {
		const text = `${MARKDOWN_REPLY}\n${"x".repeat(1_000)}`;
		const expected = `${text.slice(0, 500)}\u2026`;
		const flags = parseMetadataFromOptions({ finalMessage: text });
		expect(flags.finalMessage).toBe(expected);
		expect(
			normalizeHookMetadata(
				"to_review",
				{ hook_event_name: "Stop", last_assistant_message: text },
				{ source: "claude" },
			),
		).toMatchObject({ finalMessage: expected, conversationSummaryText: expected });
		const metadata = normalizeHookMetadata(
			"to_review",
			{ hook_event_name: "Stop", last_assistant_message: "Payload loses" },
			{ source: "claude", finalMessage: text, conversationSummaryText: text },
		);
		expect(metadata?.finalMessage).toBe(expected);
		expect(metadata?.conversationSummaryText).toBe(expected);
		expect(normalizeHookTransitionReplayMetadata("to_review", metadata)?.finalMessage).toBe(expected);
		expect(
			normalizeHookMetadata("to_review", { conversation_summary_text: text }, { source: "pi" })
				?.conversationSummaryText,
		).toBe(expected);
	});

	it.each(["startup", "resume", "clear", "compact", "fork"])(
		"retains native Codex SessionStart source %s independently of provider identity",
		(source) => {
			expect(
				normalizeHookMetadata(
					"activity",
					{ hook_event_name: "SessionStart", source, transcript_path: null },
					{ source: "codex" },
				),
			).toMatchObject({ source: "codex", sessionStartSource: source, transcriptPath: null });
		},
	);

	it.each([
		{ provider: "claude", hookEventName: "SessionStart", source: "clear" },
		{ provider: "codex", hookEventName: "UserPromptSubmit", source: "clear" },
		{ provider: "codex", hookEventName: "SessionStart", source: "unknown" },
	])("does not infer Codex navigation from unrelated payloads: %o", ({ provider, hookEventName, source }) => {
		expect(
			normalizeHookMetadata("activity", { hook_event_name: hookEventName, source }, { source: provider }),
		).not.toHaveProperty("sessionStartSource");
	});

	it("parses and forwards tool input summaries from hook flags", () => {
		const metadata = parseMetadataFromOptions({
			source: " pi ",
			toolName: " bash ",
			toolInputSummary: " npm test ",
		});

		expect(metadata).toEqual({
			source: "pi",
			toolName: "bash",
			toolInputSummary: "npm test",
		});

		expect(appendMetadataFlags(["hooks", "notify"], metadata)).toEqual([
			"hooks",
			"notify",
			"--source",
			"pi",
			"--tool-name",
			"bash",
			"--tool-input-summary",
			"npm test",
		]);
	});

	it("infers a compact tool input summary from structured hook payloads", () => {
		const metadata = normalizeHookMetadata(
			"activity",
			{
				hookEventName: "PreToolUse",
				toolName: "Bash",
				tool_input: {
					command: "npm run typecheck",
				},
			},
			{},
		);

		expect(metadata).toEqual(
			expect.objectContaining({
				hookEventName: "PreToolUse",
				toolName: "Bash",
				toolInputSummary: "Bash: npm run typecheck",
				activityText: "Using Bash: npm run typecheck",
			}),
		);
	});

	it("accepts explicit activity_text/tool_input_summary payload fields (e.g. Pi's HTTP POST, which carries no CLI flags)", () => {
		const metadata = normalizeHookMetadata(
			"activity",
			{
				hook_event_name: "ToolExecutionStart",
				activity_text: "Using Bash: npm test",
				tool_name: "Bash",
				tool_input_summary: "npm test",
			},
			{},
		);

		expect(metadata).toEqual(
			expect.objectContaining({
				hookEventName: "ToolExecutionStart",
				activityText: "Using Bash: npm test",
				toolInputSummary: "npm test",
			}),
		);
	});

	it("accepts explicit activityText/toolInputSummary camelCase payload fields", () => {
		const metadata = normalizeHookMetadata(
			"activity",
			{
				hookEventName: "ToolExecutionEnd",
				activityText: "Completed Bash: npm test",
				toolInputSummary: "npm test",
			},
			{},
		);

		expect(metadata).toEqual(
			expect.objectContaining({
				activityText: "Completed Bash: npm test",
				toolInputSummary: "npm test",
			}),
		);
	});

	it("ranks explicit payload activity_text/tool_input_summary below a flag but above inference", () => {
		const explicitOnly = normalizeHookMetadata(
			"activity",
			{
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "npm run typecheck" },
				activity_text: "Explicit activity text",
				tool_input_summary: "Explicit tool summary",
			},
			{},
		);
		// An explicit payload field beats the endpoint's own inference from the
		// structured tool_input (which would otherwise produce "Using Bash: ...").
		expect(explicitOnly).toEqual(
			expect.objectContaining({
				activityText: "Explicit activity text",
				toolInputSummary: "Explicit tool summary",
			}),
		);

		const flagWins = normalizeHookMetadata(
			"activity",
			{
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				activity_text: "Explicit activity text",
				tool_input_summary: "Explicit tool summary",
			},
			{ activityText: "Flag activity text", toolInputSummary: "Flag tool summary" },
		);
		// A CLI/HTTP-flag value still wins over the explicit payload field.
		expect(flagWins).toEqual(
			expect.objectContaining({
				activityText: "Flag activity text",
				toolInputSummary: "Flag tool summary",
			}),
		);
	});

	it("preserves provider prompt, tool, elicitation, and background-agent identities", () => {
		const metadata = normalizeHookMetadata(
			"to_in_progress",
			{
				hook_event_name: "PostToolUse",
				turn_id: "turn-123",
				prompt_id: "prompt-234",
				tool_use_id: "tool-456",
				elicitation_id: "elicitation-567",
				agent_id: "agent-678",
			},
			{ source: "codex", sessionInstanceId: "process-789" },
		);

		expect(metadata).toEqual(
			expect.objectContaining({
				sessionInstanceId: "process-789",
				turnId: "turn-123",
				promptId: "prompt-234",
				toolUseId: "tool-456",
				elicitationId: "elicitation-567",
				providerAgentId: "agent-678",
			}),
		);
		expect(appendMetadataFlags(["hooks", "ingest"], metadata)).toEqual(
			expect.arrayContaining([
				"--session-instance-id",
				"process-789",
				"--turn-id",
				"turn-123",
				"--tool-use-id",
				"tool-456",
				"--prompt-id",
				"prompt-234",
				"--elicitation-id",
				"elicitation-567",
				"--provider-agent-id",
				"agent-678",
			]),
		);
	});

	it("uses Claude Stop last_assistant_message as conversation summary metadata", () => {
		const metadata = normalizeHookMetadata(
			"to_review",
			{
				session_id: "claude-session-123",
				hook_event_name: "Stop",
				transcript_path: "/Users/dev/.claude/projects/repo/claude-session-123.jsonl",
				last_assistant_message: "Finished the runtime hook cleanup with focused tests.",
			},
			{ source: "claude", sessionId: "claude-session-123" },
		);

		expect(metadata).toEqual(
			expect.objectContaining({
				source: "claude",
				sessionId: "claude-session-123",
				hookEventName: "Stop",
				finalMessage: "Finished the runtime hook cleanup with focused tests.",
				conversationSummaryText: "Finished the runtime hook cleanup with focused tests.",
				activityText: "Final: Finished the runtime hook cleanup with focused tests.",
			}),
		);
	});

	it.each(["background_tasks", "session_crons"] as const)(
		"keeps Claude Stop with pending %s in progress",
		(pendingField) => {
			const payload = {
				hook_event_name: "Stop",
				last_assistant_message: "I started background work and will continue when it finishes.",
				background_tasks: [],
				session_crons: [],
				[pendingField]: [{ id: "pending-1" }],
			};

			expect(resolveHookEventFromPayload("to_review", payload, "claude")).toBe("activity");
			expect(normalizeHookMetadata("activity", payload, { source: "claude" })).toEqual(
				expect.objectContaining({
					hookEventName: "Stop",
					activityText: "Waiting for background work",
					finalMessage: null,
					conversationSummaryText: null,
				}),
			);
		},
	);

	it("keeps a completed Claude Stop as a review transition when pending-work arrays are empty", () => {
		const payload = {
			hook_event_name: "Stop",
			last_assistant_message: "Done.",
			background_tasks: [],
			session_crons: [],
		};

		expect(resolveHookEventFromPayload("to_review", payload, "claude")).toBe("to_review");
		expect(
			resolveHookEventFromPayload("to_review", { ...payload, background_tasks: [{ id: "other" }] }, "codex"),
		).toBe("to_review");
	});

	it("moves a Claude Stop to review without retiring the prompt when only shells or monitors remain", () => {
		const payload = {
			hook_event_name: "Stop",
			last_assistant_message: "The backend is running at http://127.0.0.1:8765.",
			background_tasks: [
				{ id: "shell-1", type: "shell", status: "running", description: "Launch backend", command: "just run" },
				{ id: "monitor-1", type: "monitor", status: "running", description: "Watch logs" },
			],
			session_crons: [],
		};

		expect(resolveHookEventFromPayload("to_review", payload, "claude")).toBe("to_review");
		expect(normalizeHookMetadata("to_review", payload, { source: "claude" })).toEqual(
			expect.objectContaining({
				finalMessage: "The backend is running at http://127.0.0.1:8765.",
				unboundedBackgroundWorkPending: true,
			}),
		);
		expect(
			resolveHookEventFromPayload(
				"to_review",
				{
					...payload,
					background_tasks: [
						...payload.background_tasks,
						{ id: "agent-1", type: "subagent", status: "running", description: "Explore" },
					],
				},
				"claude",
			),
		).toBe("activity");
	});

	it("bounds native final-message metadata before runtime persistence", () => {
		const metadata = normalizeHookMetadata(
			"to_review",
			{
				hook_event_name: "Stop",
				last_assistant_message: "x".repeat(2_000),
			},
			{ source: "claude" },
		);

		expect(metadata?.finalMessage).toHaveLength(501);
		expect(metadata?.finalMessage).toMatch(/\u2026$/);
		expect(metadata?.conversationSummaryText).toHaveLength(501);
		expect(metadata?.activityText).toHaveLength(501);
	});

	it("does not promote Claude SubagentStop final text into task conversation summaries", () => {
		const metadata = normalizeHookMetadata(
			"activity",
			{
				hook_event_name: "SubagentStop",
				agent_type: "Explore",
				last_assistant_message: "Subagent found three candidate files.",
			},
			{ source: "claude" },
		);

		expect(metadata).toEqual(
			expect.objectContaining({
				source: "claude",
				hookEventName: "SubagentStop",
				finalMessage: "Subagent found three candidate files.",
				activityText: "Final: Subagent found three candidate files.",
				conversationSummaryText: null,
			}),
		);
	});

	it("summarizes Claude lifecycle activity hooks without transcript parsing", () => {
		expect(
			normalizeHookMetadata(
				"activity",
				{ hook_event_name: "SubagentStart", agent_type: "Explore" },
				{ source: "claude" },
			),
		).toEqual(expect.objectContaining({ activityText: "Subagent started: Explore" }));

		expect(
			normalizeHookMetadata(
				"activity",
				{ hook_event_name: "PostCompact", compact_summary: "Compaction state, not a completed turn." },
				{ source: "claude" },
			),
		).toEqual(
			expect.objectContaining({
				activityText: "Compacted context",
				finalMessage: null,
				conversationSummaryText: null,
			}),
		);
	});

	it.each([
		[{ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }, "Needs input"],
		[{ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" }, "Waiting for plan approval"],
		[{ hook_event_name: "Elicitation" }, "Needs input"],
		[{ hook_event_name: "ElicitationResult" }, "Resumed after user input"],
	] as const)("labels Claude interactive wait hooks", (payload, expectedActivity) => {
		expect(normalizeHookMetadata("activity", payload, { source: "claude" })).toEqual(
			expect.objectContaining({ activityText: expectedActivity }),
		);
	});

	it("labels Claude agent-needs-input notifications as input activity", () => {
		expect(
			normalizeHookMetadata(
				"to_review",
				{ hook_event_name: "Notification", notification_type: "agent_needs_input" },
				{ source: "claude" },
			),
		).toEqual(
			expect.objectContaining({
				hookEventName: "Notification",
				notificationType: "agent_needs_input",
				activityText: "Needs input",
			}),
		);
	});

	it("includes Claude StopFailure error metadata in activity text", () => {
		expect(
			normalizeHookMetadata(
				"to_review",
				{
					hook_event_name: "StopFailure",
					error: "rate_limit",
					last_assistant_message: "API Error: Rate limit reached",
				},
				{ source: "claude" },
			),
		).toEqual(
			expect.objectContaining({
				hookEventName: "StopFailure",
				finalMessage: "API Error: Rate limit reached",
				activityText: "Claude turn failed: rate_limit",
			}),
		);
	});
});
