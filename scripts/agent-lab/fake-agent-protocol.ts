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
	codex: "codex-cli 0.157.0",
	pi: "1.4.0",
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

// Pi 1.4.0's native value-taking options consume the next token, even when it
// looks like a flag. Keep literal system prompts out of renderer/resume detection.
const PI_OPTIONS_WITH_VALUES = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--name",
	"-n",
	"--session",
	"--session-id",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--export",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--tui-mode",
]);

const PI_BOOLEAN_OPTIONS = new Set([
	"--help",
	"-h",
	"--version",
	"-v",
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--no-session",
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--print",
	"-p",
	"--no-extensions",
	"-ne",
	"--no-mcp",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
	"--verbose",
	"--approve",
	"-a",
	"--no-approve",
	"-na",
	"--offline",
]);

function parseFakePiArguments(args: readonly string[]): {
	options: Map<string, string>;
	prompt: string;
} {
	const options = new Map<string, string>();
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			positionals.push(...args.slice(index + 1).filter((value) => !value.startsWith("@")));
			break;
		}
		if (argument && PI_OPTIONS_WITH_VALUES.has(argument)) {
			options.set(argument, args[index + 1] ?? "");
			index += 1;
		} else if (argument && PI_BOOLEAN_OPTIONS.has(argument)) {
			options.set(argument, "");
		} else if (argument?.startsWith("--")) {
			// Pi reserves unknown long flags for extensions. A bare flag owns the
			// next non-flag/non-file token; --flag=value never consumes a sibling.
			// Do not interpret extension flags as native renderer/resume options.
			const next = args[index + 1];
			if (!argument.includes("=") && next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				index += 1;
			}
		} else if (argument && !argument.startsWith("-") && !argument.startsWith("@")) {
			positionals.push(argument);
		}
	}
	return { options, prompt: positionals.join(" ") };
}

const CODEX_OPTIONS_WITH_VALUES = new Set([
	"-c",
	"--config",
	"-m",
	"--model",
	"-p",
	"--profile",
	"-s",
	"--sandbox",
	"-a",
	"--ask-for-approval",
	"--enable",
	"--disable",
	"-C",
	"--cd",
	"-i",
	"--image",
	"--add-dir",
]);

export function shouldFakeAgentUseFullscreen(
	provider: FakeAgentProvider,
	args: readonly string[],
	environment: NodeJS.ProcessEnv,
): boolean {
	if (provider === "claude") {
		return environment.CLAUDE_CODE_NO_FLICKER === "1" && environment.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN !== "1";
	}
	if (provider === "pi") {
		return parseFakePiArguments(args).options.get("--tui-mode") === "fullscreen";
	}

	// Require the actual managed Codex renderer policy, not merely the provider
	// name, so a missing adapter override cannot be hidden by the fake TUI.
	const config = new Map<string, string>();
	let noAlternateScreen = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") break;
		let override: string | undefined;
		if (argument === "-c" || argument === "--config") {
			override = args[++index];
		} else if (argument?.startsWith("-c=") || argument?.startsWith("--config=")) {
			override = argument.slice(argument.indexOf("=") + 1);
		} else if (argument && CODEX_OPTIONS_WITH_VALUES.has(argument)) {
			index += 1;
		} else if (argument === "--no-alt-screen") {
			noAlternateScreen = true;
		}
		if (override) {
			const equals = override.indexOf("=");
			if (equals > 0) config.set(override.slice(0, equals).trim(), override.slice(equals + 1).trim());
		}
	}
	return (
		!noAlternateScreen &&
		config.get("tui.fullscreen_transcript") === "true" &&
		['"always"', "'always'"].includes(config.get("tui.alternate_screen") ?? "") &&
		config.get("tui.raw_output_mode") === "false"
	);
}

function resolveFakeCodexResume(
	args: readonly string[],
): Pick<FakeAgentInvocation, "resumeKind" | "requestedSessionId"> {
	const separator = args.indexOf("--");
	const optionArgs = separator === -1 ? args : args.slice(0, separator);
	const positionals: string[] = [];
	let lastCount = 0;
	for (let index = 0; index < optionArgs.length; index += 1) {
		const argument = optionArgs[index];
		if (!argument) throw new Error("Fake Codex received an empty launch argument.");
		if (CODEX_OPTIONS_WITH_VALUES.has(argument)) {
			if (!optionArgs[index + 1]) throw new Error("Fake Codex received an option without its value.");
			index += 1;
		} else if (argument === "--last") {
			lastCount += 1;
		} else if (argument === "--continue" || argument === "--resume" || argument.startsWith("--resume=")) {
			throw new Error("Fake Codex requires the positional resume command.");
		} else if (!argument.startsWith("-")) {
			positionals.push(argument);
		}
	}
	if (positionals[0] !== "resume") {
		if (lastCount > 0 || positionals.includes("resume"))
			throw new Error("Fake Codex received an ambiguous resume command.");
		return { resumeKind: "fresh", requestedSessionId: null };
	}
	if (positionals.length === 1 && lastCount === 1) return { resumeKind: "continue", requestedSessionId: null };
	const target = positionals[1];
	if (lastCount !== 0 || positionals.length !== 2 || !target || !/^[a-zA-Z0-9_-]{1,128}$/.test(target)) {
		throw new Error("Fake Codex requires one unambiguous resume target or --last.");
	}
	return { resumeKind: "targeted", requestedSessionId: target };
}

export function resolveFakeAgentInvocation(provider: FakeAgentProvider, args: readonly string[]): FakeAgentInvocation {
	if (provider === "codex") {
		return { prompt: extractPromptArgument(args), ...resolveFakeCodexResume(args), settingsPath: null };
	}
	if (provider === "pi") {
		const { options, prompt } = parseFakePiArguments(args);
		const requestedSessionId = options.get("--session") || null;
		return {
			prompt,
			resumeKind: requestedSessionId
				? "targeted"
				: options.has("--continue") || options.has("-c")
					? "continue"
					: "fresh",
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
	| { kind: "native-interrupt" }
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
	| { kind: "progress"; message: string }
	| { kind: "write"; relativePath: string; contents: string }
	| { kind: "commit"; message: string }
	| { kind: "status" }
	| { kind: "clipboard-read" }
	| { kind: "hyperlink" }
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
	if (input === "/hyperlink") {
		return { kind: "hyperlink" };
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
	if (input === "/native-interrupt") {
		return { kind: "native-interrupt" };
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
	if (input.startsWith("/progress")) {
		return { kind: "progress", message: restAfterCommand(input) || "Checking the next step" };
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
	const separator = args.indexOf("--");
	if (separator >= 0) {
		return args.slice(separator + 1).join(" ");
	}
	return "";
}
