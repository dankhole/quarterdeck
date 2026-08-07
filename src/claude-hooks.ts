import type { RuntimeHookEvent } from "./core";
import { buildQuarterdeckCommandParts, quoteShellArg } from "./core";

function buildClaudeHookCommand(event: RuntimeHookEvent, options: { reliable?: boolean } = {}): string {
	const subcommand = options.reliable || event !== "activity" ? "ingest" : "notify";
	return buildQuarterdeckCommandParts(["hooks", subcommand, "--event", event, "--source", "claude"])
		.map(quoteShellArg)
		.join(" ");
}

type ClaudeHookCommand = {
	type: "command";
	command: string;
};

type ClaudeHookMatcherGroup = {
	matcher?: string;
	hooks: ClaudeHookCommand[];
};

export type ClaudeHooksSettings = {
	hooks: {
		SessionStart: ClaudeHookMatcherGroup[];
		UserPromptSubmit: ClaudeHookMatcherGroup[];
		PreToolUse: ClaudeHookMatcherGroup[];
		PermissionRequest: ClaudeHookMatcherGroup[];
		PermissionDenied: ClaudeHookMatcherGroup[];
		PostToolUse: ClaudeHookMatcherGroup[];
		PostToolUseFailure: ClaudeHookMatcherGroup[];
		Notification: ClaudeHookMatcherGroup[];
		SubagentStart: ClaudeHookMatcherGroup[];
		SubagentStop: ClaudeHookMatcherGroup[];
		PreCompact: ClaudeHookMatcherGroup[];
		PostCompact: ClaudeHookMatcherGroup[];
		Elicitation: ClaudeHookMatcherGroup[];
		ElicitationResult: ClaudeHookMatcherGroup[];
		Stop: ClaudeHookMatcherGroup[];
		StopFailure: ClaudeHookMatcherGroup[];
	};
	statusLine?: {
		type: "command";
		command: string;
	};
};

export function buildClaudeHooksSettings(options: { statusLineCommand?: string | null } = {}): ClaudeHooksSettings {
	return {
		hooks: {
			SessionStart: [
				{
					matcher: "startup|resume|clear|compact|fork",
					hooks: [{ type: "command", command: buildClaudeHookCommand("activity", { reliable: true }) }],
				},
			],
			UserPromptSubmit: [
				{
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_in_progress") }],
				},
			],
			PreToolUse: [
				{
					matcher: "AskUserQuestion|ExitPlanMode",
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_review") }],
				},
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("activity") }],
				},
			],
			PermissionRequest: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_review") }],
				},
			],
			PermissionDenied: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("activity") }],
				},
			],
			PostToolUse: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_in_progress") }],
				},
			],
			PostToolUseFailure: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_in_progress") }],
				},
			],
			Notification: [
				{
					matcher: "permission_prompt|elicitation_dialog|agent_needs_input",
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_review") }],
				},
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("activity") }],
				},
			],
			SubagentStart: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("activity") }],
				},
			],
			SubagentStop: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("activity") }],
				},
			],
			PreCompact: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("activity") }],
				},
			],
			PostCompact: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("activity") }],
				},
			],
			Elicitation: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_review") }],
				},
			],
			ElicitationResult: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_in_progress") }],
				},
			],
			Stop: [
				{
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_review") }],
				},
			],
			StopFailure: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildClaudeHookCommand("to_review") }],
				},
			],
		},
		...(options.statusLineCommand
			? {
					statusLine: {
						type: "command" as const,
						command: options.statusLineCommand,
					},
				}
			: undefined),
	};
}
