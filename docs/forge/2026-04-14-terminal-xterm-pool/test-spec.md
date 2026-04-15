# Test Specification: Terminal xterm Pool

**Date**: 2026-04-14
**Companion SDD**: `docs/forge/2026-04-14-terminal-xterm-pool/spec.md`
**Adversarial Review Passes**: 1

## Test Strategy

The terminal pool is primarily a browser-side resource management system. Unit tests focus on the pool's state machine (slot roles, eviction, warmup lifecycle) using mocked TerminalSlot instances. The existing `use-persistent-terminal-session.test.tsx` is updated to mock the pool instead of the registry.

Integration testing is manual — verifying real xterm + WebSocket behavior in the browser. The pool's correctness is best verified by the state machine unit tests plus manual smoke tests.

### Test Infrastructure

- **Framework**: Vitest (web-ui tests)
- **Test directories**: `web-ui/src/terminal/` (co-located)
- **Run command**: `npm run web:test`
- **CI integration**: `npm run web:test` in test.yml

### Coverage Goals

- Every pool state transition has a test
- Every eviction scenario has a test (including warmup timeout cancellation on eviction)
- Warmup lifecycle (preload → ready → cancel) is tested
- releaseTask (enabled=false cleanup) is tested
- releaseAll (project switch) is tested
- Proactive rotation is tested (dispose-before-create ordering verified)
- Dedicated terminal lifecycle (create, reuse, dispose, bulk ops) is tested
- Home/dev shell routing guard is tested
- disconnectFromTask state cleanup (latestSummary, lastError) is tested
- stop() null guard is tested
- Existing hook tests pass with updated mocks

## Unit Tests

### TerminalPool State Machine

**Test file**: `web-ui/src/terminal/terminal-pool.test.ts`
**Pattern to follow**: See `web-ui/src/terminal/terminal-options.test.ts` for Vitest conventions in this directory.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `initPool creates 4 slots all FREE` | Pool initialization |
| 2 | `acquireForTask returns slot and sets ACTIVE` | Basic acquisition |
| 3 | `acquireForTask for same task returns same slot` | Idempotent acquisition |
| 4 | `acquireForTask transitions previous ACTIVE to PREVIOUS` | Role cascade on task switch |
| 5 | `acquireForTask evicts old PREVIOUS when new PREVIOUS is set` | PREVIOUS slot limit |
| 6 | `acquireForTask evicts PRELOADING before READY` | Eviction priority |
| 7 | `acquireForTask evicts oldest READY when multiple exist` | LRU eviction |
| 8 | `acquireForTask never evicts ACTIVE or PREVIOUS` | Eviction safety |
| 9 | `acquireForTask on PRELOADING/READY slot promotes to ACTIVE` | Warmup-to-click flow |
| 10 | `warmup connects FREE slot and sets PRELOADING` | Warmup initiation |
| 11 | `warmup is no-op for ACTIVE task` | !7 constraint |
| 12 | `warmup is no-op for PREVIOUS task` | !7 constraint |
| 13 | `warmup evicts oldest PRELOADING if no FREE` | Warmup eviction |
| 14 | `cancelWarmup disconnects and returns to FREE` | Warmup cancellation |
| 15 | `cancelWarmup is no-op for non-warming task` | Safe cancel |
| 16 | `warmup auto-cancels after 3s if not acquired` | Warmup timeout |
| 17 | `releaseAll disconnects all slots to FREE` | Project switch |
| 18 | `releaseAll clears warmup timeouts` | Cleanup on release |
| 19 | `getSlotForTask returns slot or null` | Lookup |
| 20 | `rotation replaces oldest FREE slot` | Proactive rotation |
| 21 | `rotation skips when no FREE slots` | Rotation safety |
| 22 | `releaseTask disconnects slot and sets FREE` | Task release (enabled=false) |
| 23 | `releaseTask is no-op for unknown taskId` | Safe release |
| 24 | `eviction cancels warmup timeout for evicted task` | Eviction + warmup cleanup |
| 25 | `rotation disposes old before creating new (no 5th slot)` | WebGL context cap |
| 26 | `isDedicatedTerminalTaskId returns true for home shell` | Dedicated terminal routing |
| 27 | `isDedicatedTerminalTaskId returns true for detail terminal prefix` | Dedicated terminal routing |
| 28 | `isDedicatedTerminalTaskId returns false for regular taskId` | Dedicated terminal routing |
| 29 | `ensureDedicatedTerminal creates and connects TerminalSlot` | Dedicated terminal lifecycle |
| 30 | `ensureDedicatedTerminal reuses existing for same key` | Dedicated terminal reuse |
| 31 | `disposeDedicatedTerminal disposes and removes from map` | Dedicated terminal cleanup |
| 32 | `disposeAllDedicatedTerminalsForWorkspace disposes matching entries` | Project switch cleanup |
| 33 | `writeToTerminalBuffer finds dedicated terminal` | Bulk ops span both maps |
| 34 | `isTerminalSessionRunning finds dedicated terminal` | Bulk ops span both maps |
| 35 | `disconnectFromTask clears latestSummary` | Stale state cleanup |
| 36 | `stop() is no-op when slot is disconnected` | Null guard on stop |

#### Test Details

##### 1. `initPool creates 4 slots all FREE`

**Setup**: Mock TerminalSlot constructor. Call `initPool()`.
**Assertions**:
- 4 TerminalSlot instances created
- All have role FREE
- Rotation timer started

##### 4. `acquireForTask transitions previous ACTIVE to PREVIOUS`

**Setup**: `initPool()`. `acquireForTask("task-a", "ws-1")`.
**Action**: `acquireForTask("task-b", "ws-1")`
**Assertions**:
- task-a's slot role is PREVIOUS
- task-a's slot still has `connectedTaskId === "task-a"` (IO stays open)
- task-b's slot role is ACTIVE
- `disconnectFromTask` was NOT called on task-a's slot

##### 5. `acquireForTask evicts old PREVIOUS when new PREVIOUS is set`

**Setup**: `initPool()`. Acquire tasks A, B, C in sequence.
**Action**: When C is acquired, A was PREVIOUS (from A→B switch), B becomes new PREVIOUS.
**Assertions**:
- A's slot: `disconnectFromTask` called, role is FREE
- B's slot: role is PREVIOUS (IO open)
- C's slot: role is ACTIVE

##### 6. `acquireForTask evicts PRELOADING before READY`

**Setup**: `initPool()`. Acquire task A (ACTIVE). Warmup tasks B and C (one transitions to READY, one stays PRELOADING). Fourth slot is PREVIOUS for a prior task.
**Action**: `acquireForTask("task-d", "ws-1")`
**Assertions**:
- PRELOADING slot was evicted (disconnectFromTask called), not the READY one

##### 8. `acquireForTask never evicts ACTIVE or PREVIOUS`

**Setup**: `initPool()`. Acquire task A (ACTIVE). Acquire task B (A→PREVIOUS, B→ACTIVE). Warmup tasks C and D into READY.
**Action**: `acquireForTask("task-e", "ws-1")`
**Assertions**:
- One of C or D (READY) was evicted
- A (PREVIOUS) and B (ACTIVE) were NOT evicted

##### 11. `warmup is no-op for ACTIVE task`

**Setup**: `initPool()`. `acquireForTask("task-a", "ws-1")`.
**Action**: `warmup("task-a", "ws-1")`
**Assertions**:
- No new slot connections
- task-a's slot is still ACTIVE
- No warmup timeout set

##### 16. `warmup auto-cancels after 3s if not acquired`

**Setup**: `initPool()`. `warmup("task-a", "ws-1")`. Use `vi.useFakeTimers()`.
**Action**: Advance time by 3000ms.
**Assertions**:
- task-a's slot: `disconnectFromTask` called
- task-a's slot role: FREE

##### 17. `releaseAll disconnects all slots to FREE`

**Setup**: `initPool()`. Acquire tasks A (ACTIVE), B (PREVIOUS). Warmup C (READY).
**Action**: `releaseAll()`
**Assertions**:
- All 3 connected slots: `disconnectFromTask` called
- All 4 slots: role is FREE

##### 20. `rotation replaces oldest FREE slot`

**Setup**: `initPool()`. Use `vi.useFakeTimers()`. Only 2 slots are connected (ACTIVE + PREVIOUS), other 2 are FREE.
**Action**: Advance time by 3 minutes.
**Assertions**:
- Oldest FREE slot: `dispose()` called BEFORE new TerminalSlot constructor
- New TerminalSlot created
- Pool still has exactly 4 slots
- New slot is FREE

##### 22. `releaseTask disconnects slot and sets FREE`

**Setup**: `initPool()`. `acquireForTask("task-a", "ws-1")`.
**Action**: `releaseTask("task-a")`
**Assertions**:
- task-a's slot: `disconnectFromTask` called
- task-a's slot role: FREE
- `getSlotForTask("task-a")` returns null

##### 24. `eviction cancels warmup timeout for evicted task`

**Setup**: `initPool()`. Use `vi.useFakeTimers()`. Acquire task A (ACTIVE). Warmup task B (PRELOADING). Warmup task C (PRELOADING).
**Action**: Acquire tasks D and E to force eviction of B and C's slots.
**Assertions**:
- Advancing time by 3s does NOT call `disconnectFromTask` again on evicted slots (warmup timeouts were cancelled during eviction)

##### 29. `ensureDedicatedTerminal creates and connects TerminalSlot`

**Setup**: `initPool()`.
**Action**: `ensureDedicatedTerminal({ taskId: "__home_terminal__", workspaceId: "ws-1", cursorColor: "c", terminalBackgroundColor: "bg" })`
**Assertions**:
- New TerminalSlot created
- `connectToTask("__home_terminal__", "ws-1")` called
- Pool slot count unchanged (still 4)
- `getSlotForTask("__home_terminal__")` returns null (not in pool)

##### 35. `disconnectFromTask clears latestSummary`

**Setup**: Create a TerminalSlot. Connect to task. Simulate a state message that sets `latestSummary` with an `agentId`.
**Action**: `disconnectFromTask()`
**Assertions**:
- After reconnecting to a different task, `notifyExit` is NOT suppressed (latestSummary was cleared)

### use-persistent-terminal-session hook (updated)

**Test file**: `web-ui/src/terminal/use-persistent-terminal-session.test.tsx`

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `acquires slot from pool on mount (agent task)` | Hook calls acquireForTask for non-dedicated taskId |
| 2 | `uses dedicated terminal on mount (home shell)` | Hook calls ensureDedicatedTerminal for HOME_TERMINAL_TASK_ID |
| 3 | `mounts slot into container` | Hook calls slot.mount |
| 4 | `unmounts slot on cleanup` | Hook effect cleanup calls slot.unmount |
| 5 | `does not dispose pool slot on cleanup` | No disposeDedicatedTerminal or dispose call for pool tasks |
| 6 | `disposes dedicated terminal when enabled=false` | Hook calls disposeDedicatedTerminal for home shell taskId |
| 7 | `calls releaseTask when enabled=false (agent task)` | Hook calls releaseTask for pool tasks |
| 8 | `subscribes and unsubscribes` | Hook subscribes on mount, unsubscribes on cleanup |

These are updates to the existing test file — change mocks from `ensurePersistentTerminal`/`disposePersistentTerminal` to `acquireForTask`/`ensureDedicatedTerminal`/`isDedicatedTerminalTaskId`.

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior |
|---|-----------|----------|-------------------|
| 1 | `acquireForTask with all slots non-evictable` | 1 ACTIVE + 1 PREVIOUS + 2 READY, acquire 5th | Evicts oldest READY |
| 2 | `warmup with all slots non-evictable` | 1 ACTIVE + 1 PREVIOUS + 2 in ACTIVE/PREVIOUS states | warmup is no-op |
| 3 | `cancelWarmup for unknown taskId` | Cancel warmup for task with no slot | No-op, no error |
| 4 | `acquireForTask cancels pending warmup` | warmup("a"), then acquireForTask("a") | Warmup timeout cleared, slot promoted to ACTIVE |
| 5 | `releaseAll with no connected slots` | All 4 slots already FREE | No-op, no error |
| 6 | `double acquireForTask same task` | acquireForTask("a") twice | Same slot returned, still ACTIVE |
| 7 | `rotation during all busy` | All 4 slots connected (no FREE) | Rotation skips this cycle |

## Regression Tests

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 1 | `home shell terminal works independently` | Home shell creates its own xterm, not a pool slot | `use-terminal-panels.ts:268-297` |
| 2 | `dev shell terminal works independently` | Dev shell creates its own xterm, not a pool slot | `use-terminal-panels.ts:312-348` |
| 3 | `terminal controller registration per taskId` | registerTerminalController still called per taskId | `use-persistent-terminal-session.ts:165-171` |

## Test Execution Plan

### Phase 1-2: TerminalSlot + TerminalPool

1. **Write pool state machine tests** (`terminal-pool.test.ts`)
   - Mock TerminalSlot (constructor, connectToTask, disconnectFromTask, dispose)
   - Write all 36 test cases (pool state machine + dedicated terminals + slot cleanup)
   - Run: `npm run web:test -- terminal-pool` — all FAIL (pool doesn't exist yet)
2. **Implement TerminalSlot + TerminalPool**
   - Run: `npm run web:test -- terminal-pool` — all pass

### Phase 3: Wire consumers

1. **Update hook test** (`use-persistent-terminal-session.test.tsx`)
   - Change mocks from registry to pool
   - Run: `npm run web:test` — all pass

### Phase 4: Delete old code

1. **Verify no test references to deleted files**
   - Run: `npm run web:test` — all pass
   - Run: `npm run check` — passes

### Commands

```bash
# Run all web-ui tests
npm run web:test

# Run pool tests only
npm run web:test -- terminal-pool

# Run hook tests only
npm run web:test -- use-persistent-terminal-session

# Run with verbose output
npm run web:test -- --reporter=verbose
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| !1 Fixed pool size | `initPool creates 4 slots all FREE`, `rotation replaces oldest FREE slot`, test 25 | Unit |
| !2 Home/dev shell excluded | Tests 26-34, Regression tests 1-2 | Unit, Regression |
| !3 PREVIOUS keeps IO open | `acquireForTask transitions previous ACTIVE to PREVIOUS` | Unit |
| !4 Eviction priority | Tests 6, 7, 8 | Unit |
| !5 clientId per-slot | Verified by TerminalSlot constructor (no unit test needed — structural) | — |
| !7 Warmup no-op | Tests 11, 12 | Unit |
| !8 Scrollback 10K | Verified by TerminalSlot constructor (hardcoded value) | — |
| Phase 1 connectToTask/disconnectFromTask | Tests 2, 14, 17, 35, 36 | Unit |
| Phase 2 pool state machine | Tests 1-36 | Unit |
| Phase 3 consumer wiring | Hook tests 1-8 | Unit |
| Phase 4 cleanup | Automated grep check | Automated |
| releaseTask | Tests 22, 23 | Unit |
| Eviction warmup cleanup | Test 24 | Unit |
