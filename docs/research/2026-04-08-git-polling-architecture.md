# Git Polling Architecture

How `workspace-metadata-monitor.ts` polls git state, what it costs, and potential efficiency improvements.

## Current architecture

### Overview

The `WorkspaceMetadataMonitor` (in `src/server/workspace-metadata-monitor.ts`) polls git state for the home repository and every active task worktree on a 1-second interval (`WORKSPACE_METADATA_POLL_INTERVAL_MS = 1_000`). It broadcasts changes to connected browser clients via WebSocket.

### Poll cycle

Each tick of `setInterval` calls `refreshWorkspace()`, which does:

1. **Home repo** — `loadHomeGitMetadata()`:
   - `probeGitWorkspaceState(cwd)` — 2 parallel git child processes + N `stat()` calls
   - If stateToken changed: `getGitSyncSummary(cwd)` — 1 more git process + N `readFile()` calls

2. **All tracked tasks in parallel** (`Promise.all`) — `loadTaskWorkspaceMetadata()` per task:
   - `resolveTaskPath()` — `pathExists()` check (1 `stat()` call)
   - `probeGitWorkspaceState(worktreePath)` — 2 parallel git child processes + N `stat()` calls
   - If stateToken changed: `getGitSyncSummary()` + `git diff --quiet baseRef HEAD` — 2 more git processes + N `readFile()` calls

### Git commands per probe

`probeGitWorkspaceState()` spawns:
- `git --no-optional-locks status --porcelain=v2 --branch --untracked-files=all`
- `git --no-optional-locks rev-parse --verify HEAD`

Then `stat()` on every changed/untracked file to build a fingerprint token.

`getGitSyncSummary()` (only when stateToken changed) spawns:
- `git --no-optional-locks diff --numstat HEAD --`

Then `readFile()` on every untracked file to count line additions.

### Cost at scale

| Concurrent tasks | Git processes per tick (steady state) | Git processes per tick (all changing) |
|-----------------|---------------------------------------|---------------------------------------|
| 1               | 4 (2 home + 2 task)                   | 7 (home: 2+1, task: 2+2)             |
| 5               | 12 (2 home + 10 task)                 | 19 (home: 2+1, tasks: 5×(2+2))       |
| 10              | 22 (2 home + 20 task)                 | 34 (home: 2+1, tasks: 10×(2+2))      |

Plus filesystem `stat()` and `readFile()` calls proportional to the number of changed files across all worktrees.

All task probes run via `Promise.all` with **no concurrency limit** — 10 tasks means 20+ child processes spawned simultaneously.

### Shared `.git` object store

Git worktrees share the parent repo's `.git` directory. All these concurrent git processes hit the same object store. The `--no-optional-locks` flag prevents lock file contention for read operations, but the I/O load on the shared `.git` is real.

### Backpressure behavior

The `refreshPromise` guard (line 303) prevents overlapping refreshes — if the previous tick is still running when the next interval fires, the new tick awaits the in-flight promise instead of starting a second refresh. This prevents unbounded pile-up, but means the effective poll rate degrades under load (a refresh that takes 2s means every other tick is skipped).

### stateToken cache

The `stateToken` (built from repo root, HEAD commit, branch, status output, and file fingerprints) acts as an ETag. If the token matches the previous poll, the expensive `getGitSyncSummary()` and `git diff --quiet` calls are skipped entirely. In steady state (agent idle), this means only the 2 probe commands run per task — the summary is cached.

## Potential improvements

### 1. Concurrency limiter on task probes

**Problem**: `Promise.all` over all tasks spawns unbounded concurrent child processes.

**Fix**: Use a simple concurrency pool (e.g. `p-limit` or a hand-rolled semaphore) to cap concurrent git operations at 3-5. Tasks beyond the limit queue instead of all launching at once.

**Impact**: Reduces peak process count from 20+ to ~10. Increases total poll duration slightly but prevents process table saturation.

### 2. Adaptive poll interval

**Problem**: 1-second fixed interval is aggressive for idle tasks and insufficient context for how long the last poll took.

**Fix**: Track how long each `refreshWorkspace` call takes. If it exceeds a threshold (e.g., 500ms), increase the interval to 2s or 3s. If it consistently completes fast, keep at 1s. Alternatively, per-task adaptive intervals — poll active (running) tasks at 1s but idle (review/backlog) tasks at 5-10s.

**Impact**: Dramatically reduces load when many tasks exist but few are actively changing.

### 3. fs.watch / inotify for stateToken invalidation

**Problem**: Probing git state every second is wasteful when nothing has changed.

**Fix**: Use `fs.watch` on the worktree's `.git/HEAD`, `.git/index`, and key ref files. Only run the full probe when a filesystem event fires. Fall back to polling if `fs.watch` is unavailable or unreliable (some network filesystems).

**Impact**: Near-zero CPU cost for idle worktrees. Requires careful handling of `fs.watch` quirks (duplicate events, missing events on some OS/filesystem combos).

### 4. Batch git operations across worktrees

**Problem**: Each worktree runs its own `git status` and `git rev-parse` independently, even though they share the same `.git` object store.

**Fix**: For operations that resolve refs (like `rev-parse`), batch them into a single process with multiple ref args. For status, there's less opportunity to batch since each worktree has its own index, but the `rev-parse --verify HEAD` calls could potentially be combined.

**Impact**: Modest reduction in process spawning. Most savings come from ref resolution batching.

### 5. Separate home and task poll intervals

**Problem**: The home repo is polled at the same rate as task worktrees, but serves a different purpose (showing the main branch status in the top bar vs. per-task metadata).

**Fix**: Poll home repo at a slower interval (e.g., 3-5s) since it changes less frequently and the information is less time-sensitive.

**Impact**: Saves 2-3 git processes per second with no perceptible UX degradation.

### 6. Skip probes for non-visible tasks

**Problem**: All non-backlog/non-trash tasks are polled, even if the user isn't looking at them.

**Fix**: Only poll the currently selected task at full speed. Other tasks get a slower background rate (5-10s) or are only probed when the user switches to them.

**Impact**: In the common case (user focused on 1-2 tasks), reduces per-tick work from N tasks to 1-2 active + slow background polling.

### 7. Deduplicate `readFile` for untracked line counting

**Problem**: `getGitSyncSummary()` reads every untracked file to count lines (for the `additions` count). In worktrees with many untracked files, this is expensive.

**Fix**: Cache untracked file line counts by path+mtime (the fingerprint data is already available from the probe). Only re-read files whose mtime has changed.

**Impact**: Reduces I/O proportional to churn in untracked files. Most impactful for worktrees with large generated/build directories that aren't gitignored.

## Priority recommendation

For the biggest bang-for-buck improvements with 5-10 concurrent agents:

1. **Concurrency limiter** (improvement #1) — simple, safe, high impact
2. **Slower poll for non-visible tasks** (improvement #6) — biggest absolute savings
3. **Adaptive poll interval** (improvement #2) — self-tuning, prevents degradation under load

The `fs.watch` approach (#3) offers the best theoretical improvement but has the most implementation complexity and platform-specific edge cases.
