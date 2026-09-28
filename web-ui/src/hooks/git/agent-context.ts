import { TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import type { SourceEditorActionContext } from "@/components/editor/source-editor-context";
import type { UnifiedDiffRow } from "@/components/shared/diff-parser";

export interface AgentPromptContext {
	readonly kind: "selection" | "file" | "diff hunk";
	readonly path: string;
	readonly location: string;
	readonly content: string;
	readonly source?: string;
}

export interface AgentContextPrompt {
	readonly text: string;
	readonly error: string | null;
}

export function captureEditorAgentContext(
	context: SourceEditorActionContext,
	kind: "selection" | "file",
): AgentPromptContext | null {
	if (kind === "selection" && context.selection.from === context.selection.to) return null;
	const { start, end } = context.selection.range;
	return {
		kind,
		path: context.path,
		location:
			kind === "selection"
				? `Editor buffer ${start.line + 1}:${start.character + 1}–${end.line + 1}:${end.character + 1} (end exclusive; may include unsaved changes)`
				: "Full editor buffer (may include unsaved changes)",
		content: kind === "selection" ? context.selection.text : context.content,
	};
}

export function captureDiffAgentContext(path: string, rows: readonly UnifiedDiffRow[]): AgentPromptContext | null {
	const firstRemoved = rows.find((row) => row.variant === "removed");
	const firstAdded = rows.find((row) => row.variant === "added");
	if (!firstRemoved && !firstAdded) return null;
	return {
		kind: "diff hunk",
		path,
		location: [
			firstRemoved?.lineNumber != null ? `Old line ${firstRemoved.lineNumber}` : null,
			firstAdded?.lineNumber != null ? `new line ${firstAdded.lineNumber}` : null,
		]
			.filter(Boolean)
			.join("; "),
		content: rows
			.map((row) => `${row.variant === "added" ? "+" : row.variant === "removed" ? "-" : " "}${row.text}`)
			.join("\n"),
	};
}

export function buildAgentContextPrompt(
	context: AgentPromptContext,
	instruction: string,
	source: string,
): AgentContextPrompt {
	const text = [
		`Request: ${instruction}`,
		`Context: ${context.kind}`,
		`File: ${JSON.stringify(context.path)}`,
		`Source: ${source}`,
		context.location,
		"--- Begin captured context ---",
		context.content,
		"--- End captured context ---",
	].join("\n");
	return {
		text,
		error: !instruction.trim()
			? "Add an instruction for the agent."
			: text.length > TASK_QUICK_REPLY_MAX_LENGTH
				? `Prompt exceeds ${TASK_QUICK_REPLY_MAX_LENGTH.toLocaleString()} characters. Select a smaller range or shorten the instruction.`
				: null,
	};
}
