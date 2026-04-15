# Terminal xterm Pool Strategy

**Date**: 2026-04-14
**Status**: Design documented, not yet implemented

## Problem

Each task terminal creates a full xterm.js instance with WebGL renderer on construction — ~40 DOM elements, 8 canvases, 2 WebGL2 contexts, 5 Canvas 2D contexts, shader compilation, and a 10K-line scrollback buffer. These resources persist for the lifetime of the instance regardless of visibility. Browsers cap WebGL contexts at 8-16 total before silently evicting the oldest, causing context loss and rendering fallback.

The current approach (one `PersistentTerminal` per task, parked when hidden) doesn't scale past ~4-8 concurrent tasks without hitting GPU resource limits. With IO suspend (current branch), agents don't get throttled, but the xterm + WebGL instances still accumulate.

## Key Insight

Nothing about an xterm `Terminal` instance is bound to a specific task or project. The task identity lives in:
1. The WebSocket connections (IO + control sockets encode taskId/workspaceId in the URL)
2. The buffer content (what's been written to the terminal)

Both are replaceable. The Terminal object, DOM elements, WebGL renderer, canvases, and texture atlas are all reusable across tasks **and projects**. A slot doesn't care if it was showing Project A / Task 3 and is now showing Project B / Task 7.

## Design: Fixed Slot Pool

Create exactly **4** xterm + WebGL instances at app boot. Never create more, never destroy them. They live for the lifetime of the browser tab. Tasks are assigned to slots on demand; slots are recycled when needed.

### Slot Roles

```
Slot 0:  ACTIVE    — the task the user is currently looking at
Slot 1:  PREVIOUS  — the task they just left (instant switch-back)
Slot 2:  PRELOAD   — available for mouseover preloading
Slot 3:  PRELOAD   — available for mouseover preloading
```

Roles are fluid — a slot's role changes as the user interacts. The role determines IO behavior, not which xterm instance it is.

### Slot State Machine

Each slot is in one of these states:

| State | IO Socket | Control Socket | Buffer | Visible |
|-------|-----------|----------------|--------|---------|
| **FREE** | None | None | Empty (reset) | No |
| **PRELOADING** | Open | Open | Catching up via restore | No |
| **READY** | Open, streaming | Open | Current | No |
| **ACTIVE** | Open, streaming | Open | Current | Yes |
| **PREVIOUS** | Open, streaming | Open | Current | No |

### State Transitions

**Boot** → all 4 slots are FREE.

**User clicks Task A (no slot assigned):**
1. Pool manager picks a FREE slot (or evicts the oldest PRELOAD slot)
2. Slot connects IO + control sockets to Task A's server session
3. Server sends restore snapshot via control socket
4. Slot transitions: FREE → ACTIVE
5. Slot's host element is made visible in the container

**User clicks Task B (Task A was ACTIVE):**
1. Task A's slot: ACTIVE → PREVIOUS (hide, keep IO streaming)
2. If Task B already has a PRELOADING/READY slot: transition to ACTIVE, show it. Done — instant.
3. If Task B has no slot: pick a FREE or evict oldest PRELOAD, connect, restore → ACTIVE

**User clicks Task A again (slot is PREVIOUS):**
1. Task A's slot: PREVIOUS → ACTIVE (just set visible — buffer is current, no restore)
2. Task B's slot: ACTIVE → PREVIOUS

**Mouseover on Task C (no slot):**
1. Pick a FREE slot (or evict oldest PRELOAD — never evict ACTIVE or PREVIOUS)
2. Connect to Task C, request restore
3. Slot transitions: FREE → PRELOADING → READY (once restore completes)
4. If the user clicks Task C: READY → ACTIVE (instant — buffer is already current)
5. If the user mouses away: after timeout (3s), disconnect → FREE

**Mouseover on Task A or Task B (already has ACTIVE/PREVIOUS slot):**
1. No-op. Don't waste a preload slot on a task that already owns one.

**Project switch:**
1. All slots disconnect their IO + control sockets
2. All slots call `terminal.reset()` to clear buffers
3. All slots return to FREE
4. No xterm or WebGL disposal — the instances survive project switches

### Eviction Priority

When the pool needs a slot and none are FREE:

```
Evict first:  PRELOADING (hasn't even finished restoring)
Evict next:   READY (preloaded but user didn't click)
Never evict:  PREVIOUS (user's last task — high chance of switch-back)
Never evict:  ACTIVE (user is looking at it)
```

If both preload slots are READY, evict the one that was preloaded longer ago.

### IO Strategy

The key change from the current branch: **PREVIOUS slots keep IO open**. This means:
- Switching back to the previous task is truly instant — no restore round-trip, buffer is already current
- Only 3 IO sockets are ever open at once (ACTIVE + PREVIOUS + one PRELOAD), not one per task
- The server-side `pendingOutputChunks` concern goes away entirely — there are no suspended viewers queuing output

FREE slots have no sockets at all. PRELOADING slots have sockets but are still catching up via restore. Everything else streams live.

### Connection Swapping

The core refactoring: `PersistentTerminal` (or its replacement) must support swapping the task it's connected to without disposing the xterm instance.

```
slot.disconnectFromTask()
  → close IO + control sockets
  → terminal.reset()  // clear buffer, cursor, parser state

slot.connectToTask(taskId, workspaceId)
  → open IO + control sockets with new taskId/workspaceId URL params
  → server sends restore snapshot via control socket
  → snapshot applied to the same xterm instance
```

The `clientId` stays the same for a given slot across task swaps — it identifies the browser viewer, not the task. The server creates a new viewer state entry per (connectionKey, clientId) pair.

### What Changes From Current Architecture

| Aspect | Current (PersistentTerminal per task) | Pool |
|--------|---------------------------------------|------|
| xterm instances | One per task ever opened | Fixed 4, forever |
| WebGL contexts | Grows with tasks opened | Fixed 8 (2 per slot) |
| IO sockets open | 1 (active only, others suspended) | 2-3 (active + previous + preload) |
| Project switch | Dispose all (new fix) | Disconnect + reset, keep instances |
| Task switch to recent | Fast path (visibility), restore needed | Instant (buffer already current) |
| Task switch to cold | Slow path (DOM move + repair + restore) | Connect + restore into existing slot |
| Memory ceiling | Unbounded (grows with tasks) | Fixed (~8-10 MB heap, ~200 MB VRAM) |

### Implementation Plan

**Phase 1: TerminalSlot class**
- New class that wraps a `Terminal` + addons + host element
- Constructor creates the xterm, opens it in the parking root, attaches WebGL
- Methods: `connectToTask(taskId, workspaceId)`, `disconnectFromTask()`, `mount(container)`, `unmount()`, `reset()`
- No taskId/workspaceId in constructor — those are runtime bindings

Key files:
- New: `web-ui/src/terminal/terminal-slot.ts`
- Extract from: `web-ui/src/terminal/persistent-terminal-manager.ts` (xterm creation, addon loading, font waiting, WebGL attachment, mount/unmount/visibility, resize, DPR handling)
- Socket management extracted into `connectToTask`/`disconnectFromTask` methods

**Phase 2: TerminalPool manager**
- Replaces `terminal-registry.ts`
- Creates 4 TerminalSlot instances at init
- Tracks: slot → task assignment, slot roles, LRU order
- API: `acquireForTask(taskId, workspaceId)`, `warmup(taskId, workspaceId)`, `cancelWarmup(taskId)`, `releaseAll()`, `getSlotForTask(taskId)`

Key files:
- New: `web-ui/src/terminal/terminal-pool.ts`
- Replace: `web-ui/src/terminal/terminal-registry.ts`
- Update: `web-ui/src/terminal/use-persistent-terminal-session.ts` (call pool instead of registry)

**Phase 3: Wire up consumers**
- `use-persistent-terminal-session.ts`: call `pool.acquireForTask()` instead of `ensurePersistentTerminal()`
- `board-card.tsx` mouseover: call `pool.warmup()` / `pool.cancelWarmup()`
- `use-project-switch-cleanup.ts`: call `pool.releaseAll()` instead of `disposeAllPersistentTerminalsForWorkspace()`
- `App.tsx`: initialize pool on mount (or lazy on first terminal need)

**Phase 4: Delete old code**
- Remove `PersistentTerminal` class (replaced by `TerminalSlot`)
- Remove `terminal-registry.ts` (replaced by `terminal-pool.ts`)
- Remove per-task disposal logic (slots are never disposed)
- Remove IO suspend/resume logic (PREVIOUS keeps IO open, FREE has no sockets)

### Slot Rotation (Proactive WebGL Hygiene)

WebGL texture atlases accumulate stale glyphs, context loss recovery isn't always clean, and long-lived canvas elements can develop rendering artifacts. Instead of waiting for visible glitches, the pool proactively rotates idle slots on a timer.

**Mechanism:**
1. Every 3 minutes, the pool checks for the oldest FREE slot (no task assigned)
2. Create a fresh TerminalSlot (slot 5 — temporarily over the pool size)
3. Dispose the old FREE slot (destroys xterm, WebGL context, DOM elements)
4. The fresh slot takes its place in the pool
5. If no FREE slots exist (all 4 are ACTIVE/PREVIOUS/PRELOADING/READY), skip this cycle

**Why only FREE slots:**
- ACTIVE is visible — can't swap it out
- PREVIOUS has a current buffer the user might switch back to
- PRELOADING/READY are mid-warmup or warm — disposing would waste the preload
- FREE slots are idle with empty buffers — zero cost to replace

**Why this works:**
- The 5th slot exists for ~100ms (create → swap → dispose old). No sustained increase in WebGL contexts.
- Over 15 minutes, all 4 slots get cycled if they pass through FREE at least once
- Slots that stay ACTIVE or PREVIOUS for long stretches don't get rotated — they don't need it since they're actively rendering and the browser keeps their contexts healthy
- The slots most likely to develop issues (idle, hidden, context deprioritized by the browser) are exactly the ones that cycle through FREE

**Cadence:** 3 minutes default. Could be configurable but probably not worth exposing.

### Non-Pool Terminals

The home shell and task-specific dev shells are **not** part of the pool. They're plain shells that don't swap between tasks, so they don't benefit from pooling. Each gets its own dedicated xterm instance, created on demand when the user opens the panel and destroyed when they close it or switch projects/trash the task.

### Scrollback

All pool slots use the same scrollback (10,000 lines). The server-side headless mirror also uses 10,000 — restore snapshots can only contain what the mirror kept. Changing the client-side scrollback wouldn't help since the server is the ceiling. No per-task scrollback inheritance needed.

### Resolved Design Decisions

- **Keyboard navigation**: Being removed — not a concern for pool design.
- **Home terminal / task dev shells**: Dedicated instances outside the pool (see above).
- **Scrollback**: Fixed 10K across all slots, matched to server mirror (see above).
- **WebGL context loss**: Handled by proactive slot rotation (see above) — idle slots are replaced before context loss becomes visible.
