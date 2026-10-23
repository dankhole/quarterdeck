import type { RuntimeHookEvent } from "./core/api/task-session.js";
import { buildQuarterdeckHookCommandLine } from "./core/quarterdeck-command.js";
import type { HookHttpTransport } from "./terminal/hook-http-channel.js";

// Claude hook timeouts are in seconds. Best-effort `hooks notify` delivery is
// capped at 250ms, so its process gets a short bound; the HTTP transport has no
// process startup and the runtime answers before ingesting, so it gets 1s.
// Reliable `hooks ingest` enqueues to the hook outbox before posting (a 2.25s
// first attempt within a 3.25s total budget that includes one retry); periodic
// runtime replay only adopts an unabandoned record once it is older than
// HOOK_TRANSITION_LIVE_REPLAY_MIN_AGE_MS (6s), so it does not race a live
// attempt. A process killed before it enqueues loses the transition, so the
// bound leaves headroom for slow process startup under load while still
// replacing Claude's 600s default.
export const CLAUDE_NOTIFY_HOOK_TIMEOUT_SECONDS = 5;
export const CLAUDE_HTTP_HOOK_TIMEOUT_SECONDS = 1;
export const CLAUDE_INGEST_HOOK_TIMEOUT_SECONDS = 30;

function claudeHookSubcommand(event: RuntimeHookEvent, options: { reliable?: boolean }): "ingest" | "notify" {
	return options.reliable || event !== "activity" ? "ingest" : "notify";
}

function buildClaudeHookCommand(event: RuntimeHookEvent, options: { reliable?: boolean } = {}): ClaudeCommandHook {
	const subcommand = claudeHookSubcommand(event, options);
	return {
		type: "command",
		command: buildQuarterdeckHookCommandLine(["hooks", subcommand, "--event", event, "--source", "claude"]),
		timeout: subcommand === "notify" ? CLAUDE_NOTIFY_HOOK_TIMEOUT_SECONDS : CLAUDE_INGEST_HOOK_TIMEOUT_SECONDS,
	};
}

/** Best-effort (`notify`) hooks take the HTTP transport; reliable (`ingest`) hooks stay commands. */
function buildClaudeHookHandler(
	event: RuntimeHookEvent,
	options: { reliable?: boolean; httpNotify: HookHttpTransport },
): ClaudeHookHandler {
	return claudeHookSubcommand(event, options) === "notify"
		? buildClaudeHttpNotifyHook(event, options.httpNotify)
		: buildClaudeHookCommand(event, options);
}

// The same best-effort delivery as `hooks notify --event <event> --source claude`
// without spawning a process. The URL carries no credential: Claude interpolates
// the task-session identity and its launch-scoped credential into headers from
// allowlisted environment variables. Reliable events never use this transport;
// ordinary PreToolUse is deliberately best-effort here (see the settings builder).
function buildClaudeHttpNotifyHook(event: RuntimeHookEvent, transport: HookHttpTransport): ClaudeHttpHook {
	const url = new URL(transport.url);
	url.searchParams.set("event", event);
	url.searchParams.set("source", "claude");
	return {
		type: "http",
		url: url.toString(),
		timeout: CLAUDE_HTTP_HOOK_TIMEOUT_SECONDS,
		headers: { ...transport.headers },
		allowedEnvVars: [...transport.allowedEnvVars],
	};
}

export type ClaudeCommandHook = {
	type: "command";
	command: string;
	timeout: number;
};

export type ClaudeHttpHook = {
	type: "http";
	url: string;
	timeout: number;
	headers: Record<string, string>;
	allowedEnvVars: string[];
};

export type ClaudeHookHandler = ClaudeCommandHook | ClaudeHttpHook;

type ClaudeHookMatcherGroup<THook extends ClaudeHookHandler> = {
	matcher?: string;
	hooks: THook[];
};

/** Settings whose hooks are all commands unless built with the HTTP transport. */
export type ClaudeHooksSettings<THook extends ClaudeHookHandler = ClaudeCommandHook> = {
	hooks: {
		SessionStart: ClaudeHookMatcherGroup<THook>[];
		UserPromptSubmit: ClaudeHookMatcherGroup<THook>[];
		PreToolUse: ClaudeHookMatcherGroup<THook>[];
		PermissionRequest: ClaudeHookMatcherGroup<THook>[];
		PermissionDenied: ClaudeHookMatcherGroup<THook>[];
		PostToolUse: ClaudeHookMatcherGroup<THook>[];
		PostToolUseFailure: ClaudeHookMatcherGroup<THook>[];
		Notification: ClaudeHookMatcherGroup<THook>[];
		SubagentStart: ClaudeHookMatcherGroup<THook>[];
		SubagentStop: ClaudeHookMatcherGroup<THook>[];
		PreCompact: ClaudeHookMatcherGroup<THook>[];
		PostCompact: ClaudeHookMatcherGroup<THook>[];
		Elicitation: ClaudeHookMatcherGroup<THook>[];
		ElicitationResult: ClaudeHookMatcherGroup<THook>[];
		Stop: ClaudeHookMatcherGroup<THook>[];
		StopFailure: ClaudeHookMatcherGroup<THook>[];
	};
};

/** Launch settings that deliver every hook through the Quarterdeck hook CLI. */
export function buildClaudeHooksSettings(): ClaudeHooksSettings {
	return buildSettings((event, hookOptions) => buildClaudeHookCommand(event, hookOptions));
}

/**
 * Launch settings that deliver best-effort hooks to the runtime's loopback
 * endpoint. Reliable hooks, including SessionStart (which Claude only runs as a
 * command), keep the CLI and its durable outbox.
 */
export function buildClaudeHttpHooksSettings(options: {
	httpNotify: HookHttpTransport;
}): ClaudeHooksSettings<ClaudeHookHandler> {
	return buildSettings(
		(event, hookOptions) => buildClaudeHookHandler(event, { ...hookOptions, httpNotify: options.httpNotify }),
		// Ordinary tool starts are ~a third of all hooks and Claude blocks the tool
		// on them. Losing one only drops activity and an ordering receipt (permission
		// correlation then fails closed); the next reliable hook restores Running.
		// The reducer treats a PreToolUse `activity` like `to_in_progress`, so it may
		// still refresh or restore Running. A failed HTTP hook never blocks the tool.
		() => buildClaudeHttpNotifyHook("activity", options.httpNotify),
	);
}

/** Tools whose PreToolUse opens a user interaction and so must stay reliable. */
export const CLAUDE_INTERACTION_TOOL_MATCHER = "AskUserQuestion|ExitPlanMode";
// Claude evaluates matchers with regex syntax as unanchored JavaScript RegExps.
export const CLAUDE_NON_INTERACTION_TOOL_MATCHER = "^(?!(?:AskUserQuestion|ExitPlanMode)$)";

function buildSettings<THook extends ClaudeHookHandler>(
	hook: (event: RuntimeHookEvent, options?: { reliable?: boolean }) => THook,
	bestEffortToolStart?: () => THook,
): ClaudeHooksSettings<THook> {
	return {
		hooks: {
			SessionStart: [
				{
					matcher: "startup|resume|clear|compact|fork",
					hooks: [hook("activity", { reliable: true })],
				},
			],
			UserPromptSubmit: [
				{
					hooks: [hook("to_in_progress")],
				},
			],
			PreToolUse: bestEffortToolStart
				? [
						{
							matcher: CLAUDE_INTERACTION_TOOL_MATCHER,
							hooks: [hook("to_in_progress")],
						},
						{
							matcher: CLAUDE_NON_INTERACTION_TOOL_MATCHER,
							hooks: [bestEffortToolStart()],
						},
					]
				: [
						{
							matcher: "*",
							hooks: [hook("to_in_progress")],
						},
					],
			PermissionRequest: [
				{
					matcher: "*",
					hooks: [hook("to_review")],
				},
			],
			PermissionDenied: [
				{
					matcher: "*",
					hooks: [hook("activity", { reliable: true })],
				},
			],
			PostToolUse: [
				{
					matcher: "*",
					hooks: [hook("to_in_progress")],
				},
			],
			PostToolUseFailure: [
				{
					matcher: "*",
					hooks: [hook("to_in_progress")],
				},
			],
			Notification: [
				{
					matcher: "*",
					hooks: [hook("activity")],
				},
			],
			SubagentStart: [
				{
					matcher: "*",
					hooks: [hook("activity")],
				},
			],
			SubagentStop: [
				{
					matcher: "*",
					// Reliable: it is the only evidence that retires a finished or killed
					// subagent's Needs Input wait, so it must not ride the best-effort transport.
					hooks: [hook("activity", { reliable: true })],
				},
			],
			PreCompact: [
				{
					matcher: "*",
					hooks: [hook("activity")],
				},
			],
			PostCompact: [
				{
					matcher: "*",
					hooks: [hook("activity")],
				},
			],
			Elicitation: [
				{
					matcher: "*",
					hooks: [hook("to_review")],
				},
			],
			ElicitationResult: [
				{
					matcher: "*",
					hooks: [hook("to_in_progress")],
				},
			],
			Stop: [
				{
					hooks: [hook("to_review")],
				},
			],
			StopFailure: [
				{
					matcher: "*",
					hooks: [hook("to_review")],
				},
			],
		},
	};
}
