# Implementation Log

> Prior entries through 2026-04-12 in `implementation-log-through-2026-04-12.md`.

## Fix: terminal renders at half width after untrashing a task (2026-04-13)

When a task was untrashed (restored from trash to the review column), the terminal rendered at roughly half its container width until the user resized the browser window. The issue was specific to tasks being untrashed but could also occur on any mount where the terminal's initial geometry estimate matched the container's actual dimensions.

**Root cause**: `PersistentTerminal` creates the xterm Terminal and opens it in an offscreen parking root (a 1px × 1px hidden div) during construction. The WebGL addon initializes its canvas at that tiny size. When `mount()` later moves the host element to the real container and calls `fitAddon.fit()`, the FitAddon checks whether the proposed cols/rows differ from the terminal's current values. If they match (because `estimateTaskSessionGeometry` happened to produce the same cols as the real container), `fit()` skips `terminal.resize()` entirely — the WebGL canvas is never told to update to the new container dimensions.

The ResizeObserver on the container should catch subsequent size changes, but if the container was already at its final dimensions when the observer was set up, no change event fires.

**Fix**: Added a deferred `requestAnimationFrame` callback in `mount()` that fires when the host element moves to a new container. The callback:
1. Temporarily resizes the terminal to `cols - 1` — this forces xterm past its same-dimensions guard, triggering the WebGL renderer's `handleResize()` which properly recalculates canvas dimensions
2. Calls `forceResize()` which invalidates the resize epoch and re-runs `fitAddon.fit()`, sizing the canvas correctly for the real container and sending the authoritative dimensions to the server

The temporary `cols - 1` state is never visible (both resizes execute synchronously within the same RAF, before the browser paints) and never reaches the server (server messages are only sent via `requestResize()`, which runs after `fit()` corrects back to the real dimensions).

The RAF handle is cleaned up in `unmount()` and transitively in `dispose()`.

**Files changed**: `web-ui/src/terminal/persistent-terminal-manager.ts`

## 2026-04-13 — Fix branch ahead/behind indicators

**Problem**: The up/down arrow indicators on the `BranchPillTrigger` were always showing 0/0 even when branches were ahead of or behind origin. The UI rendering path was correct — `BranchPillTrigger` already rendered arrows when `aheadCount`/`behindCount` were non-zero, and `App.tsx` already passed `homeGitSummary?.aheadCount` and `homeGitSummary?.behindCount` to it. The issue was that the data was always 0.

**Root causes**:
1. **No upstream tracking**: Quarterdeck creates worktree branches without `--set-upstream-to`, so `git status --porcelain=v2 --branch` omits the `# branch.ab` line entirely, and `probeGitWorkspaceState` left `aheadCount`/`behindCount` at 0.
2. **Stale remote tracking refs**: No periodic `git fetch` was happening, so the local `origin/<branch>` refs were snapshots from the last manual fetch/pull/push. Even branches with upstream tracking had stale behind counts.

**Fix**:
- `src/workspace/git-sync.ts`: Added fallback in `probeGitWorkspaceState()` — when `upstreamBranch` is null and `currentBranch` is not null, computes ahead/behind via `git rev-list --left-right --count HEAD...origin/<branch>`. Reuses existing `parseAheadBehindCounts` for parsing. Silently returns 0/0 when `origin/<branch>` doesn't exist (never-pushed branch).
- `src/server/workspace-metadata-monitor.ts`: Added 60-second periodic `git fetch --all --prune` via `performRemoteFetch()` with `remoteFetchTimer`. Uses `createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" })` to prevent credential hangs. After successful fetch, invalidates `entry.homeGit.stateToken` and calls `refreshHome()` to broadcast updated counts. Also fires a non-blocking initial fetch on `connectWorkspace`. Timer follows existing pattern (setInterval + unref + in-flight boolean guard).
