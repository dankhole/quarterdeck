// Single source of truth for all runtime configuration default values.
// Both the Node.js runtime and the browser UI import from this file
// (the frontend via the @runtime-config-defaults path alias).
import type { PromptShortcut, RuntimeAgentId } from "../core/api-contract";
import type { AudibleNotificationEvents } from "./runtime-config";

export const DEFAULT_AGENT_ID: RuntimeAgentId = "claude";
export const DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED = false;
export const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
export const DEFAULT_SHELL_AUTO_RESTART_ENABLED = true;
export const DEFAULT_SHOW_SUMMARY_ON_CARDS = false;
export const DEFAULT_AUTO_GENERATE_SUMMARY = false;
export const DEFAULT_SUMMARY_STALE_AFTER_SECONDS = 300;
export const DEFAULT_SHOW_TRASH_WORKTREE_NOTICE = true;
export const DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED = false;
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
export const DEFAULT_FOCUSED_TASK_POLL_MS = 2_000;
export const DEFAULT_BACKGROUND_TASK_POLL_MS = 5_000;
export const DEFAULT_HOME_REPO_POLL_MS = 10_000;
export const DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED = true;
export const DEFAULT_AUDIBLE_NOTIFICATION_VOLUME = 0.7;
export const DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN = true;
export const DEFAULT_AUDIBLE_NOTIFICATION_EVENTS: AudibleNotificationEvents = {
	permission: true,
	review: true,
	failure: true,
	completion: true,
};

export const DEFAULT_PROMPT_SHORTCUTS: readonly PromptShortcut[] = [
	{
		label: "Commit",
		prompt: DEFAULT_COMMIT_PROMPT_TEMPLATE,
	},
];

/** Convenience object for frontend ?? fallback usage. */
export const CONFIG_DEFAULTS = {
	selectedAgentId: DEFAULT_AGENT_ID,
	agentAutonomousModeEnabled: DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
	readyForReviewNotificationsEnabled: DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
	shellAutoRestartEnabled: DEFAULT_SHELL_AUTO_RESTART_ENABLED,
	showSummaryOnCards: DEFAULT_SHOW_SUMMARY_ON_CARDS,
	autoGenerateSummary: DEFAULT_AUTO_GENERATE_SUMMARY,
	summaryStaleAfterSeconds: DEFAULT_SUMMARY_STALE_AFTER_SECONDS,
	showTrashWorktreeNotice: DEFAULT_SHOW_TRASH_WORKTREE_NOTICE,
	unmergedChangesIndicatorEnabled: DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED,
	audibleNotificationsEnabled: DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED,
	audibleNotificationVolume: DEFAULT_AUDIBLE_NOTIFICATION_VOLUME,
	audibleNotificationEvents: { ...DEFAULT_AUDIBLE_NOTIFICATION_EVENTS },
	audibleNotificationsOnlyWhenHidden: DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN,
	focusedTaskPollMs: DEFAULT_FOCUSED_TASK_POLL_MS,
	backgroundTaskPollMs: DEFAULT_BACKGROUND_TASK_POLL_MS,
	homeRepoPollMs: DEFAULT_HOME_REPO_POLL_MS,
};
