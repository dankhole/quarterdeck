# Task Graph: Session Lifecycle Refactor

**Generated**: 2026-04-12
**Spec**: docs/forge/2026-04-12-session-lifecycle-refactor/spec.md
**Test Spec**: docs/forge/2026-04-12-session-lifecycle-refactor/test-spec.md
**Total tasks**: 22 (10 grade-1, 12 grade-2)

## Execution Order

```
T1 ─────────────────────────────────────────────────────────┐
                                                            │
T2 ── T3 ─── T4 ────────────────────────────────────────────┤
                                                            │
T5 ── T6 ── T7 ── T8 ── T9 ─────────────────────────────── │
                                                            │
T10 ── T11 ── T12 ── T13 ── T14 ─────────────────────────── │
                                                            │
T15 ── T16 ── T17 ── T18 ── T19 ── T20 ────────────────── │
                                                            │
T21 ── T22 ──────────────────────────────────────────────── ┘

Phase 1: T1, T2, T3, T4           (helpers)
Phase 2: T5, T6, T7, T8, T9       (timer extraction)
Phase 3: T10, T11, T12, T13, T14  (trust handler)
Phase 4a: T15, T16, T17           (closures to methods)
Phase 4b: T18, T19, T20           (move to new file)
Phase 5: T21, T22                 (cleanup + full verification)
```

## Tasks

---

### Phase 1: Shared Helpers — Exit Finalization and Listener Broadcast

### T1: Add `broadcastToListeners` private method
- **Grade**: 2
- **Status**: pending
- **Depends on**: none
- **SDD Phase**: Phase 1
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Add a private helper method `broadcastToListeners(entry: ProcessEntry, event: { state?: RuntimeTaskSessionSummary; output?: Buffer; exit?: number | null }): void` that iterates `entry.listeners.values()` and calls the appropriate subset of `onState`, `onOutput`, `onExit` callbacks. Replace all 7 inline listener iteration loops (at lines ~207, 489, 518, 684, 707, 1072, 1130) with calls to this helper. The helper must support calling any subset of callbacks based on which event fields are provided.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes; `npm run lint` passes
   - Manual: `git diff --stat` shows only `session-manager.ts` modified

### T2: Add `finalizeProcessExit` private method
- **Grade**: 2
- **Status**: pending
- **Depends on**: T1
- **SDD Phase**: Phase 1
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Add `private finalizeProcessExit(entry: ProcessEntry, exitCode: number | null, interrupted: boolean): void`. Consolidate the shared exit logic from the task `onExit` callback (lines ~507-539) and `applyReconciliationAction` `recover_dead_process` (lines ~1119-1144). Shell `onExit` is excluded (it uses `store.update` directly). The step ordering is specified exactly in the SDD Phase 1 section: (0) capture `active` reference, (1) stop trust timers, (2) clear interrupt timer, (3) dispatch state machine event, (4) get result summary, (5) broadcast to listeners, (6) null `entry.active`, (7) resolve pending exit promises, (8) run async cleanup. The method must NOT include auto-restart logic — that is caller-specific.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes
   - Manual: none

### T3: Update `onExit` callback to use `finalizeProcessExit`
- **Grade**: 2
- **Status**: pending
- **Depends on**: T2
- **SDD Phase**: Phase 1
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Refactor the task `onExit` callback to call `this.finalizeProcessExit(entry, exitCode, interrupted)` followed by the auto-restart check. Per the SDD ordering note: the `onExit` handler must call `this.shouldAutoRestart(entry)` BEFORE calling `finalizeProcessExit` because the finalizer nulls `entry.active`. `shouldAutoRestart` only reads fields that don't require `entry.active`, so calling it first is safe.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes
   - Manual: none

### T4: Update `applyReconciliationAction` to use `finalizeProcessExit`
- **Grade**: 1
- **Status**: pending
- **Depends on**: T2
- **SDD Phase**: Phase 1
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Replace the duplicated exit-handling code in `applyReconciliationAction`'s `recover_dead_process` branch (lines ~1119-1144) with a call to `finalizeProcessExit`. Verify that the behavior is identical — the only difference the SDD notes is that `recover_dead_process` currently captures `cleanupFn` earlier (before the state machine dispatch), but this is not load-bearing since `onSessionCleanup` is not modified by the dispatch.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes; `npm run lint` passes
   - Behavioral: `git diff --stat` shows only `session-manager.ts` modified; line count decreases by ~30-40 lines

---

### Phase 2: Timer Management Extraction

### T5: Create `SessionTimerManager` class in new file
- **Grade**: 2
- **Status**: pending
- **Depends on**: T4
- **SDD Phase**: Phase 2
- **Files to modify**: `src/terminal/session-timer-manager.ts` (new)
- **Description**: Create `src/terminal/session-timer-manager.ts` exporting `SessionTimerManager`. Constructor takes `SessionTimerCallbacks` interface with `onInterruptRecovery: (taskId: string) => void` and `onAutoRestart: (entry: ProcessEntry, request: StartTaskSessionRequest) => void`. Move the following from `session-manager.ts`: constants `INTERRUPT_RECOVERY_DELAY_MS`, `AUTO_RESTART_WINDOW_MS`, `MAX_AUTO_RESTARTS_PER_WINDOW`; methods `scheduleInterruptRecovery`, `clearInterruptRecoveryTimer`, `shouldAutoRestart`, `scheduleAutoRestart`; add `suppressAutoRestart(entry): void` that sets `entry.suppressAutoRestartOnExit = true`. Follow the `SessionSummaryStore` pattern. Import `ActiveProcessState` and `ProcessEntry` types from `session-manager.ts` (they must be exported — see T6). Critical invariant (!5): `scheduleAutoRestart` must set `entry.pendingAutoRestart` synchronously in the same tick as the call.
- **Acceptance criteria**:
   - Automated: `npm run typecheck` passes
   - Manual: none (not yet wired up)

### T6: Export `ActiveProcessState` and `ProcessEntry` types from session-manager
- **Grade**: 1
- **Status**: pending
- **Depends on**: T4
- **SDD Phase**: Phase 2
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Add `export` keyword to the `ActiveProcessState` interface and `ProcessEntry` interface definitions in `session-manager.ts`. These types are needed by `SessionTimerManager` (Phase 2) and later by `PtyProcessManager` (Phase 4). No behavioral change.
- **Acceptance criteria**:
   - Automated: `npm run typecheck` passes
   - Manual: none

### T7: Wire `SessionTimerManager` into `TerminalSessionManager`
- **Grade**: 2
- **Status**: pending
- **Depends on**: T5, T6
- **SDD Phase**: Phase 2
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Add `private readonly timerManager: SessionTimerManager` field. Instantiate in constructor with callbacks: `onInterruptRecovery` calls `this.applySessionEventWithSideEffects(entry, { type: "interrupt.recovery" })` (must look up entry from entries Map by taskId); `onAutoRestart` callback contains the `try/catch` with `await this.startTaskSession(request)`, error handling, and `finally` clearing `entry.pendingAutoRestart`. Replace all inline timer calls: `clearInterruptRecoveryTimer(active)` -> `this.timerManager.clearInterruptRecoveryTimer(active)`; `this.scheduleInterruptRecovery(entry)` -> `this.timerManager.scheduleInterruptRecovery(entry.taskId, entry.active!)`; `this.shouldAutoRestart(entry)` -> `this.timerManager.shouldAutoRestart(entry)`; `this.scheduleAutoRestart(entry)` -> `this.timerManager.scheduleAutoRestart(entry)`; `entry.suppressAutoRestartOnExit = true` (2 sites) -> `this.timerManager.suppressAutoRestart(entry)`. Remove the private methods and module-level function. Remove moved constants. Remove `clearInterruptRecoveryTimer` module-level function import.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes; `npm run lint` passes
   - Behavioral: `session-manager.ts` decreases by ~80 lines; `git diff --stat` shows `session-manager.ts` modified + `session-timer-manager.ts` created

### T8: Write `SessionTimerManager` unit tests
- **Grade**: 2
- **Status**: pending
- **Depends on**: T7
- **SDD Phase**: Phase 2 (test)
- **Files to modify**: `test/runtime/terminal/session-timer-manager.test.ts` (new)
- **Description**: Implement the 10 tests specified in the test spec: (1) `scheduleInterruptRecovery` fires callback after delay, (2) `clearInterruptRecoveryTimer` cancels pending timer, (3) `scheduleInterruptRecovery` replaces existing timer, (4) `shouldAutoRestart` returns false when suppressed, (5) returns false with no listeners, (6) returns false when rate limited, (7) returns true under normal conditions, (8) `scheduleAutoRestart` sets `pendingAutoRestart` synchronously (!5 verification), (9) `scheduleAutoRestart` no-ops if already pending, (10) `scheduleAutoRestart` calls `onAutoRestart` callback. Use `vi.useFakeTimers()` for timer-dependent tests.
- **Acceptance criteria**:
   - Automated: `npx vitest run test/runtime/terminal/session-timer-manager.test.ts` — all 10 tests pass; `npm run test:fast` passes
   - Manual: none

### T9: Phase 2 verification checkpoint
- **Grade**: 1
- **Status**: pending
- **Depends on**: T8
- **SDD Phase**: Phase 2
- **Files to modify**: none
- **Description**: Run the full automated verification suite to confirm Phase 2 is stable before proceeding. Verify line counts are as expected.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes; `npm run lint` passes
   - Behavioral: `wc -l src/terminal/session-timer-manager.ts` shows ~120-150 lines

---

### Phase 3: Workspace Trust Handler Extraction

### T10: Create `WorkspaceTrustHandler` class in new file
- **Grade**: 2
- **Status**: pending
- **Depends on**: T9
- **SDD Phase**: Phase 3
- **Files to modify**: `src/terminal/workspace-trust-handler.ts` (new)
- **Description**: Create `src/terminal/workspace-trust-handler.ts` exporting `WorkspaceTrustHandler` and `TrustAction` type. Constructor takes `agentId`, `cwd`, `workspacePath`, `onConfirm: () => void`, `onWarning: (msg: string) => void`. Internal state: `workspaceTrustBuffer`, `autoConfirmedWorkspaceTrust`, `workspaceTrustConfirmCount`, `workspaceTrustConfirmTimer`. Methods: `isEnabled(): boolean`, `processOutput(data: string): void` (accumulates buffer, detects trust prompts, schedules confirm), `getBuffer(): string | null`, `clearBuffer(): void`, `stop(): void`. Move constants `MAX_WORKSPACE_TRUST_BUFFER_CHARS`, `MAX_AUTO_TRUST_CONFIRMS`, `WORKSPACE_TRUST_CONFIRM_DELAY_MS` from `claude-workspace-trust.ts`. Import `shouldAutoConfirmClaudeWorkspaceTrust`, `shouldAutoConfirmCodexWorkspaceTrust` from existing module. The confirm timer behavior is specified in detail in SDD Phase 3: on fire -> call onConfirm, clear buffer, clear timer ref, if below cap reset autoConfirmedWorkspaceTrust to false, if at cap disable buffer and call onWarning. Important: the `onConfirm` callback must NOT close over a stale `active` reference — the coordinator provides a callback that re-fetches from the entries Map (stale reference guard).
- **Acceptance criteria**:
   - Automated: `npm run typecheck` passes
   - Manual: none (not yet wired up)

### T11: Wire `WorkspaceTrustHandler` into `TerminalSessionManager`
- **Grade**: 2
- **Status**: pending
- **Depends on**: T10
- **SDD Phase**: Phase 3
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Remove trust-related fields from `ActiveProcessState` (`workspaceTrustBuffer`, `autoConfirmedWorkspaceTrust`, `workspaceTrustConfirmCount`, `workspaceTrustConfirmTimer`). Add `trustHandler: WorkspaceTrustHandler | null` to `ActiveProcessState`. In `startTaskSession`: create `WorkspaceTrustHandler` instance if `willAutoTrust`, with stale-reference-safe `onConfirm` callback and `onWarning` callback. Update `needsDecodedOutput` gate to use `(active.trustHandler?.isEnabled() ?? false)`. In task onData: replace trust buffer accumulation block with `active.trustHandler?.processOutput(data)`. Update Codex deferred input checks to use `active.trustHandler?.getBuffer()`. In `applySessionEventWithSideEffects`: replace trust buffer clear with `active.trustHandler?.clearBuffer()`. Replace ALL `stopWorkspaceTrustTimers(active)` calls (5 remaining direct sites after Phase 1 consolidated 2 into `finalizeProcessExit`) with `active.trustHandler?.stop()`. Remove `stopWorkspaceTrustTimers` import. Shell sessions set `trustHandler: null`. Update `trySendDeferredCodexStartupInput` to use `active.trustHandler?.getBuffer()`.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes
   - Behavioral: `session-manager.ts` decreases by ~60-70 lines

### T12: Update test fixtures for `trustHandler` field
- **Grade**: 1
- **Status**: pending
- **Depends on**: T11
- **SDD Phase**: Phase 3
- **Files to modify**: `test/runtime/terminal/session-manager.test.ts` (if needed)
- **Description**: Check whether the 4 test fixtures in `session-manager.test.ts` (at lines ~231, 434, 468, 496) that construct fake `ActiveProcessState` objects via `as unknown as { entries: Map<...> }` casts need a `trustHandler: null` field to satisfy type checking. The SDD notes these tests don't include trust fields currently, so adding `trustHandler: null` may be needed. If the casts bypass type checking entirely (which they likely do via `as unknown`), no change is needed. Verify and update only if required.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes
   - Manual: none

### T13: Write `WorkspaceTrustHandler` unit tests
- **Grade**: 2
- **Status**: pending
- **Depends on**: T11
- **SDD Phase**: Phase 3 (test)
- **Files to modify**: `test/runtime/terminal/workspace-trust-handler.test.ts` (new)
- **Description**: Implement the 12 tests specified in the test spec: (1) buffer accumulates up to cap, (2) detects Claude trust prompt and calls onConfirm after delay, (3) detects Codex trust prompt, (4) auto-confirm fires after `WORKSPACE_TRUST_CONFIRM_DELAY_MS`, (5) `clearBuffer` resets buffer, (6) `getBuffer` returns content, (7) `stop` clears confirm timer, (8) caps at `MAX_AUTO_TRUST_CONFIRMS` then disables and calls onWarning, (9) `isEnabled` returns false without auto-trust, (10) multiple trust prompts confirmed up to cap, (11) after confirm re-enables detection for next prompt, (12) `processOutput` is no-op after `stop()`. Use `vi.useFakeTimers()` for timer tests. Mock `shouldAutoConfirmClaudeWorkspaceTrust`/`shouldAutoConfirmCodexWorkspaceTrust` as needed.
- **Acceptance criteria**:
   - Automated: `npx vitest run test/runtime/terminal/workspace-trust-handler.test.ts` — all 12 tests pass; `npm run test:fast` passes
   - Manual: none

### T14: Phase 3 verification checkpoint
- **Grade**: 1
- **Status**: pending
- **Depends on**: T12, T13
- **SDD Phase**: Phase 3
- **Files to modify**: none
- **Description**: Run the full automated verification suite to confirm Phase 3 is stable. Verify line counts.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes; `npm run lint` passes
   - Behavioral: `wc -l src/terminal/workspace-trust-handler.ts` shows ~120-150 lines; start Claude task in worktree and verify trust prompt is auto-confirmed

---

### Phase 4a: Refactor Closures to Methods

### T15: Extract task `onData` closure into private method
- **Grade**: 2
- **Status**: pending
- **Depends on**: T14
- **SDD Phase**: Phase 4a
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Extract the task `onData` closure (now shorter after trust extraction) into `private handleTaskSessionData(entry: ProcessEntry, request: StartTaskSessionRequest, chunk: Buffer): void`. The spawn call references the method: `onData: (chunk) => this.handleTaskSessionData(entry, request, chunk)`. Critical invariant (!3): the method body must preserve the exact synchronous ordering of the original closure — protocol filtering before terminal mirror, UTF-8 decode before trust buffer accumulation, trust before Codex, state machine transition before listener broadcast.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes
   - Manual: none

### T16: Extract task `onExit` and shell closures into private methods
- **Grade**: 2
- **Status**: pending
- **Depends on**: T15
- **SDD Phase**: Phase 4a
- **Files to modify**: `src/terminal/session-manager.ts`
- **Description**: Extract three more closures into methods: (1) `private handleTaskSessionExit(entry: ProcessEntry, request: StartTaskSessionRequest, exitCode: number | null): void` — calls `finalizeProcessExit` then handles auto-restart. Must re-fetch entry from the Map as a safety guard per the SDD. (2) `private handleShellSessionData(entry: ProcessEntry, request: StartShellSessionRequest, chunk: Buffer): void`. (3) `private handleShellSessionExit(entry: ProcessEntry, request: StartShellSessionRequest, exitCode: number | null): void` — shell exit uses `store.update` directly, not the state machine. Update spawn calls to reference the methods.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes
   - Manual: none

### T17: Phase 4a verification checkpoint
- **Grade**: 1
- **Status**: pending
- **Depends on**: T16
- **SDD Phase**: Phase 4a
- **Files to modify**: none
- **Description**: Run the full test suite to confirm the closure-to-method refactor is behaviorally identical. This is a critical checkpoint: if any test fails, the extraction changed behavior.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes; `npm run lint` passes
   - Manual: none

---

### Phase 4b: Move PTY Operations to New File

### T18: Create `PtyProcessManager` class and move spawn/data/exit methods
- **Grade**: 2
- **Status**: pending
- **Depends on**: T17
- **SDD Phase**: Phase 4b
- **Files to modify**: `src/terminal/pty-process-manager.ts` (new), `src/terminal/session-manager.ts`
- **Description**: Create `src/terminal/pty-process-manager.ts` exporting `PtyProcessManager`. Constructor takes `PtyProcessManagerDeps` interface with: `store`, `getEntry`, `timerManager`, `applySessionEvent`, `broadcastToListeners`, `finalizeProcessExit`, `hasLiveOutputListener`. Move from `session-manager.ts`: `ActiveProcessState` interface, `handleTaskSessionData`, `handleTaskSessionExit`, `handleShellSessionData`, `handleShellSessionExit`, `trySendDeferredCodexStartupInput`, `resize`, `pauseOutput`, `resumeOutput`. Move helper functions: `hasCodexInteractivePrompt`, `hasCodexStartupUiRendered`, `buildTerminalEnvironment`, `formatSpawnFailure`, `formatShellSpawnFailure`. Move constants: `SIGINT_BYTE`, `ESC_BYTE`, `MAX_SIGINT_DETECT_BUFFER_SIZE`, `OSC_FOREGROUND_QUERY_REPLY`, `OSC_BACKGROUND_QUERY_REPLY`. Add spawn methods: `spawnTaskSession(entry, request, launch)` and `spawnShellSession(entry, request)` that encapsulate PTY spawn + `ActiveProcessState` creation + hook up onData/onExit. Use `import type { ProcessEntry }` from session-manager (type-only to prevent circular deps). `prepareAgentLaunch` is imported directly from `agent-session-adapters.ts`.
- **Acceptance criteria**:
   - Automated: `npm run typecheck` passes
   - Manual: none (needs wiring)

### T19: Wire `PtyProcessManager` into coordinator and update imports
- **Grade**: 2
- **Status**: pending
- **Depends on**: T18
- **SDD Phase**: Phase 4b
- **Files to modify**: `src/terminal/session-manager.ts`, `src/terminal/session-timer-manager.ts`
- **Description**: Add `private readonly ptyManager: PtyProcessManager` field. Instantiate in constructor with dependency callbacks. Update `startTaskSession` and `startShellSession` to delegate spawn to `ptyManager.spawnTaskSession(entry, request, launch)` / `ptyManager.spawnShellSession(entry, request)`. Delegate `resize`, `pauseOutput`, `resumeOutput` to pty manager. `writeInput` stays entirely on the coordinator (!4). Remove all moved methods, types, constants, and helper functions from `session-manager.ts`. Update `session-timer-manager.ts` to `import type { ActiveProcessState } from "./pty-process-manager"` (was `"./session-manager"`). Ensure no circular value imports: `pty-process-manager` uses `import type { ProcessEntry }` from `session-manager`, and `session-manager` uses value import of `PtyProcessManager` from `pty-process-manager`.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run typecheck` passes; `npm run lint` passes
   - Behavioral: `session-manager.ts` is ~250-300 lines

### T20: Phase 4b verification checkpoint
- **Grade**: 1
- **Status**: pending
- **Depends on**: T19
- **SDD Phase**: Phase 4b
- **Files to modify**: none
- **Description**: Full test suite and behavioral verification. Start a Claude task, verify output streams and transitions work. Start a shell session, verify output and clean exit. Verify Codex deferred input if possible.
- **Acceptance criteria**:
   - Automated: `npm run test:fast` passes; `npm run test` passes (full suite including integration); `npm run typecheck` passes; `npm run lint` passes
   - Behavioral: Start Claude task -> agent runs, output streams, card transitions work; start shell -> output streams, clean exit

---

### Phase 5: Coordinator Cleanup and Full Verification

### T21: Clean up `ProcessEntry`, verify coordinator methods, update exports
- **Grade**: 2
- **Status**: pending
- **Depends on**: T20
- **SDD Phase**: Phase 5
- **Files to modify**: `src/terminal/session-manager.ts`, `src/terminal/pty-process-manager.ts`
- **Description**: Final cleanup pass. (1) Review `ProcessEntry` — remove any fields now managed by extracted modules that are only stored for forwarding. Verify it is exported. (2) Verify the coordinator method list matches the SDD Phase 5 expected list (~17-18 methods including private helpers). (3) Verify `StartTaskSessionRequest` and `StartShellSessionRequest` are still exported from `session-manager.ts`. (4) `ActiveProcessState` is now defined in `pty-process-manager.ts` — verify it is exported from there. Do NOT re-export from `session-manager.ts`. If any test file imports `ActiveProcessState` by name, update the import path. (5) Run `npm run build` to verify production build succeeds.
- **Acceptance criteria**:
   - Automated: `npm run test` passes (full suite); `npm run typecheck` passes; `npm run build` succeeds; `npm run lint` passes
   - Behavioral: `wc -l src/terminal/session-manager.ts` shows 250-350 lines; `wc -l src/terminal/session-timer-manager.ts src/terminal/workspace-trust-handler.ts src/terminal/pty-process-manager.ts` shows ~600-750 total lines

### T22: Full functional verification (all 12 steps)
- **Grade**: 1
- **Status**: pending
- **Depends on**: T21
- **SDD Phase**: Phase 5
- **Files to modify**: none
- **Description**: Execute all 12 functional verification steps from the SDD spec. Steps 1-4 are automated, steps 5-12 are manual behavioral tests. (1) `npm run test:fast` — all pass. (2) `npm run test` — all pass including integration. (3) `npm run typecheck` — no type errors. (4) `npm run lint` — no lint errors. (5) Start Claude task, let it complete tool use, observe card transition to review. (6) Approve permission prompt, observe card resume to running. (7) Kill agent process, observe error state and auto-restart. (8) Ctrl+C on running agent, wait 5s, verify attention transition. (9) Start Claude task, verify trust prompt auto-confirmed. (10) Start shell, type commands, exit cleanly. (11) Close browser tab while agent runs, reopen, verify reconciliation. (12) Run `grep -c 'import.*session-manager' src/trpc/*.ts src/server/*.ts` — same count as before refactor (verify !2 no external API changes).
- **Acceptance criteria**:
   - Automated: Steps 1-4 all pass
   - Behavioral: Steps 5-12 all verified manually

---

## Plan Corrections Log
[empty]

## Summary
[empty - filled during build]
