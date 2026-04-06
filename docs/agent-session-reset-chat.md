# Agent Session Reset / Restart Chat

## Problem

When a Claude agent session starts with `--continue` and fails with "No conversation found to continue," the UI can get stuck showing a dead or errored session. The user has no single-click way to recover.

## Current Recovery Paths

### 1. Auto-restart (handles the loop, but rate-limited)

`session-manager.ts` auto-restarts failed sessions. A fix on `feature/working-directory-iteration-loop` clears `resumeFromTrash` on auto-restart so it doesn't retry `--continue` forever:

```typescript
// src/terminal/session-manager.ts (scheduleAutoRestart)
request.resumeFromTrash = false;
```

Auto-restart is rate-limited to 3 attempts per 5-second window. If all 3 fail, the user is left with a dead session.

### 2. Stop + re-start from the board (multi-step, not obvious)

The user can stop the session and then start it again. This works but requires knowing that's the right thing to do — there's no prompt or button guiding them.

## What Happens When `--continue` Fails

1. `startTaskSession` is called with `resumeFromTrash: true`
2. Agent adapter adds `--continue` flag (`agent-session-adapters.ts`)
3. Claude exits non-zero ("No conversation found")
4. Session state machine transitions to `state: "awaiting_review"`, `reviewReason: "error"`
5. UI shows red "Error" status tag, agent output visible in terminal
6. Auto-restart kicks in (without `--continue`), starts fresh session
7. If auto-restart is rate-limited or also fails, session stays in error state

## Existing UI Affordances

### Restart button (shell terminals only)

`AgentTerminalPanel` accepts an `onRestart` prop (line 50) that renders a restart button (`RotateCw` icon) in the terminal header toolbar. However, this is **only wired up for shell terminals**:

- **Home terminal** (`App.tsx:974`): `onRestart={handleRestartHomeTerminal}` — connected
- **Detail shell terminal** (`App.tsx:1042`): `onRestart` via `onBottomTerminalRestart` — connected
- **Task agent terminal** (`card-detail-view.tsx:861`): `onRestart` is **not passed** — no restart button

This appears intentional — the restart button was designed for shell terminals (simple stop + re-spawn). Agent session restart has different semantics: worktree state, `--continue` flags, prompt handling, turn checkpoints.

### Other controls

- **Stop button**: Stops the process but doesn't restart
- **Clear button**: Clears xterm display only
- **Start from board**: Click to start, but only works for tasks not already running

## Proposed Feature: Manual Session Reset

Add a way for users to manually reset/restart a stuck agent session. Two options:

### Option A: "Restart Session" button on agent terminal

Add an `onRestart` handler for the task agent terminal in `card-detail-view.tsx`. The handler would:

1. Stop the current session (`stopTaskSession`)
2. Start a fresh session (`startTaskSession` with `resumeFromTrash: false`)
3. Use the card's existing `workingDirectory` as the CWD

This reuses the existing `onRestart` prop slot on `AgentTerminalPanel`. The button already renders when the prop is provided.

Considerations:
- Should only be visible/enabled when the session is in an error or exited state (not while running normally)
- Needs to handle the case where `workingDirectory` is null (task never started)
- Should capture a turn checkpoint before restarting if the session had been running

### Option B: "Reset Chat" action on board card context menu

Add a right-click or overflow menu action on the board card. More discoverable for users who aren't in the detail view.

Considerations:
- Would need a new context menu system or expanding the existing card actions
- More visible but more UI work

### Recommendation

Start with Option A — it's lower effort (the prop slot exists), directly addresses the "stuck terminal" UX, and only shows when relevant. Option B can be added later for discoverability.

## Files That Would Change

| File | Change |
|------|--------|
| `web-ui/src/components/card-detail-view.tsx` | Pass `onRestart` to task `AgentTerminalPanel` |
| `web-ui/src/hooks/use-task-sessions.ts` | Add `restartTaskSession` function (stop + fresh start) |
| `web-ui/src/components/detail-panels/agent-terminal-panel.tsx` | Possibly gate restart button visibility on session state |
| `web-ui/src/App.tsx` | Wire up the restart handler |

## Related

- `docs/planned-features.md` #1 (Resume card sessions after crash) — related but different. Resume is about reconnecting after Kanban restarts; this is about recovering from a failed `--continue` during normal operation.
- Auto-restart rate limiting: `session-manager.ts:1070-1088` — 3 restarts per 5-second window.
