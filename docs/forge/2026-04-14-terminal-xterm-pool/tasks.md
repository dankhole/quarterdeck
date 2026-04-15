# Task Graph: Terminal xterm Pool

**Generated**: 2026-04-14
**Spec**: `docs/forge/2026-04-14-terminal-xterm-pool/spec.md`
**Test Spec**: `docs/forge/2026-04-14-terminal-xterm-pool/test-spec.md`
**Total tasks**: 7 (3 grade-1, 3 grade-2, 1 grade-1 batch)

## Execution Order

```
T1: Create TerminalSlot class (grade 2) — Phase 1
T2: Create TerminalPool manager (grade 2) — Phase 2, depends on T1
T3: Write pool unit tests (grade 2) — depends on T2
T4: Wire consumers (grade 1 batch) — Phase 3, depends on T2
  T4a: Wire use-persistent-terminal-session hook
  T4b: Wire App.tsx + project switch + config sync
  T4c: Wire settings, debug panel, terminal panels
T5: Delete old code (grade 1) — Phase 4, depends on T4
T6: Update existing hook tests (grade 1) — depends on T5
T7: Final validation (grade 1) — depends on T3, T6
```

## Tasks

### T1: Create TerminalSlot class

- **Grade**: 2
- **Status**: pending
- **Depends on**: none
- **SDD Phase**: Phase 1
- **Files to modify**:
  - `web-ui/src/terminal/terminal-slot.ts` — new file, extracted from persistent-terminal-manager.ts
- **Description**: Extract `TerminalSlot` class from `PersistentTerminal`. Copy the PersistentTerminal class, then make these structural changes: (1) Constructor takes `slotId: number` only — no taskId/workspaceId, no `ensureConnected()` call. Scrollback hardcoded to 10,000. (2) Add `connectToTask(taskId, workspaceId)` — stores in mutable fields, calls connectIo() + connectControl(). (3) Add async `disconnectFromTask()` — closes sockets, drains terminalWriteQueue, calls terminal.reset() synchronously, clears connectionReady/restoreCompleted/latestSummary/lastError/outputTextDecoder, calls clearTerminalGeometry, nulls taskId/workspaceId, clears subscribers and onceConnectionReady callback. (4) Add `onceConnectionReady(callback)` — one-shot callback separate from subscriber set, cleared by disconnectFromTask. (5) Add connectedTaskId/connectedWorkspaceId getters. (6) Remove ioIntentionallyClosed flag, warmup(), cancelWarmup(), suspendIo() — pool handles these. (7) unmount() no longer calls suspendIo() — just hides element + disconnects observer. (8) stop() guards on connectedTaskId/connectedWorkspaceId being non-null. (9) requestResize uses mutable connectedTaskId for reportTerminalGeometry. Export TerminalSlot class and PersistentTerminalAppearance type. Read `persistent-terminal-manager.ts` fully and extract — don't rewrite.
- **Acceptance criteria**:
  - [ ] File `web-ui/src/terminal/terminal-slot.ts` exists
  - [ ] TypeScript compiles: `cd web-ui && npx tsc --noEmit` passes
  - [ ] Lint passes: `npm run lint`
  - [ ] TerminalSlot class exported with all methods from interface contract
  - [ ] No taskId/workspaceId in constructor
  - [ ] connectToTask/disconnectFromTask methods present
  - [ ] onceConnectionReady method present
  - [ ] No reference to ioIntentionallyClosed, warmup, cancelWarmup, suspendIo
- **Outcome notes**:
- **Attempts**:

### T2: Create TerminalPool manager

- **Grade**: 2
- **Status**: pending
- **Depends on**: T1
- **SDD Phase**: Phase 2
- **Files to modify**:
  - `web-ui/src/terminal/terminal-pool.ts` — new file
- **Description**: Create the pool manager module with all functions from the interface contract. Module-level state: slots array, slotRoles map, slotTaskIds map, roleTimestamps map, warmupTimeouts map, rotationTimer, dedicatedTerminals map. Implement: initPool (creates 4 slots, starts rotation timer), acquireForTask (state machine from spec — eviction priority, PREVIOUS cascade, warmup timeout cancellation on eviction), warmup (connect FREE slot, set PRELOADING, use onceConnectionReady for READY transition, 3s auto-cancel timeout), cancelWarmup, releaseTask, releaseAll, getSlotForTask, getSlotRole. Proactive rotation: 3-min interval, dispose-before-create for oldest FREE slot. Dedicated terminal functions: isDedicatedTerminalTaskId, ensureDedicatedTerminal, disposeDedicatedTerminal, disposeAllDedicatedTerminalsForWorkspace. Bulk functions: resetAllTerminalRenderers, restoreAllTerminals, setTerminalFontWeight, setTerminalWebGLRenderer, dumpTerminalDebugInfo, writeToTerminalBuffer, isTerminalSessionRunning — all iterate both pool slots AND dedicatedTerminals. Compatibility shims: warmupPersistentTerminal, cancelWarmupPersistentTerminal.
- **Acceptance criteria**:
  - [ ] File `web-ui/src/terminal/terminal-pool.ts` exists
  - [ ] TypeScript compiles: `cd web-ui && npx tsc --noEmit` passes
  - [ ] Lint passes: `npm run lint`
  - [ ] All functions from interface contract exported
  - [ ] initPool creates exactly 4 TerminalSlot instances
  - [ ] acquireForTask implements eviction priority (PRELOADING → READY → never ACTIVE/PREVIOUS)
  - [ ] warmup is no-op for ACTIVE/PREVIOUS tasks
  - [ ] releaseTask disconnects and frees slot
  - [ ] Proactive rotation disposes before creating (no temporary 5th slot)
  - [ ] Dedicated terminal functions work independently of pool
- **Outcome notes**:
- **Attempts**:

### T3: Write pool unit tests

- **Grade**: 2
- **Status**: pending
- **Depends on**: T2
- **SDD Phase**: Test spec
- **Files to modify**:
  - `web-ui/src/terminal/terminal-pool.test.ts` — new file
- **Description**: Write the 36 test cases from the test spec. Mock TerminalSlot (constructor, connectToTask, disconnectFromTask, dispose, onceConnectionReady, connectedTaskId getter, sessionState getter, resetRenderer, requestRestore, setFontWeight, setWebGLRenderer, writeText, getBufferDebugInfo). Use vi.useFakeTimers() for warmup timeout and rotation tests. Test all state transitions, eviction scenarios, dedicated terminal lifecycle, bulk operations spanning both maps, disconnectFromTask state cleanup, stop() null guard. Follow Vitest conventions from terminal-options.test.ts.
- **Acceptance criteria**:
  - [ ] File `web-ui/src/terminal/terminal-pool.test.ts` exists
  - [ ] All 36 test cases from test spec present
  - [ ] Tests pass: `npm run web:test -- terminal-pool`
  - [ ] No test uses real TerminalSlot (all mocked)
- **Outcome notes**:
- **Attempts**:

### T4: Wire consumers (batch)

- **Grade**: 1 (batch of 3)
- **Status**: pending
- **Depends on**: T2
- **SDD Phase**: Phase 3
- **Files to modify**:
  - `web-ui/src/terminal/use-persistent-terminal-session.ts` — switch from registry to pool with isDedicatedTerminalTaskId routing guard
  - `web-ui/src/App.tsx` — import initPool + warmup/cancelWarmup from pool, call initPool()
  - `web-ui/src/hooks/use-project-switch-cleanup.ts` — releaseAll() + disposeAllDedicatedTerminalsForWorkspace()
  - `web-ui/src/hooks/use-terminal-config-sync.ts` — import from pool
  - `web-ui/src/components/settings/display-sections.tsx` — import from pool
  - `web-ui/src/components/debug-log-panel.tsx` — import from pool
  - `web-ui/src/hooks/use-terminal-panels.ts` — import from pool
- **Description**:
  **T4a — Hook**: In `use-persistent-terminal-session.ts`, add routing guard using `isDedicatedTerminalTaskId(taskId)`. Dedicated path: `ensureDedicatedTerminal` on mount, `disposeDedicatedTerminal` on enabled=false/workspaceId=null, keep previousSessionRef + didSessionRestart logic. Pool path: `acquireForTask(taskId, workspaceId!)` on mount, remove disposePersistentTerminal calls, remove previousSessionRef/didSessionRestart logic, call `releaseTask(taskId)` when enabled transitions to false. Both paths: subscribe/mount/unmount calls same. registerTerminalController unchanged.
  **T4b — App + project switch + config**: In App.tsx, import initPool/warmupPersistentTerminal/cancelWarmupPersistentTerminal from terminal-pool, call initPool() at top level. In use-project-switch-cleanup.ts, import releaseAll + disposeAllDedicatedTerminalsForWorkspace, replace single call with both. In use-terminal-config-sync.ts, change import.
  **T4c — Settings + debug + terminal panels**: Change imports in display-sections.tsx, debug-log-panel.tsx, use-terminal-panels.ts from terminal-registry to terminal-pool.
- **Acceptance criteria**:
  - [ ] Build succeeds: `npm run build`
  - [ ] Lint passes: `npm run lint`
  - [ ] Type check passes: `npm run web:typecheck`
  - [ ] No imports from `terminal-registry` in modified files
  - [ ] initPool() called in App.tsx
  - [ ] Hook uses routing guard for dedicated vs pool path
  - [ ] Project switch calls both releaseAll() and disposeAllDedicatedTerminalsForWorkspace()
- **Outcome notes**:
- **Attempts**:

### T5: Delete old code

- **Grade**: 1
- **Status**: pending
- **Depends on**: T4
- **SDD Phase**: Phase 4
- **Files to modify**:
  - `web-ui/src/terminal/terminal-registry.ts` — delete
  - `web-ui/src/terminal/persistent-terminal-manager.ts` — delete
- **Description**: Delete terminal-registry.ts and persistent-terminal-manager.ts. Grep for any remaining imports of these files across web-ui/src and fix. Run build to confirm clean compilation.
- **Acceptance criteria**:
  - [ ] Both files deleted
  - [ ] No remaining references: `grep -r "terminal-registry\|persistent-terminal-manager" web-ui/src/` returns nothing
  - [ ] Build succeeds: `npm run build`
  - [ ] Lint passes: `npm run lint`
- **Outcome notes**:
- **Attempts**:

### T6: Update existing hook tests

- **Grade**: 1
- **Status**: pending
- **Depends on**: T5
- **SDD Phase**: Phase 4
- **Files to modify**:
  - `web-ui/src/terminal/use-persistent-terminal-session.test.tsx` — update mocks from registry to pool
- **Description**: Update test mocks: mock `@/terminal/terminal-pool` instead of `@/terminal/terminal-registry`. Mock `acquireForTask` instead of `ensurePersistentTerminal`. Mock `isDedicatedTerminalTaskId` to return false (tests use regular taskIds). Remove `disposePersistentTerminal` mock. Mock return shape stays the same (TerminalSlot has same method interface). Verify all existing tests pass with updated mocks.
- **Acceptance criteria**:
  - [ ] Tests pass: `npm run web:test -- use-persistent-terminal-session`
  - [ ] No references to terminal-registry in test file
  - [ ] No references to ensurePersistentTerminal or disposePersistentTerminal
- **Outcome notes**:
- **Attempts**:

### T7: Final validation

- **Grade**: 1
- **Status**: pending
- **Depends on**: T3, T6
- **SDD Phase**: All
- **Files to modify**: none
- **Description**: Run full validation suite: `npm run check && npm run build`. Verify all tests pass, no type errors, no lint errors, no remaining references to old files. This is the gate before marking the build complete.
- **Acceptance criteria**:
  - [ ] `npm run check` passes (lint + typecheck + tests)
  - [ ] `npm run build` passes
  - [ ] `npm run web:test` passes (all tests including new pool tests)
  - [ ] No references to deleted files
- **Outcome notes**:
- **Attempts**:

## Plan Corrections Log

| Correction | Type | Task | What changed |
|-----------|------|------|-------------|

## Summary

- **Completed**: 0 of 7 tasks
- **Stuck**: 0
- **Skipped**: 0
- **Plan corrections**: 0
- **Total build attempts**: 0
