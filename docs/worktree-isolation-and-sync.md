# Worktree Isolation & Cross-Tool Sync

## Problem: Dogfood state collision

Kanban persists all board state (cards, sessions, workspace metadata) in `~/.cline/kanban/`. The workspace is keyed by the git repo's root path. When running `npm run dogfood` against the same repo that a "real" kanban session is managing, both instances read and write the same state files. This means:

- Dogfood runs see (and can modify) your real in-flight cards
- Concurrent access can trigger `WorkspaceStateConflictError` from revision mismatches
- Testing feature branches pollutes your actual working session

### Solution: `KANBAN_STATE_HOME` env var

`getRuntimeHomePath()` and `getTaskWorktreesHomePath()` in `src/state/workspace-state.ts` now check for a `KANBAN_STATE_HOME` environment variable. If set, it overrides the default `~/.cline/kanban/` root for all state and worktree paths. The dogfood script (`scripts/dogfood.mjs`) automatically sets this to `~/.cline/kanban-dogfood/`, giving dogfood runs fully isolated state without any manual setup.

Branch: `feature/dogfood-state-isolation`

## Problem: Claude Code worktrees are invisible to kanban

Kanban and Claude Code both create git worktrees, but independently:

- **Kanban** creates task worktrees in `~/.cline/worktrees/` and tracks them via sessions, diffs, and the board UI
- **Claude Code** creates worktrees in `<repo>/.claude/worktrees/` via its `EnterWorktree` tool, with no kanban integration

When Claude Code is used as an agent within a kanban-managed project, any worktree it creates is invisible to kanban's UI. File changes, diffs, and session state don't show up in the board. This is confusing when dogfooding (using kanban to develop kanban with Claude Code as the agent).

### Possible approaches

1. **Kanban discovers external worktrees** — On startup or via a manual "link worktree" action, scan known worktree locations (`.claude/worktrees/`, or enumerate via `git worktree list`) and let the user attach an existing worktree to a kanban task. Quickest win, no changes needed on the Claude Code side.

2. **Claude Code delegates to kanban** — If a kanban server is running, Claude Code could call kanban's tRPC API to create worktrees through kanban's task system, getting session/diff tracking for free. Deeper integration but requires coordination between the two tools.

3. **Shared worktree convention** — Both tools agree on a common worktree root and naming scheme so kanban can passively discover worktrees it didn't create. Lower coupling than option 2 but needs a spec both tools implement.

No decision has been made yet. This doc captures the problem and options for future work.
