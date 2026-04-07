# Agent Session Reset / Restart Chat

## Problem

When an agent session fails — most commonly when `--continue` fails with "No conversation found" after a restore-from-trash — the UI can get stuck showing a dead or errored session. Auto-restart handles some cases but is rate-limited (3 per 5 seconds). Once exhausted, the user has no single-click way to recover.

## Background: How Restart Currently Works

### Start / restart flow

1. **CWD selection**: Uses persisted `workingDirectory` if it exists on disk, otherwise creates/resolves a worktree (isolated tasks) or uses the workspace root (shared checkout tasks).
2. **Agent spawn**: Spawns agent PTY in the resolved CWD.
3. **`resumeFromTrash`**: When set, the agent adapter adds `--continue` (Claude), `resume --last` (Codex), `--resume latest` (Gemini), or `--continue` (OpenCode) to resume the prior conversation.

### What goes wrong

1. User restores a task from trash → `startTaskSession({ resumeFromTrash: true })`
2. Agent adapter adds `--continue` flag
3. Claude exits non-zero ("No conversation found to continue")
4. Session transitions to error state
5. Auto-restart fires with `resumeFromTrash = false` (starts fresh, no `--continue`)
6. If auto-restart is rate-limited or also fails, session stays dead

### Auto-restart limitations

- Rate-limited to 3 attempts per 5-second window (`session-manager.ts:1077-1095`)
- Strips `resumeFromTrash` to avoid retrying `--continue` (correct behavior)
- If all 3 fail, gives up permanently — no user-facing recovery path

## Existing UI Affordances

### Board card indicators (already present)

- **Failed spinner**: `in_progress` cards with `state === "failed"` show a red `AlertCircle` icon (`board-card.tsx:232-233`)
- **CWD divergence warning**: Shows orange `AlertCircle` with tooltip "Restart the task to fix" — but no actual restart button (`board-card.tsx:355-358`)

### Terminal controls

- **Restart button (shell terminals only)**: `AgentTerminalPanel` accepts `onRestart` but it's only wired for shell terminals. The task agent terminal passes `showSessionToolbar={false}` without `onClose`, so no header renders — passing `onRestart` alone wouldn't surface the button.
- **Stop button**: Stops the process but doesn't restart.

## Proposed: Restart Button on Board Card

Add a contextual restart button directly on the board card, visible when the session is in a recoverable error state. This follows the existing card pattern of column-specific action buttons (Play in backlog, Trash in review, Restore in trash).

### What "restart" means

A fresh start in the existing workspace — **not** a `--continue` resume:

1. Stop the current session if still running
2. Call `startTaskSession` with `resumeFromTrash: false`
3. Use the card's existing `workingDirectory` / worktree as CWD
4. Agent starts a new conversation from scratch in the same workspace context

This is distinct from restore-from-trash (which tries `--continue`) and from auto-restart (which is rate-limited and invisible).

### When to show the button

Show the restart button on `in_progress` cards when:
- `sessionSummary.state === "idle"` (stopped or auto-restart exhausted)
- `sessionSummary.state === "failed"` (session couldn't start)
- `sessionSummary.state === "interrupted"` (agent was interrupted)
- `sessionSummary.state === "awaiting_review"` with `reviewReason === "error"` (non-zero exit)

The button replaces the spinner in the status marker area, or appears alongside the error indicator.

### Shared checkout vs isolated tasks

No difference in restart behavior — both use whatever CWD is already associated with the task. Isolated tasks restart in their worktree, shared checkout tasks restart in the workspace root. No worktree creation or cleanup needed.

### CWD divergence case

The existing CWD divergence warning (`board-card.tsx:355-358`) already tells users to "restart the task to fix." The same restart button handles this — it stops the session and starts fresh in the correct directory.

### Files that would change

| File | Change |
|------|--------|
| `web-ui/src/components/board-card.tsx` | Add restart button for failed/exited in_progress cards |
| `web-ui/src/components/board-column.tsx` or `App.tsx` | Wire `onRestart` callback through to board card |
| `src/trpc/runtime-api.ts` | Possibly add `restartTaskSession` mutation (or reuse stop + start) |

### Why not the terminal panel?

The `AgentTerminalPanel` restart button (Option A in the original proposal) has a rendering gap: the task agent terminal uses `showSessionToolbar={false}` without `onClose`, so neither toolbar variant renders. The button slot exists in the component props but wouldn't actually appear without restructuring the toolbar logic.

The board card approach is better because:
- **More discoverable**: Visible at the board scan level, no need to open detail view
- **Consistent**: Follows the existing card action pattern (Play/Trash/Restore per column)
- **Contextual**: Only appears when the session is in an error state
- **Lower effort**: No toolbar restructuring needed

A terminal-level restart button could be added later as a secondary affordance.

## Related

- `docs/planned-features.md` #1 (Resume card sessions after crash) — related but different. Resume is about reconnecting after Kanban restarts; this is about recovering from a failed agent session during normal operation.
- Auto-restart rate limiting: `session-manager.ts:1077-1095`
