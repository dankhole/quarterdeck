// Default prompt templates for prompt shortcuts and task agents.
// Kept in a dedicated file so multi-line templates don't clutter config-defaults.

export const DEFAULT_COMMIT_PROMPT_TEMPLATE = `When you are finished with the task, commit your working changes.

First, check your current git state: run \`git status\` and \`git branch --show-current\`.

- If you are on a branch, stage and commit your changes directly on that branch. Write a clear, descriptive commit message that summarizes the changes and their purpose.
- If you are on a detached HEAD, create a new branch from the current commit first (e.g. \`git checkout -b <descriptive-branch-name>\`), then stage and commit. Report that a new branch was created.
- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not cherry-pick, rebase, or push to other branches. Just commit to your current branch.

Report:
- Branch name
- Final commit hash
- Final commit message
- Whether a new branch was created (detached HEAD case)`;

export const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `When you are finished with the task, open a pull request against {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current worktree.

Steps:
1. Ensure all intended changes are committed.
2. If currently on detached HEAD, create a branch at the current commit.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
7. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Any follow-up needed`;

export const DEFAULT_SQUASH_MERGE_PROMPT_TEMPLATE =
	"merge in latest main/master and then squash merge our changes onto main/master";

export const DEFAULT_IMPLEMENT_PROMPT_TEMPLATE =
	"Plan out a full implementation. Then kick off implementation of that plan in parallel with subagents. while implantation starts use a sunb agent to review the paln for any misses or gotchas. when done run review agents in parralell and address all findings. Use appropriote models and thinking levels for all agents.";

// Default system prompt template appended to worktree agent sessions via
// --append-system-prompt. Uses mustache-style placeholders that are resolved
// at launch time:
//   {{cwd}}                – the worktree working directory
//   {{project_path}}     – the main repository directory
//   {{detached_head_note}} – conditional note when HEAD is detached (or empty)
export const DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE = `You are working in a git worktree.
- Your working directory is {{cwd}}. Shell commands reset to this path between invocations.
- The main repository is at {{project_path}}. Other agents may be running in parallel worktrees on the same repo.
- Do not check out branches, commit, push, or run destructive git operations (reset --hard, clean -fdx, force push) unless explicitly asked.
- Do not modify files outside your worktree unless explicitly asked.{{detached_head_note}}
- This worktree shares the git object database with the main repo. To read any file from another branch without leaving the worktree, use \`git show <ref>:<path>\` (e.g. \`git show main:AGENTS.md\`, \`git show main:docs/guide.md\`). Prefer this over trying to navigate to the parent repo directory.
- When spawning subagents, include the above worktree context in their prompts.`;
