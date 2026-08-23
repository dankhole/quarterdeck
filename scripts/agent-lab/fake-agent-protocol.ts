import { type AgentLabScenario, AgentLabScenarioSchema } from "./types";

export type FakeAgentCommand =
	| { kind: "help" }
	| { kind: "needs-input"; message: string }
	| { kind: "approval-overlay" }
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
	if (input.startsWith("/needs-input")) {
		return { kind: "needs-input", message: restAfterCommand(input) || "Waiting for approval" };
	}
	if (input === "/approval-overlay") {
		return { kind: "approval-overlay" };
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
