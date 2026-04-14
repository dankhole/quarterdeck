# Performance Audit: Quarterdeck at Scale

**Date**: 2026-04-14
**Replaces**: Previous analysis dated 2026-04-07
**Scope**: Full runtime + frontend + terminal subsystem + API layer + git operations

## Executive Summary

This is a comprehensive performance audit covering all major subsystems. The previous audit (2026-04-07) identified six bottlenecks. Two shipped fixes (lazy diff loading, scoped metadata refresh), and the terminal backpressure model was redesigned. Three issues remain partially addressed; one (chat message accumulation) is no longer applicable — the feature was removed.

| Area | Previous | Current | Severity |
|------|----------|---------|----------|
| State persistence lock contention | HIGH | LOW | Lock design is sound; `lock: null` optimization added |
| WebSocket broadcast fan-out | HIGH | MEDIUM | Workspace-scoped now, but state broadcasts still not debounced |
| Frontend chat message accumulation | MEDIUM | N/A | Feature removed; replaced by bounded `notificationSessions` |
| Terminal output fanout + shared pause | MEDIUM | RESOLVED | Per-viewer isolation with independent backpressure |
| Frontend terminal cache growth | MEDIUM-LOW | LOW | Proper disposal on task delete and workspace switch |
| Git operations | LOW | LOW | Remains well-designed |
| **New: Metadata polling cost** | — | MEDIUM | 4-5 git commands per task probe, no adaptive backoff |
| **New: File browser polling** | — | LOW | Hardcoded 5s interval, no visibility guard |
| **New: Unbounded file list response** | — | MEDIUM | `getChanges` returns all files without pagination |

---

## 1. State Persistence

**Files**: `src/state/workspace-state.ts`, `src/fs/locked-file-system.ts`

### Current Design

All state mutations serialize on a single workspace directory lock. Each save writes three files sequentially (board, sessions, meta) using `lock: null` to avoid re-acquiring the outer lock:

```
saveWorkspaceState()                          workspace-state.ts:162-200
  └─ lockedFileSystem.withLock(workspaceId)   workspace-state.ts:168
       ├─ writeJsonFileAtomic(board)          workspace-state.ts:188  (lock: null)
       ├─ writeJsonFileAtomic(sessions)       workspace-state.ts:191  (lock: null)
       └─ writeJsonFileAtomic(meta)           workspace-state.ts:194  (lock: null)
```

`mutateWorkspaceState()` (lines 215-259) follows the identical pattern, adding three disk reads (board, sessions, meta) before the mutation + three writes after.

### Assessment: LOW

The `lock: null` optimization means no re-locking cost inside the critical section. The lock itself is per-workspace, so workspaces don't contend with each other. With the single-writer rule (browser UI owns board state, server only writes via CLI code paths), the previous convoy scenario of N agents queuing on the same lock no longer applies during normal UI-connected operation.

**Remaining consideration**: `mutateWorkspaceState` still performs 3 reads + 3 writes under lock. If CLI-only code paths (hooks, task commands) run frequently against the same workspace, there's serialization overhead. This is acceptable for the expected workload.

---

## 2. WebSocket Broadcasting

**File**: `src/server/runtime-state-hub.ts`

### Current Design

Three broadcast tiers exist:

| Broadcast | Scope | Debounce | Trigger |
|-----------|-------|----------|---------|
| `workspace_state_updated` | Workspace clients only | None | State save from UI or server |
| `task_sessions_updated` | Workspace clients | 150ms batch | Agent checkpoint, state change |
| `projects_updated` | All global clients | None | After session flush, after state save |
| `task_notification` | All global clients | None (piggybacks session flush) | Session state changes |
| `workspace_metadata` | Workspace clients | Per-poll comparison-gated | Metadata monitor detects change |

### Assessment: MEDIUM

**What shipped**:
- Workspace-scoped state broadcasts (line 244-267) — no longer fans out to all global clients
- Early-exit when no clients connected (line 246)
- Task session batching with 150ms debounce (line 162-176)
- Comparison-gated metadata broadcasts (only sends when changed)

**What remains**:
1. **State broadcasts are not debounced** — `broadcastRuntimeWorkspaceStateUpdated` rebuilds the full workspace snapshot from disk on every call. If rapid state saves occur (e.g., task renames, drag operations), each triggers a full snapshot read + serialize + broadcast.
2. **Projects broadcast is still global** — `broadcastRuntimeProjectsUpdated` (line 108-124) iterates all connected clients, not just workspace-scoped ones. It fires after every session flush (line 159) and after state saves.
3. **Snapshot is rebuilt from disk every time** — `buildWorkspaceStateSnapshot` (workspace-registry.ts) calls `loadWorkspaceState()` which reads 3 files, with no caching or TTL. Multiple rapid broadcasts read the same files multiple times.

### Recommended fixes

1. **Debounce `broadcastRuntimeWorkspaceStateUpdated`** with a 50-100ms window (same pattern as the existing session batch). Multiple state saves within the window collapse into one snapshot read + broadcast.
2. **Cache the workspace snapshot** with a short TTL (100-200ms) or invalidate-on-write. When multiple broadcasts fire within the window, they share the same snapshot.
3. **Scope project broadcasts** to clients in the affected workspace rather than all global clients. The `projects_updated` message includes the full project list, but most clients only care about their own workspace's task counts.

---

## 3. Frontend Memory

**Files**: `web-ui/src/runtime/use-runtime-state-stream.ts`, `web-ui/src/stores/workspace-metadata-store.ts`

### Previous issue: Chat message accumulation — RESOLVED (N/A)

The `taskChatMessagesByTaskId` structure from the previous audit no longer exists. It was removed entirely.

### Current concern: Notification session accumulation — LOW

`notificationSessions` (use-runtime-state-stream.ts:276-287) grows monotonically — entries are never removed. This is documented as intentional: `useAudibleNotifications` compares against the previous snapshot to detect new events, so pruning would cause duplicate notifications on reconnect.

**Impact**: One entry per task that emits a notification. Each entry is a `RuntimeTaskSessionSummary` (~200-500 bytes). At 500 tasks, this is ~250KB — negligible. Long-running sessions (24h+) with hundreds of tasks should be monitored but aren't a practical concern.

**Mirrored cleanup pattern exists**: `clearInactiveTaskWorkspaceSnapshots()` in workspace-metadata-store.ts (lines 321-343) demonstrates the pruning approach if needed.

### Terminal cache — LOW

Terminal registry (`web-ui/src/terminal/terminal-registry.ts`) has proper disposal:
- `disposePersistentTerminal()` (line 32-40) cleans up individual terminals
- `disposeAllPersistentTerminalsForWorkspace()` (line 42-50) cleans up on workspace switch
- Terminals are disposed when tasks are deleted

No LRU eviction is implemented, but cleanup triggers cover the main lifecycle paths. Each terminal owns an xterm.js instance with viewport buffer + WebGL addon with GPU texture atlas — meaningful memory per instance, but bounded by active task count.

---

## 4. Terminal/PTY Subsystem

**Files**: `src/terminal/ws-server.ts`, `src/terminal/session-manager.ts`, `src/terminal/terminal-protocol-filter.ts`

### Previous issue: Shared backpressure stalling all viewers — RESOLVED

The backpressure model was redesigned with per-viewer isolation:

- Each viewer has independent state: `pendingOutputChunks`, `unacknowledgedOutputBytes`, `outputPaused`, `resumeCheckTimer` (ws-server.ts:231-239)
- Per-WebSocket pause predicates use per-viewer metrics (ws-server.ts:241-247)
- Smart batching: small chunks (<256 bytes) sent immediately if idle for >5ms, otherwise batched with 4ms flush (ws-server.ts:327-342)
- PTY-level pause uses set-based coordination: only pauses when first viewer backpressures, only resumes when last catches up (ws-server.ts:299-301)

### Output fanout — LOW

The fanout loop (ws-server.ts:378-384) iterates viewers synchronously per chunk, but each `enqueueOutput` is a cheap array push. With N viewers per task (typically 1-3), this is negligible.

### Protocol filtering — LOW

`terminal-protocol-filter.ts` uses an efficient byte-by-byte state machine (5 states, no regex) for ANSI sequence filtering on shell sessions. O(n) single pass, handles incomplete sequences correctly.

### Agent adapter parsing — LOW

Regex-based prompt detection in `agent-session-adapters.ts` is conditional — only runs when the state machine predicate is true (session in `awaiting_review` state), not on every output chunk.

---

## 5. tRPC API Layer & Polling

**Files**: `src/trpc/workspace-procedures.ts`, `src/server/workspace-metadata-monitor.ts`, `src/config/global-config-fields.ts`

### Polling architecture

The metadata monitor runs three independent poll loops with in-flight guards:

| Poll | Default interval | Concurrency | Per-tick cost |
|------|-----------------|-------------|---------------|
| Focused task | `focusedTaskPollMs` (2s) | 1 task, own in-flight guard | 4-5 git commands for 1 task |
| Background tasks | `backgroundTaskPollMs` (5s) | pLimit(3), own guard | 4-5 git commands per task, 3 concurrent |
| Home repo | `homeRepoPollMs` (10s) | 1, own guard | git status + stash count + conflict check |
| Remote fetch | 60s (hardcoded) | 1, own guard | `git fetch --all --prune` |

All intervals are user-configurable (min 500ms, max 60s) except remote fetch.

### Assessment: MEDIUM

**Concerns**:

1. **Per-task probe cost**: `loadTaskWorkspaceMetadata()` runs 4-5 git commands per task (rev-parse x2, diff --quiet x2, commits-behind, optional conflict detection). With 20 background tasks and concurrency limit of 3, a full cycle takes ~7 rounds x ~1s = ~7s.

2. **No adaptive backoff**: Polls run at fixed intervals regardless of whether the tab is visible, whether agents are active, or whether previous polls found changes. The metadata comparison gate prevents unnecessary broadcasts, but the git commands still run.

3. **Stash count on every home poll**: `stashCount()` reads all stash entries every 10 seconds. Could be cached and only invalidated on stash mutations.

### Recommended fixes

1. **Pause background polling when tab hidden** — the frontend already has `useDocumentVisibility()` and could send a visibility signal to the server via WebSocket to pause non-essential polls.
2. **Increase git probe concurrency** from 3 to 5-6 for machines with fast SSDs where git operations are I/O-bound.
3. **Make remote fetch interval configurable** — 60s may be too aggressive for large repos or slow networks.

---

## 6. Frontend Polling Patterns

**Files**: `web-ui/src/hooks/use-file-browser-data.ts`, `web-ui/src/components/git-view.tsx`, `web-ui/src/runtime/use-runtime-workspace-changes.ts`

### Git view polling — GOOD

Uses `isDocumentVisible` guard on all three poll triggers (git-view.tsx:337, 357, 393). Polling stops when the tab is hidden. 1-second interval is appropriate for the changes view.

### File browser polling — LOW (fixable)

Hardcoded 5-second interval (use-file-browser-data.ts:7) without `isDocumentVisible` guard. Correctly disables polling in branch-view mode (line 117: `if (browseRef) return`), but runs continuously while the file browser tab is open and the document is hidden.

**Fix**: Add `isDocumentVisible` guard matching the git-view.tsx pattern.

### Workspace changes polling — GOOD

Caller-controlled interval via `pollIntervalMs` parameter. Properly cleans up on unmount.

---

## 7. API Response Sizes

**File**: `src/workspace/get-workspace-changes.ts`, `src/core/api-contract.ts`

### Workspace changes — MEDIUM

`getWorkspaceChanges()` returns all changed files without pagination. Each file includes path, status, additions, and deletions (content is lazy-loaded separately, which was a fix from the previous audit). For monorepos or workspaces with many changes, the file list itself can be large.

**Caching is good**: 128-entry LRU cache keyed by state hash (repo root + HEAD + git status + fingerprints) prevents redundant git operations. Between-ref changes cached by resolved commit hashes (64-entry LRU). File fingerprints use metadata-only stat calls.

**Missing**: No pagination or path-prefix filtering on the file list endpoint. A workspace with thousands of changed files returns them all in one response.

### Workspace state snapshot — LOW

`buildWorkspaceStateSnapshot()` returns the full board + all sessions merged with in-memory terminal state. Size scales with task count, but boards are typically <100 tasks.

---

## 8. Git Operations & Worktree Lifecycle

**Files**: `src/workspace/git-utils.ts`, `src/workspace/git-sync.ts`, `src/workspace/git-probe.ts`, `src/workspace/task-worktree.ts`, `src/workspace/git-history.ts`

### Assessment: LOW (unchanged from previous audit)

**Strengths**:
- All hot-path git operations use async `execFile` with 10MB max buffer (git-utils.ts:6-7)
- Status probes parallelize `git status` + `rev-parse HEAD` via `Promise.all` (git-probe.ts:110-112)
- Uses `--no-optional-locks` to avoid lock contention on concurrent probes
- Lazy diff content loading (shipped since previous audit) — `getChanges` returns metadata only
- Batched numstat in single git command (shipped since previous audit)
- Commit history uses efficient format specifiers with custom separators, not regex (git-history.ts:13, 57)
- Commit diff fetches three git commands in parallel (git-history.ts:410-416)
- Ref/path validation prevents injection (git-utils.ts:157-176)

**Synchronous git calls** exist in `runGitSync()` (git-utils.ts:366-378) but are limited to workspace initialization (detecting git root, branch, default branch) — not on hot paths.

**Worktree lifecycle** is well-designed:
- Idempotent creation with early exit for existing worktrees (task-worktree.ts:441-466)
- Serialized creation via filesystem lock per git common dir (task-worktree.ts:103-112)
- Patch capture on deletion preserves work (task-worktree.ts:194-235)
- Proper cleanup of empty parent directories (task-worktree.ts:422-436)
- No hard limit on concurrent worktrees (bounded by system resources)

**Minor optimization opportunities**:
- Untracked file line counting reads entire files into memory (git-probe.ts:216-254). Cached by mtime with 2,000-entry limit; could increase to 5,000 for large repos.
- `runGitSyncAction` calls `getGitSyncSummary` both before and after pull (git-sync.ts:26, 62). Could reuse the initial probe in some cases.

---

## 9. React Rendering & State Management

**Files**: `web-ui/src/state/board-state.ts`, `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/stores/workspace-metadata-store.ts`

### Assessment: LOW

**Context splitting**: `CardActionsProvider` uses two separate contexts (stable actions vs reactive state) to prevent cascading re-renders (card-actions-context.tsx:79-102). Stable context memoizes 12+ handler references.

**Board state reducer**: Uses immutable update patterns (object spread). Updates are triggered by user actions and periodic polls, not continuous streaming. GC pressure from transient allocations is acceptable.

**Workspace metadata store**: Uses `useSyncExternalStore` correctly with separate subscription paths for task-specific vs global metadata. Proper equality checks before emitting (workspace-metadata-store.ts:116-197).

**Memoization coverage**: 246+ instances of `React.memo`, `useMemo`, or `useCallback` across components. No evidence of missing memoization on expensive paths.

---

## 10. Session Reconciliation

**File**: `src/terminal/session-reconciliation.ts`

### Assessment: LOW

Runs 5 checks per active session per sweep:
1. `checkDeadProcess` — `kill(pid, 0)` syscall (cheap)
2. `checkProcesslessActiveSession` — state consistency check
3. `checkInterruptedNoRestart` — state check
4. `checkStaleHookActivity` — string comparison
5. `checkStalledSession` — timestamp comparison

Cost is O(N) where N = active sessions with PIDs. All checks are local state comparisons or single syscalls. No disk I/O or git operations.

---

## Prioritized Recommendations

### High impact, low risk

1. **Debounce state broadcasts** — Add 50-100ms batching window to `broadcastRuntimeWorkspaceStateUpdated`, mirroring the existing session batch pattern. Collapses rapid state saves (drag operations, renames) into one snapshot read + broadcast.

2. **Cache workspace snapshots** — Add a short TTL (100-200ms) cache on `buildWorkspaceStateSnapshot`. Multiple broadcasts within the window share one disk read.

### Medium impact, low risk

3. **Add visibility guard to file browser polling** — Copy the `isDocumentVisible` pattern from `git-view.tsx` into `use-file-browser-data.ts`. Stops unnecessary 5s polls when tab is hidden.

4. **Scope project broadcasts to workspace clients** — `broadcastRuntimeProjectsUpdated` currently iterates all global clients. When multiple browser tabs are open to different workspaces, most receive irrelevant updates.

5. **Pause metadata polling when UI hidden** — Send a visibility signal from the frontend via WebSocket; pause background task probes and home repo polls when no visible UI consumers exist.

### Lower priority

6. **Increase git probe concurrency** — Raise `GIT_PROBE_CONCURRENCY_LIMIT` from 3 to 5-6. With 20+ background tasks, the current limit creates a 7-second full-cycle latency.

7. **Make remote fetch interval configurable** — Currently hardcoded at 60s. Large repos or slow networks may want longer intervals.

8. **Add pagination to workspace changes** — Currently returns all changed files. Monorepos with thousands of changes send large payloads.

9. **Increase untracked file line count cache** — Raise from 2,000 to 5,000 entries for large repos with many untracked files.

---

## What Shipped Since the Previous Audit (2026-04-07)

1. **Lazy diff content loading** — `getChanges` returns metadata-only file lists. Content loads on-demand via `getFileDiff`. Polling drops from O(3N) git spawns to O(4), payloads from ~400KB to ~2KB.

2. **Scoped metadata refresh** — Git operations use `refreshGitMetadata()` to probe only the affected scope (single task or home), not full workspace rebuilds.

3. **Terminal backpressure redesign** — Per-viewer isolation with independent buffering, pause state, and resume timers. One slow viewer no longer stalls all others.

4. **Lock optimization** — State writes use `lock: null` inside the outer workspace lock to avoid re-acquisition overhead.

5. **Batched numstat** — All per-file `git diff --numstat` combined into a single command.

6. **Deduped post-commit refresh** — Commit+push path refreshes once instead of twice.

7. **Workspace-scoped state broadcasts** — `broadcastRuntimeWorkspaceStateUpdated` only sends to clients connected to the affected workspace, with early-exit when no clients are connected.

8. **Chat message accumulation removed** — The unbounded `taskChatMessagesByTaskId` structure no longer exists.
