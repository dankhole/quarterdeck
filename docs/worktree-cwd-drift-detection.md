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

## Open question

Does Claude Code change its process-level cwd when using the Bash tool to `cd`, or does it track working directory internally without calling `process.chdir()`? If the latter, polling the OS-level process cwd won't catch the drift. This needs to be validated before or during implementation.
