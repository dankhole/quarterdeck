import { describe, expect, it } from "vitest";

import {
	appendMetadataFlags,
	normalizeHookMetadata,
	parseMetadataFromOptions,
	resolveHookEventFromPayload,
} from "../../src/commands/hook-metadata";

describe("hook metadata", () => {
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

	it.each([
		"background_tasks",
		"session_crons",
	] as const)("keeps Claude Stop with pending %s in progress", (pendingField) => {
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
	});

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
