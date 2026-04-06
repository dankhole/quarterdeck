# Non-Worktree Task Issues

When a task runs with `useWorktree: false`, its cwd is set to the workspace root instead of an isolated worktree. Several code paths assume worktree semantics and break or behave incorrectly in this mode.

## Root cause

The `useWorktree` flag is only checked in `runtime-api.ts` (line 110) when choosing the task cwd. Every other code path — workspace-api, git-sync, shutdown, turn checkpoints — does not consult the flag and always assumes worktree semantics.

## Issues

### 1. File changes silently not reported (CRITICAL)

**File:** `src/trpc/workspace-api.ts` (lines 246-261)

`loadChanges()` calls `resolveTaskCwd()` with `ensure: false`. For non-worktree tasks, the worktree path doesn't exist, so it throws `isMissingTaskWorktreeError` and returns an empty change set. The user never sees file changes for non-worktree tasks.

Same pattern affects:
- `loadGitSummary()` (line 176)
- `discardGitChanges()` (line 225)
- `loadGitLog()` (line 394)
- `loadGitRefs()` (line 413)
- `loadCommitDiff()` (line 426)

### 2. Branch reads incorrectly (HIGH)

**File:** `src/workspace/git-sync.ts` (line 234)

`getGitSyncSummary()` runs `git diff --numstat HEAD --` assuming a detached HEAD state (worktree semantics). When running in the main checkout on an actual branch, the diff/ref logic produces incorrect results.

### 3. Worktree info still attached to card (HIGH)

The card data structure always carries worktree-related fields (`baseRef`, etc.) regardless of `useWorktree`. The workspace-api routes don't check `card.useWorktree` before resolving worktree paths — they always try, causing spurious errors or silent fallbacks.

### 4. Shutdown cleanup attempts on non-existent worktrees (MEDIUM)

**File:** `src/server/workspace-registry.ts` (lines 125-136)

`collectProjectWorktreeTaskIdsForRemoval()` collects ALL task IDs in non-backlog/non-trash columns without checking `card.useWorktree`. `deleteTaskWorktree()` then tries to remove non-existent paths (fails silently with `ok: true, removed: false`).

### 5. Turn checkpoint ref pollution (MEDIUM)

**File:** `src/workspace/turn-checkpoints.ts` (lines 79-80)

`captureTaskTurnCheckpoint()` creates git refs (`refs/kanban/checkpoints/{taskId}/turn/{turn}`) in the shared repository. Multiple non-worktree tasks running concurrently can interfere with each other's checkpoints.

### 6. baseRef field meaningless without worktree (LOW)

The `baseRef` stored on every card is passed to worktree operations but has no effect when `useWorktree: false` — no detached HEAD is created, and the repo stays on whatever branch is checked out.

## Fix direction

All workspace-api and shutdown code paths that operate on task directories need to check `card.useWorktree` (or equivalent) before attempting worktree resolution. For non-worktree tasks, they should operate directly against `workspaceScope.workspacePath` instead.
