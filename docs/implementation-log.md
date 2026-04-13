# Implementation Log

> Prior entries through 2026-04-12 in `implementation-log-through-2026-04-12.md`.

## 2026-04-13 — Fix branch ahead/behind indicators

**Problem**: The up/down arrow indicators on the `BranchPillTrigger` were always showing 0/0 even when branches were ahead of or behind origin. The UI rendering path was correct — `BranchPillTrigger` already rendered arrows when `aheadCount`/`behindCount` were non-zero, and `App.tsx` already passed `homeGitSummary?.aheadCount` and `homeGitSummary?.behindCount` to it. The issue was that the data was always 0.

**Root causes**:
1. **No upstream tracking**: Quarterdeck creates worktree branches without `--set-upstream-to`, so `git status --porcelain=v2 --branch` omits the `# branch.ab` line entirely, and `probeGitWorkspaceState` left `aheadCount`/`behindCount` at 0.
2. **Stale remote tracking refs**: No periodic `git fetch` was happening, so the local `origin/<branch>` refs were snapshots from the last manual fetch/pull/push. Even branches with upstream tracking had stale behind counts.

**Fix**:
- `src/workspace/git-sync.ts`: Added fallback in `probeGitWorkspaceState()` — when `upstreamBranch` is null and `currentBranch` is not null, computes ahead/behind via `git rev-list --left-right --count HEAD...origin/<branch>`. Reuses existing `parseAheadBehindCounts` for parsing. Silently returns 0/0 when `origin/<branch>` doesn't exist (never-pushed branch).
- `src/server/workspace-metadata-monitor.ts`: Added 60-second periodic `git fetch --all --prune` via `performRemoteFetch()` with `remoteFetchTimer`. Uses `createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" })` to prevent credential hangs. After successful fetch, invalidates `entry.homeGit.stateToken` and calls `refreshHome()` to broadcast updated counts. Also fires a non-blocking initial fetch on `connectWorkspace`. Timer follows existing pattern (setInterval + unref + in-flight boolean guard).
