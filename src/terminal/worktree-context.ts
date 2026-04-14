import { resolve } from "node:path";
import { DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE } from "../config/config-defaults";
import { createTaggedLogger } from "../core/debug-logger";
import { readGitHeadInfo } from "../workspace/git-utils";

const log = createTaggedLogger("worktree-context");

export interface WorktreeContextInput {
	cwd: string;
	workspacePath?: string;
	/** User-editable template. Falls back to the built-in default when omitted. */
	template?: string;
}

/**
 * Render the worktree system prompt from a template.
 *
 * Supported placeholders:
 *   {{cwd}}                – the worktree working directory
 *   {{workspace_path}}     – the main repository directory
 *   {{detached_head_note}} – conditional note when HEAD is detached (or empty)
 *
 * Returns an empty string when the agent is running directly in the main repo
 * (i.e. not in a worktree), so callers can skip injection with a simple truthy check.
 */
export async function buildWorktreeContextPrompt(input: WorktreeContextInput): Promise<string> {
	const { cwd, workspacePath } = input;
	if (!workspacePath || resolve(cwd) === resolve(workspacePath)) {
		return "";
	}

	let detachedNote = "";
	try {
		const head = await readGitHeadInfo(cwd);
		if (head.isDetached) {
			detachedNote = "\n- This worktree starts in detached HEAD state. It may move to a feature branch if directed.";
		}
	} catch (error) {
		log.debug("failed to read git HEAD info for worktree context", { cwd, error });
	}

	const template = input.template ?? DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE;

	return template
		.replace(/\{\{cwd\}\}/g, cwd)
		.replace(/\{\{workspace_path\}\}/g, workspacePath)
		.replace(/\{\{detached_head_note\}\}/g, detachedNote);
}
