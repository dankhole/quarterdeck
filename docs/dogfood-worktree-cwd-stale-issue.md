# Dogfood Worktree Stale CWD Issue

## Symptom

When running `npm run dogfood` from inside a `.cline/worktrees/<id>/kanban` directory, after the dogfood instance exits cleanly (`✔ Cleaning up... done`), the user's shell loses its CWD:

```
✔ Cleaning up... done

worktrees/330dd/kanban took 1m55s
❯ npm run dogfood
Error: ENOENT: no such file or directory, uv_cwd
```

The shell prompt loses branch info (`worktrees/330dd/kanban` instead of `kanban on feat/detail-toolbar`). Running `cd .` restores it, confirming the directory was deleted and recreated underneath the shell.

## Root Cause

The dogfood Kanban instance shares the same `.cline/` state directory as the main Kanban instance. During shutdown, `shutdownRuntimeServer()` in `src/server/shutdown-coordinator.ts` runs cleanup on all managed workspaces:

1. `collectProjectWorktreeTaskIdsForRemoval()` finds all tasks in `in_progress` and `review` columns
2. `persistInterruptedSessions()` moves those tasks to trash
3. `cleanupInterruptedTaskWorktrees()` calls `deleteTaskWorktree()` for each task
4. `deleteTaskWorktree()` in `src/workspace/task-worktree.ts` runs `git worktree remove --force` then `rm -r` on the worktree path

If the main Kanban instance has tasks using worktrees under `.cline/worktrees/`, the dogfood instance sees those same workspaces and trashes their tasks + deletes their worktrees on exit. This includes the very worktree the developer is running dogfood from.

## Why the directory still exists after

The main Kanban instance (still running) likely recreates the worktree when it notices the task state change or the directory is gone, which is why `cd .` works — the path exists again, but it's a new inode, so the shell's old file descriptor is stale.

## Reproduction

1. Have Kanban running with at least one task in `in_progress` or `review` that uses a worktree
2. Open a terminal in that worktree directory
3. Run `npm run dogfood` (without `--skip-shutdown-cleanup`)
4. Press Ctrl+C to exit dogfood
5. The shell CWD is now stale

## Possible Fixes

### Option A: Dogfood always skips shutdown cleanup
The dogfood script already has `--skip-shutdown-cleanup` logic for non-owner instances. It could unconditionally set this flag since dogfood is for UI testing, not for testing shutdown cleanup of real tasks.

### Option B: Isolate dogfood state directory
Use a separate state directory (e.g., `KANBAN_STATE_HOME`) for the dogfood instance so it doesn't share workspace state with the main instance. There's already a `KANBAN_STATE_HOME` env var based on commit `a3d11aa` ("isolate dogfood state via KANBAN_STATE_HOME").

### Option C: Shutdown cleanup checks if worktree is the current process CWD
Before deleting a worktree, check if its path matches the process CWD and skip it. This is fragile and doesn't solve the shared-state problem.

## Key Files

- `scripts/dogfood.mjs` — dogfood launcher, cleanup owner logic
- `src/server/shutdown-coordinator.ts` — shutdown cleanup flow (lines 147-222)
- `src/workspace/task-worktree.ts` — `deleteTaskWorktree()` (lines 558-600), `removeTaskWorktreeInternal()` (lines 402-412)
- `src/server/workspace-registry.ts` — `collectProjectWorktreeTaskIdsForRemoval()` (lines 125-136)

## Debug Steps

To confirm this is the cause, add logging to `deleteTaskWorktree()` to print which worktree paths it deletes during shutdown:

```typescript
console.log(`[shutdown] Deleting worktree: ${worktreePath}`);
```

Run dogfood, Ctrl+C, and check if the worktree you're sitting in appears in the output.
