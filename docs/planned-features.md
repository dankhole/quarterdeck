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

## 3. Agent CWD mismatch detection

Detect when a running agent's actual working directory has diverged from the card's configured worktree path. Show a warning badge on the card (like the existing "No WT" tag). See [docs/worktree-cwd-drift-detection.md](worktree-cwd-drift-detection.md) for full writeup.

## 4. File browser panel

A read-only file browser panel in the detail toolbar for browsing the active card's worktree. See [docs/file-browser-panel.md](file-browser-panel.md) for full writeup.

## 5. Branch persistence on cards

Persist the working branch on the card itself so it survives restarts and worktree cleanup. See [docs/worktree-cwd-drift-detection.md](worktree-cwd-drift-detection.md) for full writeup.

## 6. Detail toolbar and diff viewer improvements

Continuing work on the left toolbar and diff viewer UX:

- **Diff viewer resize past midway**: The resize handle between the terminal and diff/changes panel currently can't be dragged past the midpoint. Should allow the diff viewer to expand to take up most or all of the horizontal space.
- **Full-screen diff viewer**: Add a way to expand the diff viewer to full screen (e.g. a maximize button or double-click the resize handle) for reviewing large diffs without the terminal competing for space.
- **Middle resize handle is inverted**: The drag direction on the center resize divider is backwards — dragging right shrinks when it should grow, and vice versa. Fix the drag polarity.
- **Show branch comparison label**: Display which two branches are being diffed (e.g. `main..feat/my-feature`) at the top of the diff viewer so it's clear what you're looking at.
