import { describe, expect, it } from "vitest";

import {
	buildClaudeHooksSettings,
	buildClaudeHttpHooksSettings,
	CLAUDE_HTTP_HOOK_TIMEOUT_SECONDS,
	CLAUDE_INGEST_HOOK_TIMEOUT_SECONDS,
	CLAUDE_INTERACTION_TOOL_MATCHER,
	CLAUDE_NOTIFY_HOOK_TIMEOUT_SECONDS,
	type ClaudeHooksSettings,
} from "../../src/claude-hooks";
import { buildQuarterdeckHookCommandLine } from "../../src/core";
import { HookHttpChannel, type HookHttpTransport } from "../../src/terminal/hook-http-channel";

function hookCommand(event: string, options: { reliable?: boolean } = {}): string {
	const subcommand = options.reliable || event !== "activity" ? "ingest" : "notify";
	return buildQuarterdeckHookCommandLine(["hooks", subcommand, "--event", event, "--source", "claude"]);
}

function allHookCommands(settings: ClaudeHooksSettings): Array<{ command: string; timeout?: number }> {
	return Object.values(settings.hooks).flatMap((groups) =>
		groups.flatMap((group) => group.hooks.map((hook) => ({ command: hook.command, timeout: hook.timeout }))),
	);
}

describe("buildClaudeHooksSettings", () => {
	it("subscribes to every Claude hook event Quarterdeck relies on", () => {
		const settings = buildClaudeHooksSettings();

		expect(Object.keys(settings.hooks)).toEqual([
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PermissionRequest",
			"PermissionDenied",
			"PostToolUse",
			"PostToolUseFailure",
			"Notification",
			"SubagentStart",
			"SubagentStop",
			"PreCompact",
			"PostCompact",
			"Elicitation",
			"ElicitationResult",
			"Stop",
			"StopFailure",
		]);
	});

	it("captures SessionStart identity for startup, resume, clear, compact, and fork", () => {
		const { SessionStart } = buildClaudeHooksSettings().hooks;
		expect(SessionStart).toHaveLength(1);
		expect(SessionStart[0]?.matcher).toBe("startup|resume|clear|compact|fork");
	});

	it("keeps SessionStart and PermissionDenied on reliable ingest even though their event is activity", () => {
		const { SessionStart, PermissionDenied, PreToolUse } = buildClaudeHooksSettings().hooks;

		expect(SessionStart[0]?.hooks[0]?.command).toBe(hookCommand("activity", { reliable: true }));
		expect(PermissionDenied[0]?.hooks[0]?.command).toBe(hookCommand("activity", { reliable: true }));
		// A plain, non-reliable "activity" hook uses best-effort notify instead.
		expect(PreToolUse[0]?.hooks[0]?.command).not.toBe(hookCommand("activity", { reliable: true }));
	});

	it("routes best-effort activity-only hooks through notify", () => {
		const { Notification, SubagentStart, PreCompact, PostCompact } = buildClaudeHooksSettings().hooks;

		for (const group of [Notification, SubagentStart, PreCompact, PostCompact]) {
			expect(group[0]?.matcher).toBe("*");
			expect(group[0]?.hooks[0]?.command).toBe(hookCommand("activity"));
		}
	});

	it("routes state-transition hooks (to_in_progress / to_review) through reliable ingest", () => {
		const { UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, ElicitationResult } =
			buildClaudeHooksSettings().hooks;
		const { PermissionRequest, Elicitation, Stop, StopFailure } = buildClaudeHooksSettings().hooks;

		expect(UserPromptSubmit[0]?.hooks[0]?.command).toBe(hookCommand("to_in_progress"));
		expect(PreToolUse[0]?.hooks[0]?.command).toBe(hookCommand("to_in_progress"));
		expect(PostToolUse[0]?.hooks[0]?.command).toBe(hookCommand("to_in_progress"));
		expect(PostToolUseFailure[0]?.hooks[0]?.command).toBe(hookCommand("to_in_progress"));
		expect(ElicitationResult[0]?.hooks[0]?.command).toBe(hookCommand("to_in_progress"));

		expect(PermissionRequest[0]?.hooks[0]?.command).toBe(hookCommand("to_review"));
		expect(Elicitation[0]?.hooks[0]?.command).toBe(hookCommand("to_review"));
		expect(Stop[0]?.hooks[0]?.command).toBe(hookCommand("to_review"));
		expect(StopFailure[0]?.hooks[0]?.command).toBe(hookCommand("to_review"));
	});

	it("matches tool-scoped hooks with a wildcard matcher", () => {
		const { PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure } =
			buildClaudeHooksSettings().hooks;

		for (const group of [PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure]) {
			expect(group[0]?.matcher).toBe("*");
		}
	});

	it("leaves UserPromptSubmit and Stop unmatched (they are not tool-scoped)", () => {
		const { UserPromptSubmit, Stop } = buildClaudeHooksSettings().hooks;
		expect(UserPromptSubmit[0]?.matcher).toBeUndefined();
		expect(Stop[0]?.matcher).toBeUndefined();
	});

	it("bounds only best-effort notify hooks; reliable ingest hooks get a longer bound", () => {
		const hooks = allHookCommands(buildClaudeHooksSettings());
		const notifyCommand = hookCommand("activity");
		const notify = hooks.filter((hook) => hook.command === notifyCommand);
		const ingest = hooks.filter((hook) => hook.command !== notifyCommand);
		expect(notify.length).toBeGreaterThan(0);
		expect(ingest.length).toBeGreaterThan(0);
		for (const hook of notify) {
			expect(hook.timeout).toBe(CLAUDE_NOTIFY_HOOK_TIMEOUT_SECONDS);
		}
		for (const hook of ingest) {
			expect(hook.timeout).toBe(CLAUDE_INGEST_HOOK_TIMEOUT_SECONDS);
		}
	});

	it("gives every generated hook the command shape Claude settings.json expects", () => {
		const settings = buildClaudeHooksSettings();
		for (const groups of Object.values(settings.hooks)) {
			for (const group of groups) {
				for (const hook of group.hooks) {
					expect(hook).toMatchObject({ type: "command", command: expect.any(String) });
					expect(hook.command.length).toBeGreaterThan(0);
					expect(Object.keys(hook).every((key) => ["type", "command", "timeout"].includes(key))).toBe(true);
				}
			}
		}
	});

	it("configures only hooks, never a Claude statusLine", () => {
		expect(Object.keys(buildClaudeHooksSettings())).toEqual(["hooks"]);
	});
});

describe("buildClaudeHttpHooksSettings", () => {
	const BEST_EFFORT_EVENTS = ["Notification", "SubagentStart", "PreCompact", "PostCompact"];

	function publishedTransport(): HookHttpTransport {
		const channel = new HookHttpChannel();
		channel.publishEndpoint("http://127.0.0.1:43123");
		const launch = channel.prepareLaunch({
			taskId: "task-1",
			projectId: "project-1",
			sessionInstanceId: "instance-1",
		});
		if (!launch) throw new Error("Expected a published hook HTTP channel.");
		return launch.transport;
	}

	it("moves exactly the best-effort notify hooks to HTTP and leaves reliable hooks as commands", () => {
		const transport = publishedTransport();
		const commandSettings = buildClaudeHooksSettings();
		const httpSettings = buildClaudeHttpHooksSettings({ httpNotify: transport });

		expect(Object.keys(httpSettings.hooks)).toEqual(Object.keys(commandSettings.hooks));
		const notifyEvents = Object.entries(commandSettings.hooks)
			.filter(([, groups]) => groups[0]?.hooks[0]?.command === hookCommand("activity"))
			.map(([name]) => name);
		expect(notifyEvents).toEqual(BEST_EFFORT_EVENTS);

		for (const [name, groups] of Object.entries(httpSettings.hooks)) {
			// PreToolUse splits by tool; covered by its own test below.
			if (name === "PreToolUse") continue;
			const commandGroups = commandSettings.hooks[name as keyof ClaudeHooksSettings["hooks"]];
			expect(groups.map((group) => group.matcher)).toEqual(commandGroups.map((group) => group.matcher));
			if (BEST_EFFORT_EVENTS.includes(name)) {
				expect(groups[0]?.hooks).toEqual([
					{
						type: "http",
						url: `${transport.url}?event=activity&source=claude`,
						timeout: CLAUDE_HTTP_HOOK_TIMEOUT_SECONDS,
						headers: transport.headers,
						allowedEnvVars: transport.allowedEnvVars,
					},
				]);
			} else {
				expect(groups).toEqual(commandGroups);
			}
		}
		// HTTP hooks have no process startup and get answered before ingest; command notify keeps its bound.
		expect([CLAUDE_HTTP_HOOK_TIMEOUT_SECONDS, CLAUDE_NOTIFY_HOOK_TIMEOUT_SECONDS]).toEqual([1, 5]);
		// Claude runs SessionStart only as a command hook; it is reliable regardless.
		expect(httpSettings.hooks.SessionStart[0]?.hooks[0]).toEqual({
			type: "command",
			command: hookCommand("activity", { reliable: true }),
			timeout: CLAUDE_INGEST_HOOK_TIMEOUT_SECONDS,
		});
	});

	it("sends ordinary tool starts over HTTP and keeps interaction-opening tools on reliable ingest", () => {
		const transport = publishedTransport();
		const [interactionGroup, toolGroup, ...rest] = buildClaudeHttpHooksSettings({ httpNotify: transport }).hooks
			.PreToolUse;
		expect(rest).toEqual([]);
		expect(interactionGroup).toEqual({
			matcher: CLAUDE_INTERACTION_TOOL_MATCHER,
			hooks: [
				{ type: "command", command: hookCommand("to_in_progress"), timeout: CLAUDE_INGEST_HOOK_TIMEOUT_SECONDS },
			],
		});
		expect(toolGroup?.hooks).toEqual([
			{
				type: "http",
				url: `${transport.url}?event=activity&source=claude`,
				timeout: CLAUDE_HTTP_HOOK_TIMEOUT_SECONDS,
				headers: transport.headers,
				allowedEnvVars: transport.allowedEnvVars,
			},
		]);

		// Mirrors Claude's matcher rules: an exact `|` list, and an unanchored
		// JavaScript RegExp for anything with other characters.
		const exact = new Set(CLAUDE_INTERACTION_TOOL_MATCHER.split("|"));
		const toolPattern = new RegExp(toolGroup?.matcher ?? "");
		for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
			expect(exact.has(tool)).toBe(true);
			expect(toolPattern.test(tool)).toBe(false);
		}
		for (const tool of ["Bash", "Read", "Edit", "mcp__github__create_issue", "AskUserQuestionTool", "Task"]) {
			expect(exact.has(tool)).toBe(false);
			expect(toolPattern.test(tool)).toBe(true);
		}
	});

	it("keeps credentials and identity out of the URL and interpolates them only from allowlisted env vars", () => {
		const transport = publishedTransport();
		const hook = buildClaudeHttpHooksSettings({ httpNotify: transport }).hooks.SubagentStart[0]?.hooks[0];
		if (hook?.type !== "http") throw new Error("Expected an HTTP SubagentStart hook.");

		const url = new URL(hook.url);
		expect(`${url.origin}${url.pathname}`).toBe("http://127.0.0.1:43123/api/hooks/notify");
		expect([...url.searchParams.keys()]).toEqual(["event", "source"]);
		expect(hook.allowedEnvVars).toEqual([
			"QUARTERDECK_HOOK_HTTP_TOKEN",
			"QUARTERDECK_HOOK_TASK_ID",
			"QUARTERDECK_HOOK_PROJECT_ID",
			"QUARTERDECK_HOOK_SESSION_INSTANCE_ID",
		]);
		// Claude's `${VAR}` interpolation syntax, not JavaScript template placeholders.
		expect(hook.headers).toEqual({
			"x-quarterdeck-hook-token": `\${QUARTERDECK_HOOK_HTTP_TOKEN}`,
			"x-quarterdeck-hook-task-id": `\${QUARTERDECK_HOOK_TASK_ID}`,
			"x-quarterdeck-hook-project-id": `\${QUARTERDECK_HOOK_PROJECT_ID}`,
			"x-quarterdeck-hook-session-instance-id": `\${QUARTERDECK_HOOK_SESSION_INSTANCE_ID}`,
		});
	});

	it("configures only hooks, never a Claude statusLine", () => {
		expect(Object.keys(buildClaudeHttpHooksSettings({ httpNotify: publishedTransport() }))).toEqual(["hooks"]);
	});
});
