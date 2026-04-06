# Worktree Isolation & Cross-Tool Sync

## Problem: Dogfood state collision

Kanban persists all board state (cards, sessions, workspace metadata) in `~/.cline/kanban/`. The workspace is keyed by the git repo's root path. When running `npm run dogfood` against the same repo that a "real" kanban session is managing, both instances read and write the same state files. This means:

- Dogfood runs see (and can modify) your real in-flight cards
- Concurrent access can trigger `WorkspaceStateConflictError` from revision mismatches
- Testing feature branches pollutes your actual working session

### Solution: `KANBAN_STATE_HOME` env var

`getRuntimeHomePath()` and `getTaskWorktreesHomePath()` in `src/state/workspace-state.ts` now check for a `KANBAN_STATE_HOME` environment variable. If set, it overrides the default `~/.cline/kanban/` root for all state and worktree paths. The dogfood script (`scripts/dogfood.mjs`) automatically sets this to `~/.cline/kanban-dogfood/`, giving dogfood runs fully isolated state without any manual setup.

Branch: `feature/dogfood-state-isolation`

## Note: Cross-worktree diffs work fine

Initially we suspected that Claude Code's `EnterWorktree` (which creates worktrees in `<repo>/.claude/worktrees/`) would be invisible to kanban's diff viewer. This turned out to be wrong.

Kanban's diff is **ref-based, not directory-based**. It runs `git diff` against branch refs/HEAD in the task worktree, and since all git worktrees share the same underlying object database, commits made from any worktree are visible as long as they're on the same branch. So an agent that creates a Claude Code worktree and commits to the task branch still shows up correctly in kanban's changes viewer.
