import { type AgentLabScenario, AgentLabScenarioSchema } from "./types";

export type FakeAgentProvider = "claude" | "codex" | "pi";

export interface FakeAgentInvocation {
	prompt: string;
	resumeKind: "continue" | "fresh" | "targeted";
	requestedSessionId: string | null;
	settingsPath: string | null;
}

const FAKE_AGENT_VERSION_OUTPUT: Record<FakeAgentProvider, string> = {
	claude: "2.1.198 (Claude Code)",
	codex: "codex-cli 0.147.0",
	pi: "0.84.3",
};

export function parseFakeAgentProvider(value: string | undefined): FakeAgentProvider {
	switch (value) {
		case "claude":
		case "codex":
		case "pi":
			return value;
		default:
			return "codex";
	}
}

export function getFakeAgentVersionOutput(provider: FakeAgentProvider): string {
	return FAKE_AGENT_VERSION_OUTPUT[provider];
}

export function shouldFakeClaudeUseFullscreen(provider: FakeAgentProvider, environment: NodeJS.ProcessEnv): boolean {
	return (
		provider === "claude" &&
		environment.CLAUDE_CODE_NO_FLICKER === "1" &&
		environment.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN !== "1"
	);
}

function findOptionValue(args: readonly string[], optionName: string): string | null {
	const separator = args.indexOf("--");
	const optionArgs = separator === -1 ? args : args.slice(0, separator);
	for (let index = 0; index < optionArgs.length; index += 1) {
		const argument = optionArgs[index];
		if (argument === optionName) {
			return optionArgs[index + 1]?.trim() || null;
		}
		if (argument?.startsWith(`${optionName}=`)) {
			return argument.slice(optionName.length + 1).trim() || null;
		}
	}
	return null;
}

function extractPiPromptArgument(args: readonly string[]): string {
	for (let index = args.length - 1; index >= 0; index -= 1) {
		const argument = args[index];
		if (
			argument &&
			!argument.startsWith("-") &&
			args[index - 1] !== "--extension" &&
			args[index - 1] !== "--session"
		) {
			return argument;
		}
	}
	return "";
}

export function resolveFakeAgentInvocation(provider: FakeAgentProvider, args: readonly string[]): FakeAgentInvocation {
	if (provider === "pi") {
		const requestedSessionId = findOptionValue(args, "--session");
		return {
			prompt: extractPiPromptArgument(args),
			resumeKind: requestedSessionId ? "targeted" : args.includes("--continue") ? "continue" : "fresh",
			requestedSessionId,
			settingsPath: null,
		};
	}

	const requestedSessionId = provider === "claude" ? findOptionValue(args, "--resume") : null;
	return {
		prompt: extractPromptArgument(args),
		resumeKind: requestedSessionId ? "targeted" : args.includes("--continue") ? "continue" : "fresh",
		requestedSessionId,
		settingsPath: provider === "claude" ? findOptionValue(args, "--settings") : null,
	};
}

export function buildClaudeHookPayload(
	hookEventName: string,
	options: {
		sessionId: string;
		cwd: string;
		promptId?: string | null;
		toolName?: string;
		toolUseId?: string;
		elicitationId?: string;
		providerAgentId?: string;
		notificationType?: string;
		message?: string;
		finalMessage?: string;
		error?: string;
		backgroundWork?: boolean;
		sessionSource?: "startup" | "resume";
	},
): Record<string, unknown> {
	return {
		session_id: options.sessionId,
		transcript_path: `${options.cwd}/.agent-lab/claude/${options.sessionId}.jsonl`,
		cwd: options.cwd,
		permission_mode: "default",
		hook_event_name: hookEventName,
		...(options.promptId ? { prompt_id: options.promptId } : {}),
		...(options.toolName ? { tool_name: options.toolName } : {}),
		...(options.toolUseId ? { tool_use_id: options.toolUseId } : {}),
		...(options.elicitationId ? { elicitation_id: options.elicitationId } : {}),
		...(options.providerAgentId ? { agent_id: options.providerAgentId } : {}),
		...(options.notificationType ? { notification_type: options.notificationType } : {}),
		...(options.message ? { message: options.message } : {}),
		...(options.finalMessage ? { last_assistant_message: options.finalMessage } : {}),
		...(options.error ? { error: options.error } : {}),
		...(options.backgroundWork ? { background_tasks: [{ id: "agent-lab-background-1" }] } : {}),
		...(options.sessionSource ? { source: options.sessionSource } : {}),
	};
}

export type FakeAgentCommand =
	| { kind: "help" }
	| { kind: "needs-input"; message: string }
	| { kind: "needs-input-auto"; message: string }
	| { kind: "approval-overlay" }
	| { kind: "turn-interrupted" }
	| { kind: "new-turn"; message: string }
	| { kind: "redraw-interruption-history" }
	| { kind: "local-action"; message: string }
	| { kind: "compact" }
	| { kind: "notification"; message: string }
	| { kind: "elicitation"; message: string }
	| { kind: "elicitation-result"; message: string }
	| { kind: "background-stop"; message: string }
	| { kind: "stop-failure"; message: string }
	| { kind: "queued-follow-up"; message: string }
	| { kind: "stale-run" }
	| { kind: "fail-next-resume" }
	| { kind: "review"; message: string }
	| { kind: "working"; message: string }
	| { kind: "write"; relativePath: string; contents: string }
	| { kind: "commit"; message: string }
	| { kind: "status" }
	| { kind: "clipboard-read" }
	| { kind: "spam"; count: number }
	| { kind: "alternate-screen"; enabled: boolean }
	| { kind: "delay-review"; delayMs: number; message: string }
	| { kind: "fail"; message: string }
	| { kind: "exit"; code: number }
	| { kind: "echo"; text: string };

const DIRECTIVE_PATTERN = /\[agent-lab:(idle|needs-input|review|failure|git-dirty|terminal-stress)\]/i;

export function resolveFakeAgentScenario(prompt: string, fallback: AgentLabScenario): AgentLabScenario {
	const directive = prompt.match(DIRECTIVE_PATTERN)?.[1]?.toLowerCase();
	return directive ? AgentLabScenarioSchema.parse(directive) : fallback;
}

function restAfterCommand(input: string): string {
	const firstWhitespace = input.search(/\s/);
	return firstWhitespace === -1 ? "" : input.slice(firstWhitespace + 1).trim();
}

function parseBoundedInteger(value: string, fallback: number, minimum: number, maximum: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function parseFakeAgentCommand(rawInput: string): FakeAgentCommand {
	const input = rawInput.trim();
	if (input === "/help") {
		return { kind: "help" };
	}
	if (input === "/status") {
		return { kind: "status" };
	}
	if (input === "/clipboard-read") {
		return { kind: "clipboard-read" };
	}
	if (input === "/alt-on") {
		return { kind: "alternate-screen", enabled: true };
	}
	if (input === "/alt-off") {
		return { kind: "alternate-screen", enabled: false };
	}
	if (input.startsWith("/needs-input-auto")) {
		return { kind: "needs-input-auto", message: restAfterCommand(input) || "Provider-approved tool" };
	}
	if (input.startsWith("/needs-input")) {
		return { kind: "needs-input", message: restAfterCommand(input) || "Waiting for approval" };
	}
	if (input === "/approval-overlay") {
		return { kind: "approval-overlay" };
	}
	if (input === "/turn-interrupted") {
		return { kind: "turn-interrupted" };
	}
	if (input.startsWith("/new-turn")) {
		return { kind: "new-turn", message: restAfterCommand(input) || "Follow-up work started" };
	}
	if (input === "/redraw-interruption-history") {
		return { kind: "redraw-interruption-history" };
	}
	if (input.startsWith("/local-action")) {
		return { kind: "local-action", message: restAfterCommand(input) || "TUI setting changed" };
	}
	if (input === "/compact") {
		return { kind: "compact" };
	}
	if (input.startsWith("/notification")) {
		return { kind: "notification", message: restAfterCommand(input) || "Claude needs attention" };
	}
	if (input.startsWith("/elicitation-result")) {
		return { kind: "elicitation-result", message: restAfterCommand(input) || "Synthetic response submitted" };
	}
	if (input.startsWith("/elicitation")) {
		return { kind: "elicitation", message: restAfterCommand(input) || "Choose a synthetic option" };
	}
	if (input.startsWith("/background-stop")) {
		return { kind: "background-stop", message: restAfterCommand(input) || "Background work is still running" };
	}
	if (input.startsWith("/stop-failure")) {
		return { kind: "stop-failure", message: restAfterCommand(input) || "Synthetic Claude turn failed" };
	}
	if (input.startsWith("/queued-follow-up")) {
		return { kind: "queued-follow-up", message: restAfterCommand(input) || "Queued follow-up started" };
	}
	if (input === "/stale-run") {
		return { kind: "stale-run" };
	}
	if (input === "/fail-next-resume") {
		return { kind: "fail-next-resume" };
	}
	if (input.startsWith("/review")) {
		return { kind: "review", message: restAfterCommand(input) || "Agent-lab task is ready for review" };
	}
	if (input.startsWith("/working")) {
		return { kind: "working", message: restAfterCommand(input) || "Working on task" };
	}
	if (input.startsWith("/write")) {
		const rest = restAfterCommand(input);
		const separator = rest.search(/\s/);
		if (separator === -1) {
			return { kind: "echo", text: "Usage: /write <relative-path> <contents>" };
		}
		return {
			kind: "write",
			relativePath: rest.slice(0, separator),
			contents: rest.slice(separator + 1),
		};
	}
	if (input.startsWith("/commit")) {
		return { kind: "commit", message: restAfterCommand(input) || "agent-lab commit" };
	}
	if (input.startsWith("/spam")) {
		return { kind: "spam", count: parseBoundedInteger(restAfterCommand(input), 100, 1, 2_000) };
	}
	if (input.startsWith("/delay-review")) {
		const rest = restAfterCommand(input);
		const separator = rest.search(/\s/);
		const delayText = separator === -1 ? rest : rest.slice(0, separator);
		const message = separator === -1 ? "" : rest.slice(separator + 1).trim();
		return {
			kind: "delay-review",
			delayMs: parseBoundedInteger(delayText, 500, 0, 30_000),
			message: message || "Delayed agent-lab review",
		};
	}
	if (input.startsWith("/fail")) {
		return { kind: "fail", message: restAfterCommand(input) || "Simulated agent failure" };
	}
	if (input.startsWith("/exit")) {
		return { kind: "exit", code: parseBoundedInteger(restAfterCommand(input), 0, 0, 255) };
	}
	return { kind: "echo", text: input };
}

export function extractPromptArgument(args: readonly string[]): string {
	const separator = args.lastIndexOf("--");
	if (separator >= 0) {
		return args.slice(separator + 1).join(" ");
	}
	return "";
}
