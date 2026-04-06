# Non-Worktree Task Issues

> **Status:** Issues 1-3 fixed by the `workingDirectory` model (`feature/working-directory-iteration-loop`).
> Issues 4-6 remain open.

When a task runs with `useWorktree: false`, its cwd is set to the workspace root instead of an isolated worktree. Several code paths assume worktree semantics and break or behave incorrectly in this mode.

## Root cause

The `workingDirectory` model fixes the main code paths (workspace-api routes now use `resolveTaskWorkingDirectory` which reads the persisted path). Remaining issues are in shutdown cleanup and turn checkpoints, which still don't consult the card's working directory.

## Issues

### 1. File changes silently not reported (CRITICAL) — FIXED

**File:** `src/trpc/workspace-api.ts` (lines 246-261)

`loadChanges()` calls `resolveTaskCwd()` with `ensure: false`. For non-worktree tasks, the worktree path doesn't exist, so it throws `isMissingTaskWorktreeError` and returns an empty change set. The user never sees file changes for non-worktree tasks.

Same pattern affects:
- `loadGitSummary()` (line 176)
- `discardGitChanges()` (line 225)
- `loadGitLog()` (line 394)
- `loadGitRefs()` (line 413)
- `loadCommitDiff()` (line 426)

### 2. Branch reads incorrectly (HIGH) — FIXED

**File:** `src/workspace/git-sync.ts` (line 234)

`getGitSyncSummary()` runs `git diff --numstat HEAD --` assuming a detached HEAD state (worktree semantics). When running in the main checkout on an actual branch, the diff/ref logic produces incorrect results.

### 3. Worktree info still attached to card (HIGH) — FIXED

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

Shutdown cleanup (#4) should check `card.workingDirectory` or `card.useWorktree` before attempting worktree deletion. Turn checkpoints (#5) need per-task isolation when running in the shared checkout — possibly by namespacing refs differently or skipping checkpoints for shared-checkout tasks.
