// Commit message generation from git diffs. Uses the same LLM client as
// title and optional summary generation — see llm-client.ts for setup requirements.
// This is a user-triggered path, so it sends a richer context than automatic
// title/summary helpers. LLM failures return null so the UI can surface them.
import { createTaggedLogger } from "../core";
import type { RuntimeCommitMessageFileContext, RuntimeCommitMessageGenerationContext } from "./commit-message-context";
import { callLlm } from "./llm-client";

const log = createTaggedLogger("commit-msg-gen");

const COMMIT_MESSAGE_SYSTEM_PROMPT = `Generate a high-signal git commit message from the provided change context.

Write a subject line in imperative mood, preferably 50-72 characters. Include the main area when it helps.

For non-trivial changes, add a blank line followed by 2-5 concise bullets. The body should explain the important behavior, intent, risk, or user-visible effect. Do not merely list filenames unless the filename itself is the point.

The selected file list is complete and authoritative. The change details may be truncated, so use the file list to understand total scope and the diff/content excerpts for specifics.

CRITICAL RULES:
- Output ONLY the commit message. Nothing else.
- No quotes, no prefix like "Commit message:" or "Here's a commit message:".
- NEVER ask a question, request clarification, or say you need more information.
- NEVER refuse. NEVER say "I can't" or "I'm not sure".
- If details are partial, generate the best accurate message from the available context.
- Your entire response must be the commit message and nothing else.
- Prefer meaningful specifics over generic phrases like "update files" or "misc changes".`;

const DIFF_CHAR_BUDGET = 24_000;
const UNTRACKED_DETAILS_CHAR_BUDGET = 12_000;

function formatFileContext(file: RuntimeCommitMessageFileContext): string {
	const renameSuffix = file.previousPath ? ` (from ${file.previousPath})` : "";
	return `- ${file.status} +${file.additions}/-${file.deletions} ${file.path}${renameSuffix}`;
}

function buildUntrackedFileContentSection(context: RuntimeCommitMessageGenerationContext): string | null {
	const parts = context.untrackedFileContents.map((file) => {
		if (file.omittedReason) {
			return `--- ${file.path}\n[${file.omittedReason} untracked file content omitted]`;
		}
		const truncationNote = file.truncated ? "\n[content excerpt truncated]" : "";
		return `--- ${file.path}\n${file.content}${truncationNote}`;
	});
	if (context.untrackedContentOmittedCount > 0) {
		parts.push(
			`[${context.untrackedContentOmittedCount} additional untracked file content excerpt${
				context.untrackedContentOmittedCount === 1 ? "" : "s"
			} omitted; selected file list above is complete.]`,
		);
	}
	if (parts.length === 0) {
		return null;
	}
	return `Untracked file content excerpts:\n${parts.join("\n\n")}`;
}

function truncateSection(label: string, text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	const omittedCharacters = text.length - maxLength;
	return `${text.slice(0, maxLength).trimEnd()}\n\n[${label} truncated after ${maxLength} characters; ${omittedCharacters} characters omitted.]`;
}

function buildChangeDetails(context: RuntimeCommitMessageGenerationContext): string {
	const sections: string[] = [];
	const diffText = context.diffText.trim();
	if (diffText) {
		sections.push(`Unified diff:\n${truncateSection("Unified diff", diffText, DIFF_CHAR_BUDGET)}`);
	}
	const untrackedContent = buildUntrackedFileContentSection(context);
	if (untrackedContent) {
		sections.push(
			truncateSection("Untracked file content excerpts", untrackedContent, UNTRACKED_DETAILS_CHAR_BUDGET),
		);
	}
	return sections.join("\n\n");
}

function buildTaskContextSection(context: RuntimeCommitMessageGenerationContext): string | null {
	const parts: string[] = [];
	if (context.taskTitle?.trim()) {
		parts.push(`Task title:\n${context.taskTitle.trim()}`);
	}
	if (context.taskContext?.trim()) {
		parts.push(context.taskContext.trim());
	}
	if (parts.length === 0) {
		return null;
	}
	return `Task context:\n${parts.join("\n\n")}`;
}

export function buildCommitMessagePromptContext(context: RuntimeCommitMessageGenerationContext): string | null {
	const taskContext = buildTaskContextSection(context);
	const fileList = context.files.map(formatFileContext).join("\n");
	const details = buildChangeDetails(context);
	if (!taskContext && !fileList && !details.trim()) {
		return null;
	}

	const parts = [
		...(taskContext ? [taskContext, ""] : []),
		`Selected files (${context.files.length}; complete list):`,
		fileList || "- none",
		"",
		"Change details (sections may be truncated independently; selected file list above is complete):",
		details || "(No diff text available. Use the selected file list and stats.)",
	];
	return parts.join("\n");
}

/**
 * Generate a commit message from selected file metadata plus bounded details.
 * Returns null on any failure — never throws.
 */
export async function generateCommitMessage(context: RuntimeCommitMessageGenerationContext): Promise<string | null> {
	const promptContext = buildCommitMessagePromptContext(context);
	if (!promptContext) {
		return null;
	}
	log.debug("Generating commit message", {
		fileCount: context.files.length,
		diffLength: context.diffText.length,
		untrackedContentCount: context.untrackedFileContents.length,
		promptLength: promptContext.length,
		promptSnippet: promptContext.slice(0, 120),
	});
	const result = await callLlm({
		systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
		userPrompt: promptContext,
		maxTokens: 400,
		timeoutMs: 12_000,
	});
	if (!result) {
		log.warn("Commit message generation returned null", {
			fileCount: context.files.length,
			diffLength: context.diffText.length,
			promptLength: promptContext.length,
		});
		return null;
	}
	log.info("Commit message generated", { message: result });
	return result;
}
