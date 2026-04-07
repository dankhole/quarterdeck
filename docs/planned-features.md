# Planned Features

## 1. Resume card sessions after crash/closure

When Kanban crashes or is closed and reopened, clicking on existing cards no longer works — the Claude Code chat is unresponsive/broken. Need to:
- Investigate why the agent session doesn't reconnect after restart
- Ensure the correct worktree is switched to when resuming a card
- Resume or re-attach to the Claude conversation so the agent can continue where it left off
- Handle gracefully: if the old session can't be resumed, offer to start a fresh session in the same worktree/branch context

## 2. Configurable "move to trash" behavior

When trashing a card, allow customizing whether the associated worktree is automatically deleted:
- Add a setting (per-project or global) to auto-delete the worktree when trashing a card
- Lost work is acceptable — this is a conscious choice for keeping things clean
- **Always** show a warning/confirmation dialog before trashing, regardless of the setting
- The warning should clearly state what will happen (e.g. "This will delete the worktree and any uncommitted changes")

## 3. Branch persistence on cards

Persist the working branch on the card itself so it survives restarts and worktree cleanup. See [docs/worktree-cwd-drift-detection.md](worktree-cwd-drift-detection.md) for full writeup.

## 4. Agent session reset / restart chat

When `--continue` fails ("No conversation found"), users have no single-click recovery. Auto-restart handles the loop but can be rate-limited. See [docs/agent-session-reset-chat.md](agent-session-reset-chat.md) for full writeup.

## 5. Detail toolbar and diff viewer improvements

Continuing work on the left toolbar and diff viewer UX:

- **Diff viewer resize past midway**: The resize handle between the terminal and diff/changes panel currently can't be dragged past the midpoint. Should allow the diff viewer to expand to take up most or all of the horizontal space.
- **Full-screen diff viewer**: Add a way to expand the diff viewer to full screen (e.g. a maximize button or double-click the resize handle) for reviewing large diffs without the terminal competing for space.
- **Middle resize handle is inverted**: The drag direction on the center resize divider is backwards — dragging right shrinks when it should grow, and vice versa. Fix the drag polarity.
- **Interactive base ref switcher**: The diff toolbar now shows the branch comparison (e.g. `feat/my-feature → main`). Make this interactive — clicking the base ref should open a dropdown/popover to select a different branch to diff against, so users can compare their work against any branch, not just the original base ref.

## 6. Direct git commit from review (server-side)

The commit button currently works by injecting a prompt into the agent's terminal, relying on the agent to execute the git commands. Replace the default behavior with a direct server-side git commit:

- **Server-side commit (new default)**: Add a tRPC mutation (e.g. `runtime.commitTaskChanges`) that stages all changes in the task worktree and commits directly using `runGit()`. No active agent session required — faster and more reliable.
- **Commit message generation**: Auto-generate a commit message from the task title/description and diff summary (changed file names, additions/deletions). Optionally support calling an LLM endpoint for smarter messages.
- **Agent prompt injection (alternate)**: Keep the current prompt-injection approach as a secondary option (e.g. "Ask agent to commit") for cases where the user wants the agent to craft the message with full task context.
- **UI**: The card and agent terminal panel commit buttons should default to the direct commit. Add a dropdown or secondary action for the agent-assisted variant.
