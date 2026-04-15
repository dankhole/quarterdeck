# Terminal xterm Pool — Implementation Specification

**Date**: 2026-04-14
**Branch**: feat/terminal-visibility-toggle-io-suspend
**Adversarial Review Passes**: 1
**Test Spec**: `docs/forge/2026-04-14-terminal-xterm-pool/test-spec.md`
**Design Reference**: `docs/terminal-xterm-pool-strategy.md`

## Goal

Replace the per-task `PersistentTerminal` architecture with a fixed pool of 4 xterm+WebGL slots that swap between tasks via socket reconnection and server-side restore snapshots. This caps GPU resources at 4 pool slots regardless of how many tasks are opened, eliminating WebGL context exhaustion. Home/dev shell terminals use dedicated slots outside the pool.

## Behavioral Change Statement

> **BEFORE**: Each task opened creates its own `PersistentTerminal` (xterm + WebGL + DOM elements + IO/control sockets). Instances accumulate — 8 tasks = 8 WebGL contexts. Only the active task's IO socket is open; others are suspended. Project switch disposes all instances.
>
> **AFTER**: 4 fixed `TerminalSlot` instances exist for the browser tab's lifetime. Proactive rotation disposes before creating, maintaining the cap. Slots connect/disconnect from tasks on demand via socket swapping. PREVIOUS slot keeps IO open for instant switch-back. Mouseover preloads into FREE slots. Project switch disconnects all slots to FREE without disposing xterm instances. Home shell and dev shells use dedicated TerminalSlot instances outside the pool (created/disposed per panel lifecycle).
>
> **SCOPE — all code paths affected**:
> 1. Task click (first time) → `use-persistent-terminal-session` effect → registry `ensurePersistentTerminal` → creates PersistentTerminal → `persistent-terminal-manager.ts:149-212`
> 2. Task switch → `use-persistent-terminal-session` effect cleanup → `terminal.unmount()` (suspends IO) → new task effect → `ensurePersistentTerminal` (reuses or creates)
> 3. Mouseover warmup → `App.tsx:236-247` → `warmupPersistentTerminal` → `terminal-registry.ts:33-36` → `PersistentTerminal.warmup()` → `persistent-terminal-manager.ts:533-552`
> 4. Mouseover cancel → `App.tsx:242-247` → `cancelWarmupPersistentTerminal` → `terminal-registry.ts:38-42` → `PersistentTerminal.cancelWarmup()` → `persistent-terminal-manager.ts:554-564`
> 5. Project switch → `use-project-switch-cleanup.ts:39` → `disposeAllPersistentTerminalsForWorkspace` → disposes all xterm instances
> 6. Settings: renderer reset → `display-sections.tsx:283` → `resetAllTerminalRenderers` → iterates registry
> 7. Settings: restore all → `display-sections.tsx:301` → `restoreAllTerminals` → iterates registry
> 8. Debug panel → `debug-log-panel.tsx:194` → `dumpTerminalDebugInfo` → iterates registry
> 9. Config sync → `use-terminal-config-sync.ts` → `setTerminalFontWeight` / `setTerminalWebGLRenderer` → iterates registry
> 10. Shell terminal helpers → `use-terminal-panels.ts:23` → `writeToTerminalBuffer` / `isTerminalSessionRunning` → registry lookup

## Hard Behavioral Constraints

### !1 — Fixed pool size

Exactly 4 `TerminalSlot` instances exist at any time. Proactive rotation disposes the old slot before creating the replacement, maintaining the 4-slot cap. No code path may create additional pool slots. (Dedicated terminals for home/dev shells exist outside this cap.)

### !2 — Home shell and dev shells excluded

Home shell terminal (`HOME_TERMINAL_TASK_ID`) and task-specific dev shells (`DETAIL_TERMINAL_TASK_PREFIX`) are NOT part of the pool. They keep their own dedicated xterm instances managed via `ensureDedicatedTerminal` / `disposeDedicatedTerminal` in `terminal-pool.ts` (a small side map that preserves the old `PersistentTerminal`-style create-or-reuse behavior). The pool only manages agent task terminals.

### !3 — PREVIOUS keeps IO open

The PREVIOUS slot (the task the user just left) keeps both IO and control sockets open. Its buffer stays current with live output. Switching back to it is instant — no restore round-trip.

### !4 — Eviction priority

When the pool needs a slot and none are FREE: evict PRELOADING first, then READY. NEVER evict ACTIVE or PREVIOUS.

### !5 — clientId stays per-slot

Each slot generates a `clientId` once at construction. The clientId identifies the browser viewer (the slot), not the task. It remains the same across task swaps.

### !6 — No server changes

The server's `ws-server.ts` is not modified. The existing per-(connectionKey, clientId) viewer state model handles reconnection automatically.

### !7 — Mouseover warmup no-op for assigned tasks

`pool.warmup(taskId)` must be a no-op when the task already owns the ACTIVE or PREVIOUS slot. Don't waste a preload slot on a task that's already warm.

### !8 — Scrollback fixed at 10K

All pool slots use 10,000-line scrollback, matching the server-side headless mirror. The `scrollback` prop in `usePersistentTerminalSession` is ignored for pool terminals but still passed through to `ensureDedicatedTerminal` for home/dev shells.

## Functional Verification

| # | What to do | Expected result | Code path verified |
|---|-----------|----------------|-------------------|
| 1 | Open 5 tasks in sequence (click each) | Only 4 xterm instances exist. First task's slot was evicted when 5th was opened. No WebGL errors in console. | Path 1, 2 |
| 2 | Click task A, then task B, then task A again | Switching back to A is instant — no restore flash/blank. A's buffer shows live output that accumulated while B was active. | Path 2, !3 |
| 3 | Hover over a task card (not currently ACTIVE or PREVIOUS) | After ~100ms, a FREE slot connects to that task (visible in network tab as new IO+control WebSocket). | Path 3 |
| 4 | Hover over a task card then move mouse away within 3s | The preloaded slot disconnects and returns to FREE. | Path 4 |
| 5 | Hover over a task card, then click it | Terminal renders instantly — buffer already populated from preload. | Path 3 → Path 1 |
| 6 | Hover over the ACTIVE task's card | No new WebSocket connections. No slot state changes. | !7 |
| 7 | Switch projects | All slots disconnect (WebSockets close), buffers cleared. No xterm disposal — slot count stays at 4. Re-selecting a task in new project connects a slot. | Path 5 |
| 8 | Open/close home shell terminal | Home shell creates/destroys its own xterm. Pool slot count unchanged. | !2 |
| 9 | Open/close task dev shell | Dev shell creates/destroys its own xterm. Pool slot count unchanged. | !2 |
| 10 | Settings > Reset terminal rendering | All 4 pool slots get renderer reset (WebGL reattach + canvas repair). | Path 6 |
| 11 | Settings > Restore all terminals | All connected pool slots (non-FREE) request a fresh restore snapshot. | Path 7 |
| 12 | Wait 3+ minutes with FREE slots idle | Oldest FREE slot is disposed, then replaced with a fresh instance (dispose before create — no temporary 5th slot). Non-FREE slots are untouched. | Rotation |
| 13 | `npm run check && npm run build` | Passes with no errors. | All |

## Current State

- `web-ui/src/terminal/persistent-terminal-manager.ts` — 1123-line `PersistentTerminal` class. One instance per task. Constructor takes `taskId` + `workspaceId`. Owns xterm, addons, WebGL, host element, IO/control sockets. Mount/unmount toggles visibility + suspends/resumes IO.
- `web-ui/src/terminal/terminal-registry.ts` — 150-line module. `Map<string, PersistentTerminal>` keyed by `workspaceId:taskId`. Factory function `ensurePersistentTerminal` creates-or-reuses. Utility functions iterate the map for bulk operations.
- `web-ui/src/terminal/use-persistent-terminal-session.ts` — 199-line React hook. Calls `ensurePersistentTerminal` on effect mount, subscribes to callbacks, calls `terminal.mount()`, cleanup calls `terminal.unmount()`.
- `web-ui/src/App.tsx:236-247` — Warmup handlers call registry's `warmupPersistentTerminal` / `cancelWarmupPersistentTerminal`.
- `web-ui/src/hooks/use-project-switch-cleanup.ts:39` — Calls `disposeAllPersistentTerminalsForWorkspace` on project change.
- `web-ui/src/hooks/use-terminal-config-sync.ts` — Syncs font weight / WebGL toggle to registry.
- `web-ui/src/components/settings/display-sections.tsx` — Buttons for `resetAllTerminalRenderers` / `restoreAllTerminals`.
- `web-ui/src/components/debug-log-panel.tsx` — Button for `dumpTerminalDebugInfo`.
- `web-ui/src/hooks/use-terminal-panels.ts` — Uses `writeToTerminalBuffer` / `isTerminalSessionRunning` for shell terminals.

## Desired End State

- `TerminalSlot` class replaces `PersistentTerminal`. Task-agnostic — created without taskId/workspaceId. Supports `connectToTask(taskId, workspaceId)` and `disconnectFromTask()` for socket swapping.
- `TerminalPool` singleton replaces `terminal-registry.ts`. Creates 4 slots at init. Tracks slot roles (FREE/PRELOADING/READY/ACTIVE/PREVIOUS). Exposes `acquireForTask`, `warmup`, `cancelWarmup`, `releaseTask`, `releaseAll`, `getSlotForTask`. Implements 3-minute proactive rotation of FREE slots. Also manages a side map of dedicated terminals for home/dev shells via `ensureDedicatedTerminal` / `disposeDedicatedTerminal`. Bulk utility functions (resetAllRenderers, restoreAll, etc.) iterate both pool slots and dedicated terminals.
- All consumers import from `terminal-pool.ts` instead of `terminal-registry.ts`.
- `PersistentTerminal` class and `terminal-registry.ts` are deleted. Home/dev shell terminals use `TerminalSlot` instances via the dedicated terminal side map (same class, different lifecycle management).
- IO suspend/resume logic is deleted (PREVIOUS keeps IO open; FREE has no sockets). Dedicated terminals keep IO open while alive and are fully disposed when their panel is closed — they don't need IO suspend/resume either.

## Out of Scope

- Server-side changes to `ws-server.ts`
- Home shell terminal or task dev shell behavioral changes (they move to dedicated terminal side map but behavior is preserved)
- Scrollback configuration (fixed 10K)
- Keyboard navigation (being removed separately)
- Pool size configuration (hardcoded 4)

## New Dependencies & Configuration

None. All dependencies (xterm, addons, WebSocket) are already in the project.

## Architecture & Approach

Extract `TerminalSlot` from `PersistentTerminal`, making the xterm lifecycle independent of task identity. The pool manages slot-to-task assignments and role transitions. The server already handles new socket connections per (connectionKey, clientId) pair, so `connectToTask` just opens new sockets with the new taskId URL params.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered |
|----------|--------|-----------|----------------------|
| Pool vs lazy creation | Fixed 4 slots at boot | Predictable resource ceiling, simpler state machine | Lazy (create on demand up to cap) — more state to track for no benefit |
| PREVIOUS keeps IO open | Yes | Instant switch-back, no restore round-trip | Suspend IO like current code — adds latency to the most common interaction |
| Singleton module vs React context | Singleton module (like current registry) | Terminal instances are DOM-bound resources, not React state. Matches existing pattern. | React context — would force re-renders and complicate lifecycle |
| Subscriber model | Slot owns subscribers, clears on disconnect | Subscribers are per-mount, re-registered each time the hook effect runs | Keep subscribers across task swaps — would leak callbacks from previous task |

## Interface Contracts

### TerminalSlot (new class)

```typescript
class TerminalSlot {
   readonly slotId: number;
   readonly clientId: string;

   // Connection
   connectToTask(taskId: string, workspaceId: string): void;
   disconnectFromTask(): Promise<void>;
   get connectedTaskId(): string | null;
   get connectedWorkspaceId(): string | null;

   // Lifecycle (carried from PersistentTerminal)
   mount(container: HTMLDivElement, appearance: PersistentTerminalAppearance, options: MountOptions): void;
   unmount(container: HTMLDivElement | null): void;
   dispose(): void;

   // Terminal operations
   subscribe(subscriber: TerminalSlotSubscriber): () => void;
   onceConnectionReady(callback: () => void): void;
   focus(): void;
   input(text: string): boolean;
   paste(text: string): boolean;
   clear(): void;
   reset(): void;
   writeText(text: string): void;
   readBufferLines(): string[];
   requestRestore(): void;
   stop(): Promise<void>;
   waitForLikelyPrompt(timeoutMs: number): Promise<boolean>;

   // Appearance
   setAppearance(appearance: PersistentTerminalAppearance): void;
   setFontWeight(weight: number): void;
   setWebGLRenderer(enabled: boolean): void;
   resetRenderer(): void;
   getBufferDebugInfo(): BufferDebugInfo;
   get sessionState(): string | null;
}
```

### TerminalPool (new module)

```typescript
type SlotRole = "FREE" | "PRELOADING" | "READY" | "ACTIVE" | "PREVIOUS";

// Singleton API — module-level functions like terminal-registry.ts
function initPool(): void;
function acquireForTask(taskId: string, workspaceId: string): TerminalSlot;
function warmup(taskId: string, workspaceId: string): void;
function cancelWarmup(taskId: string): void;
function releaseTask(taskId: string): void;
function releaseAll(): void;
function getSlotForTask(taskId: string): TerminalSlot | null;
function getSlotRole(slot: TerminalSlot): SlotRole;

// Dedicated terminals (home shell + dev shells — NOT in the pool)
function isDedicatedTerminalTaskId(taskId: string): boolean;
function ensureDedicatedTerminal(input: EnsureDedicatedTerminalInput): TerminalSlot;
function disposeDedicatedTerminal(workspaceId: string, taskId: string): void;
function disposeAllDedicatedTerminalsForWorkspace(workspaceId: string): void;

// Bulk operations (iterate pool slots + dedicated terminals)
function resetAllTerminalRenderers(): number;
function restoreAllTerminals(): number;
function setTerminalFontWeight(weight: number): void;
function setTerminalWebGLRenderer(enabled: boolean): void;
function dumpTerminalDebugInfo(): void;
function writeToTerminalBuffer(workspaceId: string, taskId: string, text: string): void;
function isTerminalSessionRunning(workspaceId: string, taskId: string): boolean;
function warmupPersistentTerminal(workspaceId: string, taskId: string): void;
function cancelWarmupPersistentTerminal(workspaceId: string, taskId: string): void;
```

## Implementation Phases

### Phase 1: TerminalSlot class

#### Overview

Extract a task-agnostic `TerminalSlot` from `PersistentTerminal`. This is the largest phase — most of the PersistentTerminal code carries over, with the key structural change that taskId/workspaceId move from constructor to `connectToTask`/`disconnectFromTask`.

#### Changes Required

##### 1. New file: `web-ui/src/terminal/terminal-slot.ts`

**Action**: Create
**Changes**:

The class carries over almost everything from `PersistentTerminal` with these structural changes:

- **Constructor** takes `slotId: number` only (plus appearance defaults). No taskId/workspaceId. Creates xterm, opens in parking root, attaches WebGL — same as `PersistentTerminal` constructor L149-212 minus the `this.taskId`/`this.workspaceId` assignments and minus the `this.ensureConnected()` call. Scrollback hardcoded to 10,000.
- **`clientId`** generated once in constructor via `generateTerminalClientId()` — persists across task swaps.
- **`connectToTask(taskId, workspaceId)`** — stores taskId/workspaceId in mutable fields. Opens IO + control sockets (using the stored taskId/workspaceId + the slot's clientId). Equivalent to calling `connectIo()` + `connectControl()` from PersistentTerminal. The server sends a restore snapshot automatically on control socket connect.
- **`disconnectFromTask()`** — closes IO + control sockets first (stops new data from arriving). Then drains `terminalWriteQueue` (await the current promise) before calling `terminal.reset()` synchronously — this prevents queued writes from the old task leaking into the cleared buffer. Clears `connectionReady`, `restoreCompleted`, `latestSummary` (prevents stale agentId from suppressing exit notifications on the next task), `lastError`. Calls `clearTerminalGeometry(taskId)`. Nulls out taskId/workspaceId. Clears subscribers (they belong to the previous task's hook instance). Resets `outputTextDecoder` to a fresh instance. Does NOT touch the xterm instance, DOM, or WebGL. Note: `disconnectFromTask` is async (returns Promise) to support the queue drain.
- **`connectedTaskId` / `connectedWorkspaceId`** — getters returning current task or null.
- **Mount/unmount** — same as PersistentTerminal L751-856 but: (a) no `suspendIo()` call in `unmount()` — the pool controls IO state, not the slot; (b) unmount just hides the element and disconnects resize observer. The `ioIntentionallyClosed` flag and `warmup()`/`cancelWarmup()` methods are removed from the slot — warmup is a pool-level concern.
- **`requestResize`** — same as PersistentTerminal L391-421 but uses `this.connectedTaskId` for `reportTerminalGeometry`.
- **`stop()`** — same as PersistentTerminal L1101-1105 but uses mutable taskId/workspaceId. Guards against null: if `connectedTaskId` or `connectedWorkspaceId` is null, returns immediately (can't stop a disconnected slot).
- **`dispose()`** — same as PersistentTerminal L1107-1122. Full teardown: unmount, close sockets, dispose xterm, remove host element.

Everything else (`openTerminalWhenFontsReady`, `attachWebglAddon`, `enqueueTerminalWrite`, `applyRestore`, `repairRendererCanvas`, `listenForDprChange`, `readBufferLines`, `subscribe`, `focus`, `input`, `paste`, `clear`, `reset`, `writeText`, `resetRenderer`, `requestRestore`, `getBufferDebugInfo`, `waitForLikelyPrompt`, key event handler, `sendControlMessage`, `sendIoData`, notify methods) carries over unchanged.

**Exports**: `TerminalSlot` class, `PersistentTerminalAppearance` type (renamed export from current file).

**Code Pattern to Follow**: `persistent-terminal-manager.ts` — extract, don't rewrite. The xterm lifecycle code is battle-tested.

#### Success Criteria

##### Automated

- [ ] TypeScript compiles: `cd web-ui && npx tsc --noEmit`
- [ ] No lint errors: `npm run lint`

##### Behavioral

- [ ] `TerminalSlot` can be instantiated without a taskId
- [ ] `connectToTask` opens IO + control WebSockets with correct URL params
- [ ] `disconnectFromTask` closes sockets, resets buffer, clears taskId

**Checkpoint**: TerminalSlot exists and compiles. Not yet wired to consumers.

---

### Phase 2: TerminalPool manager

#### Overview

Replace `terminal-registry.ts` with `terminal-pool.ts`. Creates 4 TerminalSlot instances at init. Manages slot roles, eviction, warmup, and proactive rotation. Exposes the same module-level API surface as the registry so consumers can switch imports.

#### Changes Required

##### 1. New file: `web-ui/src/terminal/terminal-pool.ts`

**Action**: Create
**Changes**:

Module-level state:
- `slots: TerminalSlot[]` — the 4 pool slot instances
- `slotRoles: Map<TerminalSlot, SlotRole>` — current role per slot
- `slotTaskIds: Map<string, TerminalSlot>` — taskId → slot lookup
- `roleTimestamps: Map<TerminalSlot, number>` — when slot entered current role (for eviction LRU)
- `warmupTimeouts: Map<string, ReturnType<typeof setTimeout>>` — pending warmup cancellation timers
- `rotationTimer: ReturnType<typeof setInterval> | null` — 3-minute rotation interval
- `initialized: boolean`
- `dedicatedTerminals: Map<string, TerminalSlot>` — keyed by `workspaceId:taskId`, for home shell + dev shells (not pool-managed)

**`initPool()`**:
- Creates 4 TerminalSlot instances (slotId 0-3)
- All start as FREE
- Starts 3-minute rotation interval
- Sets `initialized = true`

**`acquireForTask(taskId, workspaceId) → TerminalSlot`**:
1. If task already has a slot (any role): cancel any pending warmup timeout for this task, transition to ACTIVE, return it
2. Cancel any pending warmup timeout for this task
3. If the current ACTIVE slot exists and is a different task: transition it to PREVIOUS
4. If the current PREVIOUS slot exists and is a different task from the new PREVIOUS: cancel any warmup timeout for the evicted task, disconnect → FREE
5. Find a FREE slot, or evict (PRELOADING first by oldest, then READY by oldest). When evicting: cancel any warmup timeout for the evicted task, disconnect → FREE
6. `slot.connectToTask(taskId, workspaceId)`
7. Set role to ACTIVE, record timestamp
8. Return slot

**`warmup(taskId, workspaceId)`**:
1. If task already has a slot (ACTIVE, PREVIOUS, PRELOADING, READY): no-op
2. Find a FREE slot, or evict oldest PRELOADING, then oldest READY. If only ACTIVE/PREVIOUS remain: no-op (can't evict those for a warmup)
3. `slot.connectToTask(taskId, workspaceId)`
4. Set role to PRELOADING, record timestamp
5. Listen for restore completion via `slot.onceConnectionReady(callback)` — a separate one-shot callback on the slot (not part of the subscriber set that gets cleared on disconnect). The callback transitions the slot from PRELOADING to READY. `onceConnectionReady` is cleared by `disconnectFromTask` along with subscribers to prevent stale callbacks.
6. Set a 3-second warmup timeout: if `acquireForTask` hasn't been called for this taskId, call `cancelWarmup`

**`cancelWarmup(taskId)`**:
1. Clear the warmup timeout
2. If task's slot is PRELOADING or READY: `slot.disconnectFromTask()`, set role to FREE

**`releaseTask(taskId)`**:
1. Look up slot by taskId in `slotTaskIds`. If not found, no-op.
2. Clear any warmup timeout for this taskId.
3. Call `slot.disconnectFromTask()`, set role to FREE.
4. Used when `enabled` transitions to `false` in the hook (task moves to backlog/trash) — ensures the slot is freed and sockets are closed.

**`releaseAll()`**:
1. Clear all warmup timeouts
2. For every slot: if not FREE, `slot.disconnectFromTask()`, set role to FREE

**`getSlotForTask(taskId) → TerminalSlot | null`**:
- Look up in `slotTaskIds` map

**Proactive rotation** (runs every 3 minutes via setInterval):
1. Find the oldest FREE slot (by roleTimestamp)
2. If no FREE slots: skip
3. `oldSlot.dispose()` — dispose first to free the WebGL context before creating a new one (avoids briefly exceeding 4 WebGL contexts)
4. Create a new TerminalSlot (slotId = next counter)
5. Set it to FREE with current timestamp
6. Replace old slot in `slots` array

**`isDedicatedTerminalTaskId(taskId) → boolean`**:
- Returns true if taskId is `HOME_TERMINAL_TASK_ID` or starts with `DETAIL_TERMINAL_TASK_PREFIX`. Used as the routing guard to decide pool vs dedicated path.

**`ensureDedicatedTerminal(input) → TerminalSlot`**:
- Input: `{ taskId, workspaceId, cursorColor, terminalBackgroundColor, scrollback? }`
- Mirrors the old `ensurePersistentTerminal` behavior: create-or-reuse from `dedicatedTerminals` map, keyed by `workspaceId:taskId`. Creates a TerminalSlot, immediately calls `connectToTask(taskId, workspaceId)`. On reuse, calls `setAppearance`. These slots are not tracked in the pool's role state machine.

**`disposeDedicatedTerminal(workspaceId, taskId)`**:
- Finds the dedicated terminal in the map, calls `dispose()`, removes from map.

**`disposeAllDedicatedTerminalsForWorkspace(workspaceId)`**:
- Iterates `dedicatedTerminals`, disposes and removes all entries matching the workspaceId prefix.

**Bulk utility functions** — these iterate both pool slots AND `dedicatedTerminals`:
- `resetAllTerminalRenderers()`: iterate pool `slots` + `dedicatedTerminals.values()`, call `slot.resetRenderer()` on each
- `restoreAllTerminals()`: iterate pool `slots` + `dedicatedTerminals.values()`, call `slot.requestRestore()` on each connected slot
- `setTerminalFontWeight(weight)`: call `updateGlobalTerminalFontWeight(weight)` + iterate pool slots + dedicated terminals calling `slot.setFontWeight(weight)`
- `setTerminalWebGLRenderer(enabled)`: call `updateGlobalTerminalWebGLRenderer(enabled)` + iterate pool slots + dedicated terminals calling `slot.setWebGLRenderer(enabled)`
- `dumpTerminalDebugInfo()`: iterate pool slots (log slotId + role + connectedTaskId + buffer debug info) + dedicated terminals (log key + buffer debug info)
- `writeToTerminalBuffer(workspaceId, taskId, text)`: check pool (`getSlotForTask`) first, then `dedicatedTerminals` map; call `slot.writeText(text)`
- `isTerminalSessionRunning(workspaceId, taskId)`: check pool (`getSlotForTask`) first, then `dedicatedTerminals` map; check `slot.sessionState === "running"`

**Compatibility shims for existing warmup API** (called from App.tsx):
- `warmupPersistentTerminal(workspaceId, taskId)`: calls `warmup(taskId, workspaceId)`
- `cancelWarmupPersistentTerminal(workspaceId, taskId)`: calls `cancelWarmup(taskId)`

#### Success Criteria

##### Automated

- [ ] TypeScript compiles: `cd web-ui && npx tsc --noEmit`
- [ ] No lint errors: `npm run lint`

##### Behavioral

- [ ] `initPool()` creates exactly 4 TerminalSlot instances
- [ ] `acquireForTask` returns a slot and transitions it to ACTIVE
- [ ] `warmup` connects a FREE slot and transitions to PRELOADING
- [ ] `cancelWarmup` disconnects and returns slot to FREE
- [ ] `releaseAll` disconnects all slots
- [ ] Eviction follows priority: PRELOADING → READY → never ACTIVE/PREVIOUS

**Checkpoint**: Pool module exists and compiles. Not yet wired to consumers.

---

### Phase 3: Wire consumers

#### Overview

Switch all imports from `terminal-registry` to `terminal-pool`. Initialize the pool in App.tsx. This is the swap — after this phase, the pool is live.

#### Changes Required

##### 1. `web-ui/src/terminal/use-persistent-terminal-session.ts`

**Action**: Modify
**Changes**:
- Import `acquireForTask`, `isDedicatedTerminalTaskId`, `ensureDedicatedTerminal`, `disposeDedicatedTerminal` from `terminal-pool` instead of `ensurePersistentTerminal` / `disposePersistentTerminal` from `terminal-registry`
- Add a routing guard at the top of the main effect: if `isDedicatedTerminalTaskId(taskId)`, use the dedicated terminal path (preserves current behavior — `ensureDedicatedTerminal` on mount, `disposeDedicatedTerminal` on `enabled=false`). Otherwise, use the pool path (`acquireForTask`).
- **Pool path** (agent task terminals):
  - Replace `ensurePersistentTerminal(...)` call (L105) with `acquireForTask(taskId, workspaceId!)` — this returns a TerminalSlot. The pool handles eviction internally.
  - Remove `disposePersistentTerminal` calls from the pool path — the pool manages slot lifecycle. When the hook effect cleans up (task deselected or disabled), just call `terminal.unmount(container)`. The slot stays in the pool as PREVIOUS or gets evicted later. When `enabled` transitions to `false`, call `pool.releaseTask(taskId)` (see Finding #3 below).
  - Remove the `previousSessionRef` tracking and `didSessionRestart` logic — the pool handles task swapping. When a new taskId arrives, `acquireForTask` either returns the existing slot (if PREVIOUS/READY) or evicts and connects a new one. The `reset()` call on session restart is unnecessary because `acquireForTask` on a slot that's already connected to this task is a role transition, not a reconnection.
- **Dedicated path** (home shell + dev shells): preserves existing behavior — `ensureDedicatedTerminal` creates/reuses, `disposeDedicatedTerminal` on `enabled=false` or workspaceId=null, `previousSessionRef` + `didSessionRestart` logic preserved for session restart detection.
- The `subscribe` / `mount` / `unmount` calls remain the same for both paths — TerminalSlot has the same interface.
- The `registerTerminalController` effect (L165-171) stays unchanged.

##### 2. `web-ui/src/App.tsx`

**Action**: Modify
**Changes**:
- Import `initPool`, `warmupPersistentTerminal`, `cancelWarmupPersistentTerminal` from `terminal-pool` instead of `terminal-registry`
- Call `initPool()` once at top level (outside any component) or in a `useEffect([], ...)` at the App root. Since the pool is a singleton module, calling `initPool()` at module import time (top-level side effect) is simplest and matches the pattern of `getParkingRoot()`.
- The `handleTerminalWarmup` / `handleTerminalCancelWarmup` callbacks keep the same shape — they now call pool functions which have the same `(workspaceId, taskId)` signature.

##### 3. `web-ui/src/hooks/use-project-switch-cleanup.ts`

**Action**: Modify
**Changes**:
- Import `releaseAll`, `disposeAllDedicatedTerminalsForWorkspace` from `terminal-pool` instead of `disposeAllPersistentTerminalsForWorkspace` from `terminal-registry`
- Replace `disposeAllPersistentTerminalsForWorkspace(previousProjectId)` (L39) with: `releaseAll()` (disconnects pool slots to FREE) + `disposeAllDedicatedTerminalsForWorkspace(previousProjectId)` (disposes home/dev shell xterm instances). Pool slots survive project switch (xterm instances reused); dedicated terminals are disposed since they are bound to a specific workspace.

##### 4. `web-ui/src/hooks/use-terminal-config-sync.ts`

**Action**: Modify
**Changes**:
- Import `setTerminalFontWeight`, `setTerminalWebGLRenderer` from `terminal-pool` instead of `terminal-registry`

##### 5. `web-ui/src/components/settings/display-sections.tsx`

**Action**: Modify
**Changes**:
- Import `resetAllTerminalRenderers`, `restoreAllTerminals` from `terminal-pool` instead of `terminal-registry`

##### 6. `web-ui/src/components/debug-log-panel.tsx`

**Action**: Modify
**Changes**:
- Import `dumpTerminalDebugInfo` from `terminal-pool` instead of `terminal-registry`

##### 7. `web-ui/src/hooks/use-terminal-panels.ts`

**Action**: Modify
**Changes**:
- Import `isTerminalSessionRunning`, `writeToTerminalBuffer` from `terminal-pool` instead of `terminal-registry`

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Lint passes: `npm run lint`
- [ ] Type check passes: `npm run web:typecheck`
- [ ] Web UI tests pass: `npm run web:test`

##### Behavioral

- [ ] Opening a task shows its terminal output
- [ ] Switching tasks shows the new task's terminal
- [ ] Switching back to previous task is instant (no restore flash)
- [ ] Mouseover preloading works
- [ ] Project switch clears all terminals
- [ ] Home shell and dev shells work independently

**Checkpoint**: Pool is live. Old code still exists but is unused.

---

### Phase 4: Delete old code

#### Overview

Remove `PersistentTerminal` class, `terminal-registry.ts`, and IO suspend/resume logic. Clean up any remaining references.

#### Changes Required

##### 1. Delete `web-ui/src/terminal/terminal-registry.ts`

**Action**: Delete

##### 2. Delete `web-ui/src/terminal/persistent-terminal-manager.ts`

**Action**: Delete

##### 3. Update `web-ui/src/terminal/use-persistent-terminal-session.test.tsx`

**Action**: Modify
**Changes**:
- Update mocks to point at `terminal-pool` instead of `terminal-registry`
- Mock `acquireForTask` instead of `ensurePersistentTerminal`
- Remove `disposePersistentTerminal` mock — no longer called
- The mock return shape is the same (TerminalSlot has the same method interface as PersistentTerminal for the methods the hook uses)

##### 4. Verify no remaining imports

**Action**: Grep for `terminal-registry` and `persistent-terminal-manager` across `web-ui/src`. Fix any remaining references.

#### Success Criteria

##### Automated

- [ ] Full check passes: `npm run check`
- [ ] Full build passes: `npm run build`
- [ ] No references to deleted files: `grep -r "terminal-registry\|persistent-terminal-manager" web-ui/src/`

**Checkpoint**: Old code is gone. Pool is the only terminal management system.

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| WebSocket connection fails during connectToTask | Slot reports error via subscriber `onLastError`. User sees "Terminal stream failed." | Disconnect network, click a task |
| WebGL context loss on a slot | WebGL addon's `onContextLoss` fires, disposes addon, falls back to canvas renderer. Proactive rotation will eventually replace the slot. | Trigger via devtools |
| All 4 slots are ACTIVE/PREVIOUS and warmup is requested | warmup() is a no-op — returns without evicting. | Hover 5th task while 2 are ACTIVE+PREVIOUS and 2 are READY |
| Restore snapshot fails | Slot reports "Terminal restore failed." via onLastError. User can click "Restore all terminals" in settings. | Corrupt restore payload (hard to test manually) |

## Rollback Strategy

- **Phase 1-2 rollback**: Delete new files. No other changes needed — old code still works.
- **Phase 3 rollback**: Revert import changes in consumer files. Old registry is still present.
- **Phase 4 rollback**: Restore deleted files from git.
- **Full rollback**: `git checkout -- web-ui/src/terminal/ web-ui/src/hooks/ web-ui/src/components/ web-ui/src/App.tsx`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Subscriber leak on task swap | Med | Med | disconnectFromTask clears subscribers; hook cleanup runs before new effect |
| Race between warmup timeout and acquireForTask | Low | Low | cancelWarmup checks slot role before disconnecting; acquireForTask cancels pending warmup; eviction always cancels warmup timeout for evicted task |
| Geometry registry reports stale taskId | Low | Med | disconnectFromTask calls clearTerminalGeometry; connectToTask uses new taskId |

## Implementation Notes / Gotchas

- **Extract, don't rewrite**: The PersistentTerminal code is battle-tested. Copy methods verbatim into TerminalSlot, then make the minimal structural changes (mutable taskId, remove constructor socket connect, remove IO suspend). Don't refactor logic while extracting.
- **Subscriber clearing on disconnect**: When `disconnectFromTask` is called, clear the subscriber set. The React hook's effect cleanup will have already run (unsubscribing), and the new effect will re-subscribe. Clearing prevents any leaked subscriber from receiving callbacks for a different task.
- **Parking root**: Reuse the same `getParkingRoot()` pattern. All 4 slots park their host elements there at construction.
- **`initPool()` timing**: Call before any React component tries to acquire a slot. Top-level module execution or `App.tsx` useEffect with empty deps both work. Top-level is simpler.
- **Home/dev shell routing**: `usePersistentTerminalSession` uses `isDedicatedTerminalTaskId(taskId)` to route between the pool path (`acquireForTask` / `releaseTask`) and the dedicated terminal path (`ensureDedicatedTerminal` / `disposeDedicatedTerminal`). The `writeToTerminalBuffer` / `isTerminalSessionRunning` bulk functions check both the pool and the `dedicatedTerminals` side map. This ensures shell panels keep working without polluting the pool's 4-slot budget.

## References

- **Design doc**: `docs/terminal-xterm-pool-strategy.md`
- **Current implementation**: `web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/terminal/terminal-registry.ts`
- **Server viewer state**: `src/terminal/ws-server.ts:424-564`
- **Test Spec**: `docs/forge/2026-04-14-terminal-xterm-pool/test-spec.md`
