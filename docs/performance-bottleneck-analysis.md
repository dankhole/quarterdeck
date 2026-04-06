# Performance Bottleneck Analysis: Multiple Concurrent Agents

Investigation into why Kanban slows down as more agents run simultaneously.

## Summary

The slowdown is a combination of real system load from agents and architectural bottlenecks in Kanban that amplify the problem. Git operations and PTY backpressure are well-designed; the main issues are in state broadcasting, persistence locking, and frontend memory accumulation.

| Area | Severity | Key Issue | Scaling Impact |
|------|----------|-----------|----------------|
| State Persistence | **HIGH** | Lock contention on workspace writes | Serialized writes, N agents queue |
| WebSocket Broadcasting | **HIGH** | Global broadcasts + no debounce on checkpoint changes | O(N x clients) per checkpoint |
| Frontend Memory | **MEDIUM** | Unbounded chat message accumulation | Linear growth, never pruned |
| Terminal Output Fanout | **MEDIUM** | Per-viewer sync iteration + shared pause | Stalls all viewers if one is slow |
| Frontend Terminal Cache | **MEDIUM-LOW** | Global terminal map never pruned | Memory growth over session lifetime |
| Git Operations | **LOW** | All async, well-designed | No identified bottleneck |

---

## HIGH: State Persistence Lock Contention

**Files:** `src/state/workspace-state.ts`, `src/server/runtime-state-hub.ts`

When N agents advance checkpoints simultaneously, they all queue on a single workspace lock file. Each checkpoint triggers **3 sequential atomic file writes** (board, sessions, meta):

```typescript
// src/state/workspace-state.ts lines ~674-680
await lockedFileSystem.writeJsonFileAtomic(getWorkspaceBoardPath(...), board);
await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(...), sessions);
await lockedFileSystem.writeJsonFileAtomic(getWorkspaceMetaPath(...), nextMeta);
```

All writes serialize on the same workspace directory lock:

```typescript
getWorkspaceDirectoryLockRequest(workspaceId): LockRequest = {
    lockfilePath: join(getWorkspacesRootPath(), `${workspaceId}.lock`),
}
```

With 10 agents, this creates a convoy effect where agents queue behind each other for disk I/O. There is **no debouncing** on state saves — each checkpoint change triggers an immediate write.

### Recommended fix

Debounce state persistence with a batching window (e.g., 100-200ms). Multiple checkpoint changes within the window collapse into a single write cycle. This mirrors the existing 150ms debounce used for task session summary broadcasts.

---

## HIGH: WebSocket Broadcast Fan-out on Checkpoint Changes

**File:** `src/server/runtime-state-hub.ts`

Each agent checkpoint change triggers a 3-way fan-out:

1. **Full workspace state read from disk** (serializes on lock)
2. **Broadcast to all workspace clients** (state snapshot)
3. **Global broadcast to ALL connected clients** (project update)

```typescript
// runtime-state-hub.ts lines ~103-119 — global broadcast
for (const client of runtimeStateClients) {  // Iterates ALL clients
    sendRuntimeStateMessage(client, payload);
}
```

```typescript
// runtime-state-hub.ts lines ~300-323 — per-checkpoint
const workspaceState = await deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, workspacePath);
for (const client of clients) {
    sendRuntimeStateMessage(client, payload);
}
```

Additionally, `flushTaskSessionSummaries` (called every 150ms batch) triggers `broadcastRuntimeProjectsUpdated(workspaceId)`, which broadcasts globally and rebuilds project summaries from disk.

With 10 agents and multiple browser tabs, checkpoint changes produce ~10 full state reads/serializations per round, each fanning out to every connected client.

### Recommended fixes

1. **Debounce `broadcastRuntimeWorkspaceStateUpdated`** — collapse rapid checkpoint changes into one broadcast (similar to the existing 150ms task session batch).
2. **Scope project broadcasts to workspace-specific clients** instead of iterating all global clients.
3. **Cache workspace state snapshots** with a short TTL to avoid redundant disk reads when multiple agents checkpoint within the same window.

---

## MEDIUM: Frontend Chat Message Accumulation

**File:** `web-ui/src/runtime/use-runtime-state-stream.ts`

`taskChatMessagesByTaskId` accumulates ALL chat messages for ALL tasks without any size limit. Messages are only cleared on project change, not on task disposal:

```typescript
// use-runtime-state-stream.ts line ~220
taskChatMessagesByTaskId: {
    ...state.taskChatMessagesByTaskId,
    [action.payload.taskId]: upsertTaskChatMessage(...)  // Never pruned
}
```

With 10 agents running for hours, this can grow to 100k+ messages in browser memory, causing GC pressure and UI jank.

### Recommended fix

Cap messages per task (e.g., keep last 500) or implement a sliding window. Alternatively, only hold messages for tasks the user is actively viewing, with lazy loading for historical messages.

---

## MEDIUM: Terminal Output Fanout + Shared Pause

**File:** `src/terminal/ws-server.ts`

PTY output iterates all viewers synchronously per chunk:

```typescript
// ws-server.ts lines ~356-365
for (const viewerState of streamState.viewers.values()) {
    if (viewerState.restoreComplete && viewerState.ioState) {
        viewerState.ioState.enqueueOutput(chunk);  // Sync iteration
    }
}
```

If ONE viewer's WebSocket falls behind, the shared PTY pauses for ALL viewers:

```typescript
// ws-server.ts lines ~248-251
if (streamState.backpressuredViewerIds.size === 0) {
    terminalManager.pauseOutput(taskId);  // Pauses ALL viewers
}
```

With 10 tasks x 5 viewers = 50 iterations per output chunk. A single slow client can stall all output.

### Recommended fix

Consider per-viewer independent buffering so a slow viewer doesn't pause the shared PTY stream. The backpressure check could skip pausing if other viewers are keeping up.

---

## MEDIUM-LOW: Frontend Terminal Cache Growth

**File:** `web-ui/src/terminal/persistent-terminal-manager.ts`

The global `terminals` Map caches xterm.Terminal instances and is never pruned:

```typescript
const terminals = new Map<string, PersistentTerminal>();
```

Terminals are only removed on explicit `disposePersistentTerminal()`. If a task is created but the user never opens its terminal, or if many short-lived tasks are created, memory accumulates over the browser session lifetime.

### Recommended fix

Implement an LRU eviction policy for terminal instances (e.g., keep the 20 most recently viewed, dispose the rest). Terminals can be recreated from the PTY restore buffer when needed.

---

## LOW: Git/Worktree Operations

**Files:** `src/workspace/git-utils.ts`, `src/workspace/git-sync.ts`

All git operations use async `execFile` via promisified child_process with a 10MB max buffer. Status probes run `git status --porcelain=v2` and `rev-parse HEAD` in parallel via `Promise.all`. No blocking or synchronous git calls found on hot paths.

No action needed.

---

## Immediate Mitigations (No Code Changes)

These reduce the impact of the bottlenecks without code changes:

- **Fewer browser tabs** — each tab multiplies broadcast and render cost
- **Close detail panels for idle agents** — prevents terminal write queue buildup on hidden terminals
- **Restart Kanban periodically** during long sessions to clear accumulated chat messages and terminal cache

---

## Implementation Priority

1. **Debounce state broadcasts** (highest impact, lowest risk) — add a 100-200ms batching window to `broadcastRuntimeWorkspaceStateUpdated`, similar to the existing task session summary pattern
2. **Debounce state persistence** — batch checkpoint writes within a short window to reduce lock contention
3. **Scope project broadcasts** to workspace clients instead of global
4. **Cap chat message accumulation** per task on the frontend
5. **LRU terminal cache eviction** on the frontend
6. **Per-viewer independent backpressure** for PTY output (higher complexity)
