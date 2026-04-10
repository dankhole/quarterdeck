# Session Summary Dual-Sourcing

Analysis of the coupling between the terminal layer (in-memory session state) and the state/persistence layer. Written as context for an eventual decoupling or for the Go backend rewrite.

## Current architecture

The terminal layer (`TerminalSessionManager` in `src/terminal/session-manager.ts`) is the single source of truth for live session state. It owns `RuntimeTaskSessionSummary` objects in memory and exposes them via:

- `getSummary(taskId)` — single summary
- `listSummaries()` — all summaries (cloned snapshots)
- `onSummary(listener)` — subscribe to changes
- `hydrateFromRecord(record)` — load persisted sessions into memory on startup

The state layer (`src/state/workspace-state.ts`) handles disk persistence. Session summaries reach disk through the UI's `saveState` RPC, which calls `terminalManager.listSummaries()` to inject current in-memory state before writing.

## Data flow

```
Terminal (source of truth)
  │ emitSummary() — 15+ call sites across session lifecycle
  ▼
RuntimeStateHub (src/server/runtime-state-hub.ts)
  │ onSummary() subscription → batched WebSocket broadcast (150ms)
  ▼
Browser UI
  │ Receives task_sessions_updated via WebSocket
  │ Sends saveState RPC with current board + sessions
  ▼
workspace-api.ts saveState handler
  │ Calls terminalManager.listSummaries() ← READ-BACK
  │ Merges into input.sessions
  ▼
workspace-state.ts saveWorkspaceState()
  │ Writes to disk
```

## The coupling

The problematic back-reference is in `workspace-api.ts:saveState` (line ~513):

```typescript
for (const summary of terminalManager.listSummaries()) {
    input.sessions[summary.taskId] = summary;
}
```

This means the persistence layer reaches back into the terminal layer to get the current state. The terminal layer doesn't know about persistence, but persistence depends on terminal — creating a one-directional but tight coupling.

## Files involved (7)

| File | Role |
|------|------|
| `src/terminal/session-manager.ts` | Owns summaries in memory, emits changes |
| `src/terminal/terminal-session-service.ts` | Interface definitions |
| `src/state/workspace-state.ts` | Disk I/O for sessions |
| `src/trpc/workspace-api.ts` | Reads summaries back via `listSummaries()` |
| `src/trpc/hooks-api.ts` | Mutates summaries via 5+ methods |
| `src/trpc/runtime-api.ts` | Reads/mutates via `getSummary()`, `applyTurnCheckpoint()` |
| `src/server/runtime-state-hub.ts` | Subscribes to `onSummary()`, broadcasts to WebSocket |

Additional bootstrap coupling in `src/server/workspace-registry.ts` which calls `hydrateFromRecord()` and `listSummaries()`.

## Public surface on TerminalSessionManager

These are the methods that external code depends on:

| Method | Callers | Direction |
|--------|---------|-----------|
| `listSummaries()` | workspace-api, workspace-registry, runtime-api | Read-back |
| `getSummary(taskId)` | runtime-api, hooks-api, shutdown-coordinator | Read |
| `onSummary(listener)` | runtime-state-hub | Subscribe |
| `hydrateFromRecord(record)` | workspace-registry | Bootstrap |
| `transitionToReview()` | hooks-api | Mutate |
| `transitionToRunning()` | hooks-api | Mutate |
| `applyHookActivity()` | hooks-api | Mutate |
| `appendConversationSummary()` | hooks-api | Mutate |
| `setDisplaySummary()` | workspace-api, hooks-api | Mutate |
| `applyTurnCheckpoint()` | hooks-api, runtime-api | Mutate |

## Why this exists

The design is intentional: the terminal layer needs to own session state because it's the only layer that knows process lifecycle (spawn, exit, output transitions). The read-back pattern exists because the persistence path goes through the UI (single-writer rule for board state), and the server needs to inject the latest session state before persisting.

## Decoupling options

### Option A: Extract a SessionSummaryStore service

Create a `SessionSummaryStore` that owns the `Map<string, RuntimeTaskSessionSummary>`. Terminal writes to it, persistence reads from it, the subscription mechanism lives on it.

- Terminal calls `store.update(taskId, patch)` instead of managing its own Map
- Persistence reads `store.listAll()` instead of reaching into terminal
- The store exposes `onChange()` for broadcasts

**Effort**: ~2-3 days. Touches session-manager.ts heavily, plus all TRPC callers.

### Option B: Event bus for mutations

hooks-api and runtime-api publish events (`"hook-activity-applied"`, `"turn-checkpoint-applied"`) to a bus. Terminal subscribes and applies mutations internally. Removes the direct method calls from TRPC → terminal.

**Effort**: ~3-5 days. Requires designing the event schema and ensuring ordering guarantees.

### Option C: Design it right in the Go rewrite

The current coupling is well-understood and has clear boundaries. The `TerminalSessionManager` interface is well-defined. In Go, design a `SessionStore` from the start with:
- Process lifecycle events write to it
- Persistence subscribes to change events
- TRPC handlers read from it
- No back-references

**Effort**: Part of the rewrite, not additive.

## Recommendation

Option C unless the TypeScript codebase needs to live much longer. The coupling is annoying but not causing bugs — it's a clean seam that maps directly to a Go interface. Refactoring in TypeScript first would be effort that doesn't transfer to Go.

If the TypeScript codebase needs to be maintained long-term, Option A is the pragmatic choice.
