# Worktree CWD Drift Detection

## Problem

When a task starts with `useWorktree: true`, the agent is spawned in an isolated worktree directory. The session summary's `workspacePath` is set once at session start and never updated. If the agent's process changes its cwd out of the worktree mid-session, the UI has no way to know — the card still looks normal.

## Goal

Flag on the task card when a running agent has left its assigned worktree directory.

## Design

### 1. Process CWD utility — `src/terminal/process-cwd.ts` (new)

Platform-specific utility to read a process's actual cwd by PID:

- **macOS**: `lsof -a -d cwd -Fn -p <pid>`
- **Linux**: `readlink /proc/<pid>/cwd`

Returns `string | null` (null if process is gone or cwd can't be read).

### 2. API contract — `src/core/api-contract.ts`

Add a new field to `runtimeTaskSessionSummarySchema`:

```typescript
outsideWorktree: z.boolean().nullable().default(null)
```

- `null` — not a worktree session, or not yet checked
- `false` — process is still in the worktree
- `true` — process has left the worktree

### 3. Session manager — `src/terminal/session-manager.ts`

When a worktree session starts (detected via existing `isTaskWorktreePath` from `claude-workspace-trust.ts`):

- Store the expected worktree path on the active session state
- Start a poll interval (~5s) that reads the process cwd via the new utility
- Compare the actual cwd against the expected worktree path
- If the cwd is no longer under the worktree, update `outsideWorktree: true` on the summary and emit to listeners
- Clean up the timer on session exit

Follows the existing polling pattern from `workspace-metadata-monitor.ts` (`setInterval` + `timer.unref()`).

### 4. Frontend badge — `web-ui/src/components/board-card.tsx`

When `sessionSummary.outsideWorktree === true`, show a warning badge next to the card title — same visual style as the existing "No WT" badge but with text like "Left WT" and a tooltip explaining the agent has changed its working directory away from the assigned worktree.

## Files touched

| File | Change |
|------|--------|
| `src/terminal/process-cwd.ts` | New — platform-specific process cwd reader |
| `src/core/api-contract.ts` | Add `outsideWorktree` to session summary schema |
| `src/terminal/session-manager.ts` | Poll cwd for worktree sessions, update summary |
| `src/terminal/claude-workspace-trust.ts` | Export `isTaskWorktreePath` |
| `web-ui/src/components/board-card.tsx` | Render "Left WT" badge |

## Branch persistence on cards

### Problem

The current working branch for a task lives only in the workspace metadata monitor — polled from git every 1s, held in memory, never persisted. On restart it's re-probed from the worktree, but if the worktree has been cleaned up, the branch info is lost entirely. The card itself only stores `baseRef` (the target branch like `main`), not which branch the agent was working on.

### Goal

Persist the working branch on the card so it survives restarts and worktree cleanup. This moves toward cards holding more complete task definition.

### Design

**API contract — `src/core/api-contract.ts`**

Add a new field to `runtimeBoardCardSchema`:

```typescript
branch: z.string().nullable().optional()
```

- `null` / undefined — no branch assigned yet (task hasn't started, or non-worktree task)
- `string` — the branch the agent is working on

**Workspace metadata monitor — `src/server/workspace-metadata-monitor.ts`**

When the monitor probes a task's worktree and detects the current branch (via `git symbolic-ref`), write it back to the card if it differs from the stored value. This keeps the card's `branch` field up to date as the agent works.

**State persistence — `src/state/workspace-state.ts`**

The card's `branch` field persists to `board.json` automatically since it's part of the card schema. No extra persistence work needed.

**Frontend — `web-ui/src/components/board-card.tsx`**

On startup (before metadata monitor has re-probed), use `card.branch` as the initial display value. Once live metadata arrives, prefer that. On restart with a cleaned-up worktree, `card.branch` still shows the last known branch.

### Files touched

| File | Change |
|------|--------|
| `src/core/api-contract.ts` | Add `branch` to card schema |
| `src/server/workspace-metadata-monitor.ts` | Write detected branch back to card |
| `web-ui/src/components/board-card.tsx` | Fall back to `card.branch` when metadata unavailable |

## Open questions

1. Does Claude Code change its process-level cwd when using the Bash tool to `cd`, or does it track working directory internally without calling `process.chdir()`? If the latter, polling the OS-level process cwd won't catch the drift. This needs to be validated before or during implementation.

2. Should the card's `branch` field be cleared when a task is moved to trash/done and its worktree is removed, or kept as a historical record?
