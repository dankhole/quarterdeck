import { resolve } from "node:path";
import { createTaggedLogger } from "../core/debug-logger";
import { readGitHeadInfo } from "../workspace/git-utils";

const log = createTaggedLogger("worktree-context");

export interface WorktreeContextInput {
	cwd: string;
	workspacePath?: string;
}

/**
 * Build an appended system prompt that orients an agent inside a git worktree.
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

	return [
		"You are working in a git worktree.",
		`- Your working directory is ${cwd}. Shell commands reset to this path between invocations.`,
		`- The main repository is at ${workspacePath}. Other agents may be running in parallel worktrees on the same repo.`,
		"- Do not check out branches, commit, push, or run destructive git operations (reset --hard, clean -fdx, force push) unless explicitly asked.",
		`- Do not modify files outside your worktree unless explicitly asked.${detachedNote}`,
		"- When spawning subagents, include the above worktree context in their prompts.",
	].join("\n");
}
