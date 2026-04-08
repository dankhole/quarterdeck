# Research: Branch Persistence on Cards

**Date**: 2026-04-07
**Branch**: HEAD (detached)
**Ticket**: #3

## Research Question

How are branches currently tracked, what happens on restart with worktrees, and would persisting branch names on cards cause problems? Specifically: would a persisted branch cause the system to restart into a headless/orphaned worktree?

## Summary

Branch information currently lives exclusively in transient runtime state -- the `RuntimeTaskWorkspaceMetadata.branch` field is populated by polling `git status` on live worktrees and streamed to the UI via WebSocket. It is never persisted to board state. The `runtimeBoardCardSchema` has no `branch` field.

Worktrees are created in **detached HEAD** mode (`git worktree add --detach`), so there is often no named branch at all -- the branch field is `null` for fresh worktrees. A branch only appears if the agent creates one during its work. On shutdown, worktrees for in-progress/review tasks are destroyed after capturing a binary patch (uncommitted changes + HEAD commit hash). On restart, these tasks land in the trash column with no worktree. Resume recreates the worktree at the saved commit and reapplies the patch.

Simply persisting the branch name on the card would **not** enable restart into a worktree, and would not by itself cause harm -- but the description of #3 is misleading about the value it provides. The branch name is informational metadata; the actual restart mechanism is the patch system, keyed by commit hash, not branch name.

## Detailed Findings

### Where Branch Info Lives Today

- **Board card schema** (`src/core/api-contract.ts:117-131`): No `branch` field. Has `baseRef` (the ref the worktree was created from, e.g. `main`).
- **Task workspace metadata** (`src/core/api-contract.ts:308-321`): Has `branch: z.string().nullable()`. This is transient -- populated by polling, never persisted to board state JSON.
- **Metadata monitor** (`src/server/workspace-metadata-monitor.ts:253`): Reads `branch` from `probeGitWorkspaceState()` which runs `git status --porcelain=v2 --branch` against the worktree path (`src/workspace/git-sync.ts:113-139`). Returns `null` for detached HEAD.
- **UI consumption**: Board cards display `reviewWorkspaceSnapshot?.branch` as a shortened label (`web-ui/src/components/board-card.tsx:244-245`), falling back to abbreviated commit hash. Detail view passes it to diff components (`web-ui/src/components/card-detail-view.tsx:432,695,800`).
- **Not used for decisions**: Branch info is purely display. No reconnection, session-creation, or worktree-management logic references it.

### Worktree Creation: Always Detached HEAD

- `ensureTaskWorktreeIfDoesntExist` (`src/workspace/task-worktree.ts:436-562`) runs `git worktree add --detach` at line 516.
- The checkout commit is resolved from `baseRef` via `git rev-parse --verify ${requestedBaseRef}^{commit}` (lines 483-486).
- Worktree path: `~/.quarterdeck/worktrees/{taskId}/{repoFolderName}` (`task-worktree-path.ts:8-31`, `task-worktree.ts:126-129`).
- If a worktree already exists at the path, it is reused as-is with no branch or ref check (lines 447-458): *"Existing worktrees are now treated as authoritative."*

### Shutdown: Worktrees Are Destroyed

- `shutdownRuntimeServer` (`src/server/shutdown-coordinator.ts:147-223`):
  1. Marks running/awaiting_review sessions as `interrupted` (line 163)
  2. Moves those tasks to trash column (lines 56-93)
  3. Calls `deleteTaskWorktree` for each (line 218)
- Before deletion, `captureTaskPatch` saves uncommitted changes + HEAD commit hash as `{taskId}.{commitHash}.patch` (`src/workspace/task-worktree.ts:564-606`).
- After capture, worktree is removed via `git worktree remove --force` + `rm -rf` (lines 408-418).

### Restart: No Automatic Worktree Restoration

- Server startup (`src/server/workspace-registry.ts:237-248`) hydrates session records but sets `active: null` -- no live processes.
- `recoverStaleSession` (`src/terminal/session-manager.ts:742-772`) transitions stale running/awaiting_review sessions to `idle`.
- No worktrees are created, no agents are spawned, no branches are checked out on startup.

### Resume from Trash: Patch-Based, Not Branch-Based

- `startTaskSession` accepts `resumeFromTrash: boolean` (`src/terminal/session-manager.ts:96`).
- On resume, `ensureTaskWorktreeIfDoesntExist` looks for a stored patch via `findTaskPatch` (`src/workspace/task-worktree.ts:160-175`), which recovers the commit hash from the patch filename.
- A new worktree is created at the saved commit, then the patch is applied (lines 535-541).
- Agent adapters append resume flags: `--continue` (Claude/OpenCode), `resume --last` (Codex), `--resume latest` (Gemini) (`src/terminal/agent-session-adapters.ts:496-497, 622-627, 694-695`).
- The branch name is **not part of this mechanism**. The system tracks commit hashes, not branch names.

### What a Persisted Branch Field Would and Wouldn't Do

**Would provide:**
- Display the branch name on cards even when the worktree is gone (e.g., after shutdown, in trash column)
- Enable the UI to show "this task was working on branch `feat/foo`" historically

**Would NOT provide:**
- Restart into that branch -- the worktree is deleted on shutdown, and recreation uses detached HEAD at a specific commit
- Automatic reconnection to an orphaned worktree -- the system does not check for or reconnect to worktrees by branch name

**Would NOT cause harm:**
- A persisted branch name is just a string. The system would not use it to checkout or create worktrees unless explicitly coded to do so. No risk of accidentally restarting into a headless worktree.

## Code References

- `src/core/api-contract.ts:117-131` - Board card schema (no branch field)
- `src/core/api-contract.ts:308-321` - Task workspace metadata schema (transient branch)
- `src/server/workspace-metadata-monitor.ts:253` - Branch populated from git probe
- `src/workspace/git-sync.ts:113-139` - Git status probe, branch detection
- `src/workspace/task-worktree.ts:436-562` - Worktree creation (detached HEAD)
- `src/workspace/task-worktree.ts:160-175` - Patch discovery (commit hash, not branch)
- `src/workspace/task-worktree.ts:564-606` - Worktree deletion with patch capture
- `src/server/shutdown-coordinator.ts:147-223` - Shutdown: trash + delete worktrees
- `src/server/workspace-registry.ts:237-248` - Startup: hydrate sessions, no worktree creation
- `src/terminal/session-manager.ts:742-772` - Stale session recovery
- `web-ui/src/components/board-card.tsx:244-245` - Branch display on cards

## Related

- `docs/planned-features.md` - Feature #3 description
- `docs/research/2026-04-07-interactive-diff-base-ref-switcher.md` - Related research on base ref handling

## Open Questions

1. **Should the feature scope be broader than "persist branch name"?** The real gap is that after shutdown+restart, there's no visible record that a trashed card had work done on a specific branch/commit. The patch file exists but is opaque to the user.
2. **Should "resume" recreate the branch instead of detached HEAD?** Currently resume creates a detached worktree at the patch commit. If the agent had created and pushed a named branch, recreating the worktree on that branch (instead of detached) could enable better git workflow (push, PR creation).
3. **What about tasks that were pushed to a remote branch?** If the agent pushed its work, the branch exists on remote even after worktree cleanup. Persisting the branch name could enable a "reconnect to remote branch" flow that's currently impossible.
4. **Should the patch system also record the branch name?** The patch filename format `{taskId}.{commitHash}.patch` could be extended to include the branch name, giving the resume flow enough information to recreate on a named branch.
