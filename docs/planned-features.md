# Planned Features

## 1. Larger & resizable new task dialog

The "new task" dialog should be bigger by default and resizable. Constraints:
- Must stay centered in the viewport
- Must remain smaller than the main window (not full-screen takeover)
- Resize should be clamped so it can't collapse to unusable or overflow the screen

## 2. Larger settings dialog

The settings pop-out dialog needs to be bigger by default (same general approach as #1).

## 3. Fix default commit instruction to target correct branch

The default commit instruction currently always targets main. It should target the branch the worktree was created from (the actual baseRef), not hardcoded main.

## 4. Better visibility into what cards are working on

Need a way to make it more clear at a glance what each card is actively doing — current state is too opaque.

## 5. JetBrains/Rider-style left toolbar

Rework the left side panel into a JetBrains/Rider-style tool strip:
- **Single parent toolbar on the left** with switchable panels:
  - File management
  - File change management (working changes)
  - Card tracking previews
- Each panel can be toggled open/closed from the toolbar icons
- The toolbar itself can be minimized to a thin icon strip (not taking up much space)
- **Card previews within the panel** should be individually resizable (bigger or smaller, still as previews)
- Right panel (working changes) should also be collapsible when in terminal view
- Inspiration: JetBrains Rider toolbar, also Firefox sidebar tabs for the resize feel
- Specs/mockups to be added later for clarity

## 6. Configurable worktree & branch strategy when creating a card

When creating a new card, make it easy to configure two independent options:
- **Worktree**: whether the card gets its own isolated worktree or works in the existing checkout
- **Branch**: whether to create a new feature branch or stay on the current branch

Possible combinations:
- New worktree + new feature branch (default for independent features)
- New worktree + current branch (isolated workspace, same branch)
- No worktree + current branch (lightweight, in-place work)
- No worktree + new feature branch (branch without isolation)

These should be easily configurable:
- Prominent in the new task dialog (not buried in settings)
- Sensible defaults that can be changed per-project or globally
- Clear labeling so users understand the tradeoffs (isolation vs. speed, branch hygiene vs. simplicity)

## 7. Resume card sessions after crash/closure

When Kanban crashes or is closed and reopened, clicking on existing cards no longer works — the Claude Code chat is unresponsive/broken. Need to:
- Investigate why the agent session doesn't reconnect after restart
- Ensure the correct worktree is switched to when resuming a card
- Resume or re-attach to the Claude conversation so the agent can continue where it left off
- Handle gracefully: if the old session can't be resumed, offer to start a fresh session in the same worktree/branch context

## 8. Configurable "move to trash" behavior

When trashing a card, allow customizing whether the associated worktree is automatically deleted:
- Add a setting (per-project or global) to auto-delete the worktree when trashing a card
- Lost work is acceptable — this is a conscious choice for keeping things clean
- **Always** show a warning/confirmation dialog before trashing, regardless of the setting
- The warning should clearly state what will happen (e.g. "This will delete the worktree and any uncommitted changes")

## 9. Interrupted agents get stuck looping in "in progress"

When a user interrupts an agent (e.g. Ctrl+C on Claude), the agent doesn't always report its new state back to Kanban. The card stays stuck in "in progress" and the UI loops waiting for a transition that never comes. Need to:
- Detect when an agent process has been interrupted but the state machine didn't receive the transition event
- Add a timeout or heartbeat mechanism so stale "in progress" cards are recovered automatically
- Ensure the interrupt signal propagates correctly through the PTY → state machine → UI pipeline

## 10. Sub-agent permission requests not surfaced to user

When an agent spawns a sub-agent that needs user permissions (e.g. tool approvals), the permission prompt may not be surfaced to the Kanban UI. The sub-agent blocks waiting for input the user never sees. Need to:
- Ensure permission requests from sub-agents bubble up to the Kanban review flow
- Surface a clear prompt in the UI so the user can approve/deny without switching to a raw terminal
