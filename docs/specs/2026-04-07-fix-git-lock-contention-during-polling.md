# Fix Git Lock Contention During Metadata Polling — Implementation Specification

**Date**: 2026-04-07
**Adversarial Review Passes**: 1
**Test Spec**: [docs/specs/2026-04-07-fix-git-lock-contention-during-polling-tests.md](./2026-04-07-fix-git-lock-contention-during-polling-tests.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
Agents running inside task worktrees frequently hit git index.lock errors when trying to commit.
The workspace metadata monitor polls `git status` every 1 second on every active task worktree.
`git status` takes index.lock to refresh cached stat info, which collides with the agent's
`git add` / `git commit` operations in the same worktree.
-->

## Goal

Eliminate git `index.lock` contention between the workspace metadata monitor's 1-second polling and agent git operations (add, commit, etc.) running inside task worktrees. The metadata monitor runs read-only git commands (`git status`, `git diff`) that take the index lock for an optional stat cache refresh. This lock collides with agents trying to commit in the same worktree, causing `fatal: Unable to create '...index.lock': File exists` errors.

## Current State

- `src/server/workspace-metadata-monitor.ts:10` — `WORKSPACE_METADATA_POLL_INTERVAL_MS = 1_000` defines a 1-second polling interval.
- `src/server/workspace-metadata-monitor.ts:356-358` — `setInterval` calls `refreshWorkspace` every 1 second for each connected workspace.
- `src/server/workspace-metadata-monitor.ts:236` — For each active task, `probeGitWorkspaceState(pathInfo.path)` runs inside the task's worktree directory.
- `src/workspace/git-sync.ts:115-117` — `probeGitWorkspaceState` runs `git status --porcelain=v2 --branch --untracked-files=all` and `git rev-parse --verify HEAD` in parallel.
- `src/workspace/git-sync.ts:234` — `getGitSyncSummary` runs `git diff --numstat HEAD --` when the state token changes.
- `src/workspace/git-utils.ts:35-43` — `runGit` accepts an `options.env` parameter that overrides `createGitProcessEnv()`.
- `src/core/git-process-env.ts:11-24` — `createGitProcessEnv` strips repository-scoped env vars and accepts an `overrides` parameter that gets spread last.

**The mechanism**: `git status` performs an "index refresh" that updates cached file stat info. This refresh takes `index.lock`. When the monitor's poll fires while an agent holds `index.lock` (or vice versa), one operation fails. With a 1-second poll interval and N+1 worktrees being polled (home + each active task), collisions are frequent.

## Desired End State

- All git commands executed by the metadata polling path use `--no-optional-locks` (git 2.15+), which tells git to skip the index refresh during read-only operations.
- Agent git operations (add, commit, rebase, etc.) are never blocked by the monitor's polling.
- The UI still receives fresh git metadata at the same 1-second cadence — `--no-optional-locks` only skips the optional stat cache update; the status output itself is still accurate.

## Out of Scope

- Changing the poll interval (1 second is fine once the lock contention is removed).
- Adding `--no-optional-locks` to non-polling git commands (user-initiated sync, checkout, discard).
- Addressing the other theoretical git lock scenarios identified in the audit (worktree remove/add races, initialize-repo, pre-commit hook re-adds, turn checkpoint refs). None of these are causing real issues.
- Switching from polling to filesystem watching — that's a separate, larger effort.

## Dependencies

None. `--no-optional-locks` has been available since git 2.15 (released October 2017). No new packages or configuration required.

## New Dependencies & Configuration

None required.

## Architecture & Approach

Git provides `--no-optional-locks` specifically for this scenario — background monitoring processes that need to read git state without interfering with foreground operations. The flag tells git to skip the index lock acquisition for optional operations like stat cache refresh. The status output is still correct; it just won't update the on-disk stat cache.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| How to pass the flag | `--no-optional-locks` git CLI flag prepended to args | Explicit, visible in the code, doesn't affect other git commands | `GIT_OPTIONAL_LOCKS=0` env var via `createGitProcessEnv` overrides | The flag approach is chosen because it's applied at the call site, making it clear which commands are lock-free. The env var approach would require threading options through `probeGitWorkspaceState` and `getGitSyncSummary`. |
| Where to apply | Inside `probeGitWorkspaceState` and `getGitSyncSummary` | These are the only functions called by the polling path. Applying it here means ALL callers of these functions (polling and on-demand) get the flag. This is safe because both functions are purely read-only. | Only in the monitor's `refreshWorkspace` call chain, passing an option bag down | Applying at the function level is simpler and correct — these functions never need the index lock. On-demand callers (tRPC endpoints) also benefit from not contending with agent operations. |

## Implementation Phases

### Phase 1: Add `--no-optional-locks` to Polling Git Commands

#### Overview

Modify `probeGitWorkspaceState` and `getGitSyncSummary` to prepend `--no-optional-locks` to every `runGit` call they make. This is a single-phase change — no sequencing needed.

#### Changes Required

##### 1. `probeGitWorkspaceState` — add `--no-optional-locks` to status and rev-parse

**File**: `src/workspace/git-sync.ts`
**Action**: Modify
**Location**: `probeGitWorkspaceState` at `git-sync.ts:113-200`
**Changes**:
- At line 116, change `["status", "--porcelain=v2", "--branch", "--untracked-files=all"]` to `["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all"]`
- At line 117, change `["rev-parse", "--verify", "HEAD"]` to `["--no-optional-locks", "rev-parse", "--verify", "HEAD"]`

Note: `--no-optional-locks` is a git-level flag (not a subcommand flag), so it must come before the subcommand name.

##### 2. `getGitSyncSummary` — add `--no-optional-locks` to diff

**File**: `src/workspace/git-sync.ts`
**Action**: Modify
**Location**: `getGitSyncSummary` at `git-sync.ts:229-247`
**Changes**:
- At line 234, change `["diff", "--numstat", "HEAD", "--"]` to `["--no-optional-locks", "diff", "--numstat", "HEAD", "--"]`

##### 3. `resolveRepoRoot` — add `--no-optional-locks` to rev-parse

**File**: `src/workspace/git-sync.ts`
**Action**: Modify
**Location**: `resolveRepoRoot` at `git-sync.ts:202-208`
**Changes**:
- At line 203, change `["rev-parse", "--show-toplevel"]` to `["--no-optional-locks", "rev-parse", "--show-toplevel"]`

This is called by `probeGitWorkspaceState` as the first step, so it should also be lock-free.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] All tests pass: `npm run test`
- [ ] Lint + typecheck pass: `npm run check`

##### Behavioral

- [ ] Start the dev server (`npm run dev`) with the web UI connected. In a task worktree, run `for i in $(seq 1 20); do git status && sleep 0.05; done` — no lock errors.
- [ ] Start an agent on a task, let it attempt a commit. The commit should succeed without `index.lock` errors.
- [ ] The UI still shows updated git metadata (changed files, branch, ahead/behind counts) within ~1-2 seconds of making changes in a worktree.

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| Git version < 2.15 (no `--no-optional-locks` support) | Git will reject the unknown flag and exit non-zero. The existing catch blocks in the monitor (`workspace-metadata-monitor.ts:179,262`) return cached values, so polling degrades gracefully. In practice, git < 2.15 is extremely rare (2017). | Not worth testing — theoretical only. |
| `probeGitWorkspaceState` fails for other reasons | Existing `catch` block at `workspace-metadata-monitor.ts:179` and `262` returns cached value. No change needed. | Existing tests cover this path. |

## Rollback Strategy

- **Full rollback**: Revert the commit. The change is purely additive (flag insertion) with no state or configuration changes.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Slightly stale stat cache in git index | Low | Low | The stat cache is a performance optimization for git's own status checks. Quarterdeck rebuilds state from scratch each poll cycle anyway — the cache staleness has zero impact on correctness. |

## Implementation Notes / Gotchas

- `--no-optional-locks` must appear BEFORE the git subcommand (e.g., `git --no-optional-locks status ...`, not `git status --no-optional-locks ...`). This is because it's a "git" flag, not a "status" flag.
- The `runGit` function at `git-utils.ts:37` prepends `["-c", "core.quotepath=false", ...args]`. So the args array `["--no-optional-locks", "status", ...]` becomes `git -c core.quotepath=false --no-optional-locks status ...` which is valid — both `-c` and `--no-optional-locks` are git-level flags and can appear in any order before the subcommand.

## References

- **Git documentation**: `git --no-optional-locks` — "Do not try to update the index or any other files that would require a lock."
- **Related files**: `src/workspace/git-sync.ts:113-247`, `src/server/workspace-metadata-monitor.ts:10,356`
- **Test Spec**: [docs/specs/2026-04-07-fix-git-lock-contention-during-polling-tests.md](./2026-04-07-fix-git-lock-contention-during-polling-tests.md)
