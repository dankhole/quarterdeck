import { stripAnsi } from "@runtime-terminal-utils";

const INTERRUPT_ACK_PATTERN = /(?:\^C|keyboardinterrupt|terminated|canceled|cancelled|aborted|interrupt)/i;
const POWER_SHELL_PROMPT_PATTERN = /(?:^|\n)PS [^\n\r>]{0,200}> $/;
const CMD_PROMPT_PATTERN = /(?:^|\n)[A-Za-z]:\\[^\n\r]{0,200}> $/;
const POSIX_PROMPT_PATTERN = /(?:^|\n)[^\n\r]{0,200}[%#$] $/;
const GLYPH_PROMPT_PATTERN = /(?:^|\n)[^\n\r]{0,200}[❯➜λ] $/;
const GENERIC_PATH_PROMPT_PATTERN = /(?:^|\n)(?:~|\.?\.?(?:[\\/][^\n\r ]+)*) ?> $/;
const MAX_HEURISTIC_BUFFER_CHARS = 4000;

export function sanitizeTerminalHeuristicText(text: string): string {
	const withoutAnsi = stripAnsi(text);
	return withoutAnsi.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function appendTerminalHeuristicText(buffer: string, chunk: string): string {
	const combined = `${buffer}${sanitizeTerminalHeuristicText(chunk)}`;
	return combined.length > MAX_HEURISTIC_BUFFER_CHARS ? combined.slice(-MAX_HEURISTIC_BUFFER_CHARS) : combined;
}

export function hasInterruptAcknowledgement(text: string): boolean {
	return INTERRUPT_ACK_PATTERN.test(text);
}

export function hasLikelyShellPrompt(text: string): boolean {
	return (
		POWER_SHELL_PROMPT_PATTERN.test(text) ||
		CMD_PROMPT_PATTERN.test(text) ||
		POSIX_PROMPT_PATTERN.test(text) ||
		GLYPH_PROMPT_PATTERN.test(text) ||
		GENERIC_PATH_PROMPT_PATTERN.test(text)
	);
}
