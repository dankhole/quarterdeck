import type { ConversationEntry, ConversationMessageEntry } from "../conversation/contracts";

export const MAX_TITLE_CONTEXT_LENGTH = 6_000;
const USER_CONTEXT_BUDGET = 3_200;
const ASSISTANT_CONTEXT_BUDGET = 2_000;
const MAX_MESSAGES_PER_ROLE = 8;

/** Retain closing requests/corrections as well as the opening subject. */
export function limitTitleContext(text: string, maxLength: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	const marker = "\n[…]\n";
	const headLength = Math.ceil((maxLength - marker.length) / 2);
	const tailLength = maxLength - marker.length - headLength;
	return `${trimmed.slice(0, headLength)}${marker}${trimmed.slice(-tailLength)}`;
}

/** A small, deterministic transcript window; user steering cannot be crowded out by long replies. */
export function buildTitleThreadContext({
	prompt,
	entries,
	finalMessage,
}: {
	prompt: string | null | undefined;
	entries: readonly ConversationEntry[];
	finalMessage?: string | null;
}): string | null {
	const messages = entries.filter(
		(entry): entry is ConversationMessageEntry => entry.type === "message" && entry.text.trim().length > 0,
	);
	const finalText = finalMessage?.trim();
	const latestCompletion: ConversationMessageEntry | null =
		finalText &&
		!messages.some(
			(entry) =>
				entry.role === "assistant" && entry.text.replace(/\s+/g, " ").trim() === finalText.replace(/\s+/g, " "),
		)
			? { type: "message", id: "title-final-message", role: "assistant", text: finalText }
			: null;
	if (latestCompletion) {
		messages.push(latestCompletion);
	}
	if (messages.length === 0) return prompt?.trim() ? limitTitleContext(prompt, MAX_TITLE_CONTEXT_LENGTH) : null;

	const remaining = { user: USER_CONTEXT_BUDGET, assistant: ASSISTANT_CONTEXT_BUDGET };
	const counts = { user: 0, assistant: 0 };
	const selected: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const entry = messages[index];
		if (!entry || counts[entry.role] >= MAX_MESSAGES_PER_ROLE) continue;
		const label =
			entry === latestCompletion
				? "Assistant (latest completion):\n"
				: entry.role === "user"
					? "User:\n"
					: "Assistant:\n";
		const available = remaining[entry.role] - label.length - 2;
		if (available < 80) continue;
		const text = limitTitleContext(entry.text, Math.min(available, entry.role === "user" ? 1_000 : 700));
		const part = `${label}${text}`;
		selected.push(part);
		remaining[entry.role] -= part.length + 2;
		counts[entry.role]++;
	}
	const parts = [`Recent conversation (chronological):\n${selected.reverse().join("\n\n")}`];
	if (prompt?.trim()) parts.push(`Original request (background only):\n${limitTitleContext(prompt, 480)}`);
	return parts.join("\n\n");
}
