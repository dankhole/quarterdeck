# Session Lifecycle Refactor — Implementation Specification

**Date**: 2026-04-12
**Branch**: session-lifecycle-refactor
**Adversarial Review Passes**: 3
**Test Spec**: docs/forge/2026-04-12-session-lifecycle-refactor/test-spec.md

<!-- Raw Intent:
Use the existing refactor plan at docs/refactor-session-lifecycle.md as a basis, but fully assess viability and risk, and plan in a way that doesn't degrade current behavior. Focus on the structural refactor only — patches A/B/C will be implemented separately.
-->

## Goal

Decompose `TerminalSessionManager` (1,186 lines, 7 responsibilities) into focused modules without changing any external behavior. Each extracted module is independently testable. The refactor reduces the risk surface for future bug fixes by giving each responsibility clear boundaries and a smaller blast radius.

## Behavioral Change Statement

> **BEFORE**: `session-manager.ts` is a 1,186-line class that mixes PTY process management (~530 lines), workspace trust detection (~70 lines), Codex-specific quirks (~55 lines), state machine side-effects (~24 lines), timer management (~80 lines), listener notifications (~35 lines), reconciliation dispatch (~80 lines), and hydration/recovery (~50 lines). Side effects are scattered across closures. The `onData` callback alone is ~115 lines of interleaved concerns. Bug fixes require understanding the entire file.
> **AFTER**: `TerminalSessionManager` is a ~250-300 line coordinator delegating to focused modules. Each module owns one concern. The `TerminalSessionService` interface and all external consumers are unchanged.
> **SCOPE — all code paths affected**:
> 1. Task session lifecycle: `startTaskSession` → onData → onExit → auto-restart — `session-manager.ts:285-617`
> 2. Shell session lifecycle: `startShellSession` → onData → onExit — `session-manager.ts:619-773`
> 3. User input + interrupt: `writeInput` — `session-manager.ts:817-862`
> 4. PTY I/O control: `resize`, `pauseOutput`, `resumeOutput` — `session-manager.ts:864-900`
> 5. Stop/shutdown: `stopTaskSession`, `stopTaskSessionAndWaitForExit`, `markInterruptedAndStopAll` — `session-manager.ts:902-951`
> 6. Reconciliation: `reconcileSessionStates`, `applyReconciliationAction` — `session-manager.ts:1087-1162`
> 7. Recovery: `recoverStaleSession` — `session-manager.ts:775-815`

## Hard Behavioral Constraints

### !1 — All existing tests pass without modification

Every test in `test/runtime/terminal/session-manager*.test.ts`, `test/runtime/terminal/session-reconciliation.test.ts`, and `test/runtime/trpc/hooks-api.test.ts` must pass without changes throughout all phases. The `entries` Map stays on `TerminalSessionManager` because 4 tests in `session-manager.test.ts` access it via `as unknown as { entries: Map<...> }` casts at lines 231, 434, 468, 496.

### !2 — No external API changes

The `TerminalSessionService` interface (`terminal-session-service.ts`) and `TerminalSessionManager`'s public method signatures are unchanged. No consumer file (`hooks-api.ts`, `runtime-api.ts`, `workspace-registry.ts`, `shutdown-coordinator.ts`, `ws-server.ts`, `runtime-state-hub.ts`, `workspace-api.ts`, `projects-api.ts`, `runtime-server.ts`, `cli.ts`) needs to change its imports or call sites.

### !3 — onData synchronous ordering preserved

The onData callback's execution order is load-bearing. After extraction, these orderings MUST hold within a single synchronous tick:
- Protocol filtering before terminal mirror update
- UTF-8 decode before trust buffer accumulation, Codex input, and transition detection
- Trust buffer accumulation before Codex deferred input check (trust buffer is fallback input)
- State machine transition before listener broadcast (listeners see post-transition state)

### !4 — writeInput synchronous ordering preserved

In `writeInput`, flag-setting (Codex prompt flag, state transition, interrupt detection) must all complete synchronously before the PTY write. Any async boundary between flag-setting and `session.write(data)` breaks Codex prompt suppression and interrupt detection.

### !5 — Auto-restart scheduling semantics preserved

`scheduleAutoRestart` creates a Promise (async microtask). No additional await points may be introduced in the scheduling path. The `pendingAutoRestart` field must be set synchronously within the same tick as the scheduling call.

### !6 — Git bisectable

Each phase produces one or two commits that independently pass all tests and don't change external behavior.

## Functional Verification

| # | What to do | Expected result | Code path verified |
|---|---|---|---|
| 1 | `npm run test:fast` | All tests pass | All paths |
| 2 | `npm run test` | All tests pass including integration | All paths |
| 3 | `npm run typecheck` | No type errors | All paths |
| 4 | `npm run lint` | No lint errors | All paths |
| 5 | Start a Claude task, let it complete a tool use, observe card transition to "review" | Card moves from active to review column | Path 1 (task lifecycle) |
| 6 | Approve a permission prompt by typing in terminal, observe card resume to "running" | Card moves back to active column. `writeInput` → `transitionToRunning` fires before PTY write | Paths 1, 3 |
| 7 | Kill agent process (kill -9 PID), observe card transition | Card shows error state. If viewer attached, auto-restart triggers | Paths 1, 6 |
| 8 | Press Ctrl+C on running agent, wait 5s | Card transitions to awaiting_review with reason "attention" | Paths 3, 1 |
| 9 | Start Claude task in worktree, observe trust prompt auto-confirmed | No manual confirmation needed. Trust prompt dismissed within ~200ms | Path 1 |
| 10 | Start shell session, type commands, exit | Shell runs, output streams, clean exit to idle | Path 2 |
| 11 | Close browser tab while agent runs, reopen | Reconciliation detects processless session or viewer reconnect triggers recovery | Paths 6, 7 |
| 12 | Run `grep -c 'import.*session-manager' src/trpc/*.ts src/server/*.ts` | Same count before and after refactor | !2 |

## Current State

- `src/terminal/session-manager.ts:194-1186` — `TerminalSessionManager` class, 1,186 lines mixing 7 responsibilities
- `src/terminal/session-manager.ts:64-79` — `ActiveProcessState` interface, 15 fields spanning 6 concerns (PTY, trust, Codex, filtering, transition detection, interrupt timer)
- `src/terminal/session-manager.ts:81-92` — `ProcessEntry` interface, 10 fields mixing process state with timer state
- `src/terminal/session-manager.ts:376-491` — task onData callback, 115 lines of interleaved concerns
- `src/terminal/session-manager.ts:499-540` — task onExit callback, duplicated by reconciliation at lines 1119-1144
- `src/terminal/session-manager.ts:1087-1162` — reconciliation dispatch with duplicated exit-handling logic
- `src/terminal/session-summary-store.ts` — already extracted, fully self-contained
- `src/terminal/session-reconciliation.ts` — already extracted, pure functions
- `src/terminal/session-state-machine.ts:1-97` — already extracted, pure reducer

## Desired End State

```
TerminalSessionManager (~250-300 lines, coordinator)
  ├── entries Map<taskId, ProcessEntry>
  ├── store: SessionSummaryStore
  ├── reconciliationTimer
  ├── SessionTimerManager (interrupt recovery, auto-restart, rate limiting)
  ├── WorkspaceTrustHandler (per-session trust buffer management)
  └── PtyProcessManager (spawn, exit, data routing, writeInput, resize)
        ├── uses WorkspaceTrustHandler
        └── uses SessionTimerManager

session-state-machine.ts (unchanged or minimally enriched)
session-summary-store.ts (unchanged)
session-reconciliation.ts (unchanged)
```

External consumers continue to import and use `TerminalSessionManager` exactly as before. The extraction is invisible to callers.

## Out of Scope

- Bug fixes (permission race, non-hook operations, notification beeps, hook timeouts) — handled separately as Patches A/B
- Moving `canTransitionTaskForHookEvent` to the state machine — research confirmed it's a guard-before-dispatch pattern in the hook layer, not duplication
- Consolidating permission guards between hooks-api and reconciliation — research confirmed `isPermissionActivity` is already imported, not duplicated
- Changing the `TerminalSessionService` interface
- Changing external consumer imports
- Frontend changes
- Adding new features or recovery mechanisms

## Dependencies

- **Teams**: None
- **Services**: None
- **Data**: None
- **Timing**: Should land BEFORE patches A/B — cleaner code structure makes the patches easier to implement and review

## New Dependencies & Configuration

None. This refactor uses only existing dependencies and creates no new configuration.

## Architecture & Approach

### Strategy: Bottom-up extraction with shared helpers first

The approach extracts from the bottom up: first consolidate duplicated patterns into helpers, then extract self-contained concerns (timers, workspace trust), then extract the PTY process management, and finally reduce the coordinator. Each phase delivers independent value and can be stopped at any point.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|---|---|---|---|---|
| Phase ordering | Helpers → Timers → Trust → PTY → Coordinator | Each phase simplifies the next. Helpers reduce the lines that need to move. Timers/trust simplify the onData callback before it's extracted. | Original doc: state machine enrichment first | Phases are independently committable |
| Keep `entries` on coordinator | The `entries` Map stays on `TerminalSessionManager` | 4 tests cast to access it directly. Moving it requires test rewrites, violating !1 | Expose via getter, move to sub-module | `entries` must be private on the class |
| onData stays as single function | The onData pipeline is a single synchronous function inside PtyProcessManager, not decomposed into a pipeline of handlers | Preserving synchronous ordering (!3) is simpler when the code stays in one function. Pipeline decomposition adds abstraction without reducing complexity | Decompose onData into handler chain | No async boundaries in onData |
| Trust handler returns actions | WorkspaceTrustHandler returns action objects instead of directly writing to PTY/store | Keeps the handler pure and testable. Coordinator dispatches actions | Handler directly writes to PTY | Handler must not hold PTY references |
| Timer callbacks for coordinator re-entry | SessionTimerManager takes callbacks for operations that need coordinator state | Auto-restart needs `startTaskSession`, interrupt recovery needs `applySessionEventWithSideEffects` — both live on the coordinator | Pass coordinator reference to timer manager | Timer manager must not import session-manager (circular dep) |
| Don't move canTransitionTaskForHookEvent | Keep it in hooks-api.ts | Research confirmed: guard-before-dispatch pattern, not duplication. It filters `activity` events, which the reducer doesn't handle | Move to session-state-machine.ts | hooks-api.ts is not modified in this refactor |

## Implementation Phases

### Phase 1: Shared Helpers — Exit Finalization and Listener Broadcast

#### Overview

Extract two helper patterns that appear in multiple places. This reduces duplication and makes subsequent phases cleaner by giving them smaller units to move.

#### Changes Required

##### 1. Exit finalization helper

**File**: `src/terminal/session-manager.ts`
**Action**: Add private method
**Location**: After `applySessionEventWithSideEffects` at line ~999
**Changes**:
- Add `private finalizeProcessExit(entry: ProcessEntry, exitCode: number | null, interrupted: boolean): void`
- Body consolidates the shared logic from task `onExit` (lines 507-539) and `applyReconciliationAction` `recover_dead_process` (lines 1119-1144). **Shell `onExit` is excluded** — it uses `store.update` directly (not the state machine reducer) and does not resolve `pendingExitResolvers`. Shell exit is extracted as a separate `handleShellSessionExit` method in Phase 4a.
- The step ordering below matches the current task `onExit` ordering. `recover_dead_process` currently differs by capturing `cleanupFn` earlier (before `applySessionEventWithSideEffects`), but this is not load-bearing since `onSessionCleanup` is not modified by the state machine dispatch. The canonical ordering:
  0. `const active = entry.active` — capture reference before any mutation (step 6 nulls `entry.active`, so all subsequent steps use this captured reference)
  1. `active.trustHandler?.stop()` — clear trust timers (after Phase 3; `stopWorkspaceTrustTimers(active)` before Phase 3)
  2. `timerManager.clearInterruptRecoveryTimer(active)` — clear interrupt timer (after Phase 2; `clearInterruptRecoveryTimer(active)` before Phase 2)
  3. `applySessionEventWithSideEffects(entry, { type: "process.exit", exitCode, interrupted })` — state machine transition
  4. Get result summary (fallback to `store.getSummary`)
  5. Broadcast `onState` + `onExit` to listeners via `broadcastToListeners`
  6. Set `entry.active = null`
  7. Resolve pending exit promises (drain `pendingExitResolvers`)
  8. Capture `active.onSessionCleanup`, null it out on the captured `active` reference, then run async cleanup (fire-and-forget). Safe because step 0 captured `active` before step 6 nulled `entry.active`.
- Update `onExit` callback to call `finalizeProcessExit` then handle auto-restart
- Update `applyReconciliationAction` `recover_dead_process` to call `finalizeProcessExit`

**Critical invariant**: The `onExit` path has additional logic after exit finalization (auto-restart check and scheduling). `finalizeProcessExit` must NOT include auto-restart — that's caller-specific.

**Ordering note**: `onExit` currently calls `shouldAutoRestart(entry)` between step 3 and step 5 (before broadcast/nulling active). `finalizeProcessExit` cannot include this because `shouldAutoRestart` is caller-specific. The `onExit` handler must call `this.shouldAutoRestart(entry)` BEFORE calling `finalizeProcessExit`, because `finalizeProcessExit` nulls `entry.active` in step 6. This is safe — `shouldAutoRestart` only reads `entry.suppressAutoRestartOnExit`, `entry.listeners`, `entry.restartRequest`, and `entry.autoRestartTimestamps`, none of which require `entry.active`.

##### 2. Listener broadcast helper

**File**: `src/terminal/session-manager.ts`
**Action**: Add private method
**Location**: Near `finalizeProcessExit`
**Changes**:
- Add `private broadcastToListeners(entry: ProcessEntry, event: { state?: RuntimeTaskSessionSummary; output?: Buffer; exit?: number | null }): void`
- Body iterates `entry.listeners.values()` and calls the appropriate callback(s)
- Replace the 7 inline listener loops (lines 207, 489, 518, 684, 707, 1072, 1130) with calls to this helper

**Note**: Line 207 (constructor onChange relay) calls only `onState`. The helper must support calling any subset of `onState`, `onOutput`, `onExit`.

#### Success Criteria

##### Automated
- [ ] `npm run test:fast` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes

##### Behavioral
- [ ] `git diff --stat` shows only `src/terminal/session-manager.ts` modified
- [ ] Line count of session-manager.ts decreases by ~30-40 lines (duplication removed, helpers added)

**Checkpoint**: Commit. Verify all tests pass.

---

### Phase 2: Timer Management Extraction

#### Overview

Extract interrupt recovery timer scheduling, auto-restart scheduling, and restart rate limiting into a focused module. These have clean boundaries: they set/clear timers and call back into the coordinator when timers fire.

#### Changes Required

##### 1. New file: SessionTimerManager

**File**: `src/terminal/session-timer-manager.ts` (new, ~120-150 lines)
**Action**: Create
**Changes**:
- Export `SessionTimerManager` class
- Constructor takes callbacks:
  ```typescript
  interface SessionTimerCallbacks {
    onInterruptRecovery: (taskId: string) => void;
    onAutoRestart: (entry: ProcessEntry, request: StartTaskSessionRequest) => void;
  }
  ```
- Methods:
  - `scheduleInterruptRecovery(taskId: string, active: ActiveProcessState): void` — moved from `session-manager.ts:1164-1185`
  - `clearInterruptRecoveryTimer(active: ActiveProcessState): void` — moved from `session-manager.ts:187-192`
  - `shouldAutoRestart(entry: ProcessEntry): boolean` — moved from `session-manager.ts:1028-1046`. Note: this method has a consume-once side effect — it resets `entry.suppressAutoRestartOnExit = false` after reading it. The timer manager owns the full flag lifecycle (set via `suppressAutoRestart`, consume via `shouldAutoRestart`).
  - `scheduleAutoRestart(entry: ProcessEntry): void` — moved from `session-manager.ts:1048-1085`
  - `suppressAutoRestart(entry: ProcessEntry): void` — sets `entry.suppressAutoRestartOnExit = true`
- Move constants: `INTERRUPT_RECOVERY_DELAY_MS`, `AUTO_RESTART_WINDOW_MS`, `MAX_AUTO_RESTARTS_PER_WINDOW`
- Import: `ActiveProcessState` and `ProcessEntry` types (keep them defined in session-manager.ts for now, export them)

**Pattern to follow**: The existing `SessionSummaryStore` extraction pattern — clean interface, constructor injection for dependencies.

##### 2. Update TerminalSessionManager

**File**: `src/terminal/session-manager.ts`
**Action**: Modify
**Changes**:
- Export `ActiveProcessState` and `ProcessEntry` types (needed by timer manager)
- Add `private readonly timerManager: SessionTimerManager` field
- In constructor: instantiate `SessionTimerManager` with callbacks that call back into the coordinator:
  - `onInterruptRecovery`: calls `this.applySessionEventWithSideEffects(entry, { type: "interrupt.recovery" })`
  - `onAutoRestart`: The `scheduleAutoRestart` method on the timer manager creates the async Promise and assigns `entry.pendingAutoRestart` synchronously (!5). The Promise body calls `onAutoRestart(entry, request)`. The coordinator's callback implementation contains the `try/catch` with: `await this.startTaskSession(request)` and on error: `this.store.update(entry.taskId, { warningMessage })` + broadcast error output to listeners. The `finally` block clears `entry.pendingAutoRestart`. All error handling stays in the coordinator callback — the timer manager only handles scheduling.
- Replace all inline timer calls:
  - `clearInterruptRecoveryTimer(active)` → `this.timerManager.clearInterruptRecoveryTimer(active)`
  - `this.scheduleInterruptRecovery(entry)` → `this.timerManager.scheduleInterruptRecovery(entry.taskId, entry.active!)`
  - `this.shouldAutoRestart(entry)` → `this.timerManager.shouldAutoRestart(entry)`
  - `this.scheduleAutoRestart(entry)` → `this.timerManager.scheduleAutoRestart(entry)`
  - `entry.suppressAutoRestartOnExit = true` → `this.timerManager.suppressAutoRestart(entry)` — there are 2 sites: `writeInput` (line 856, interrupt detection) and `stopTaskSession` (line 907, explicit stop)
- Remove private methods: `scheduleInterruptRecovery`, `shouldAutoRestart`, `scheduleAutoRestart`
- Remove moved constants

**Critical invariant (!5)**: `scheduleAutoRestart` sets `entry.pendingAutoRestart` synchronously. The extracted version must preserve this — the Promise assignment happens in the same tick as the call.

#### Success Criteria

##### Automated
- [ ] `npm run test:fast` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes

##### Behavioral
- [ ] `git diff --stat` shows `session-manager.ts` modified + `session-timer-manager.ts` created
- [ ] `session-manager.ts` decreases by ~80 lines

**Checkpoint**: Commit.

---

### Phase 3: Workspace Trust Handler Extraction

#### Overview

Extract workspace trust buffer management, prompt detection, and auto-confirm scheduling into a handler object. This is the second-most intertwined concern in onData (after the state machine transition) and removing it significantly simplifies the callback.

#### Changes Required

##### 1. New file: WorkspaceTrustHandler

**File**: `src/terminal/workspace-trust-handler.ts` (new, ~120-150 lines)
**Action**: Create
**Changes**:
- Export `WorkspaceTrustHandler` class
- Export type for trust actions:
  ```typescript
  type TrustAction =
    | { type: "confirm"; delayMs: number }
    | { type: "warning"; message: string }
    | { type: "disable-buffer" }
    | { type: "clear-buffer" };
  ```
- Constructor takes: `agentId`, `cwd`, `workspacePath`, `onConfirm: () => void`, `onWarning: (msg: string) => void`
- **Stale reference guard**: The current code re-fetches `activeEntry` from the entries Map when the trust confirm timer fires (line 420: `const activeEntry = this.entries.get(request.taskId)?.active`). The `onConfirm` callback passed to the handler constructor must use the same pattern — it must NOT close over a stale `active` reference. The coordinator must pass a callback that looks up the current active state at call time:
  ```typescript
  onConfirm: () => {
    const currentActive = this.entries.get(request.taskId)?.active;
    if (currentActive) {
      currentActive.session.write("\r");
    }
  }
  ```
  This prevents writing to a PTY session that has already been stopped and replaced.
- State (moved from `ActiveProcessState`): `workspaceTrustBuffer`, `autoConfirmedWorkspaceTrust`, `workspaceTrustConfirmCount`, `workspaceTrustConfirmTimer`
- Methods:
  - `isEnabled(): boolean` — whether trust auto-confirm is active for this session
  - `processOutput(data: string): void` — accumulates buffer, detects prompts, schedules confirm
  - `getBuffer(): string | null` — for Codex deferred input fallback check
  - `clearBuffer(): void` — called on state transitions (via `clearAttentionBuffer`)
  - `stop(): void` — clears timers, called on session exit/stop
- Move constants: `MAX_WORKSPACE_TRUST_BUFFER_CHARS`, `MAX_AUTO_TRUST_CONFIRMS`, `WORKSPACE_TRUST_CONFIRM_DELAY_MS` (from `claude-workspace-trust.ts`)
- Move detection logic: `shouldAutoConfirmClaudeWorkspaceTrust`, `shouldAutoConfirmCodexWorkspaceTrust` remain as imports — the handler calls them to decide whether to enable
- The handler owns its confirm timer internally. When the timer fires, it:
  1. Calls `onConfirm()` which the coordinator maps to `session.write("\r")`
  2. Clears the trust buffer (resets to empty string, not null — buffer stays enabled)
  3. Clears the confirm timer reference
  4. If `workspaceTrustConfirmCount < MAX_AUTO_TRUST_CONFIRMS`: resets `autoConfirmedWorkspaceTrust = false` to re-enable detection for subsequent trust prompts (e.g. `--add-dir` directories)
  5. If cap reached: disables the buffer entirely (`workspaceTrustBuffer = null`), logs a warning, and calls `onWarning()` with the cap-reached message
  This matches the current inline timer callback behavior at lines 420-451.

**Pattern to follow**: The trust handler is similar to the existing `TerminalProtocolFilterState` — a stateful processor that receives output chunks and produces actions/effects.

##### 2. Update TerminalSessionManager

**File**: `src/terminal/session-manager.ts`
**Action**: Modify
**Changes**:
- Remove trust-related fields from `ActiveProcessState`: `workspaceTrustBuffer`, `autoConfirmedWorkspaceTrust`, `workspaceTrustConfirmCount`, `workspaceTrustConfirmTimer`
- Add `trustHandler: WorkspaceTrustHandler | null` to `ActiveProcessState`
- In `startTaskSession`: create `WorkspaceTrustHandler` instance (if `willAutoTrust`), passing callbacks:
  - `onConfirm`: must re-fetch active state at call time (see stale reference guard above):
    ```typescript
    () => {
      const currentActive = this.entries.get(request.taskId)?.active;
      if (currentActive) { currentActive.session.write("\r"); }
    }
    ```
  - `onWarning`: `(msg) => this.store.update(taskId, { warningMessage: msg })`
- **Update `needsDecodedOutput` gate** (line 391-392): replace `entry.active.workspaceTrustBuffer !== null` with `(active.trustHandler?.isEnabled() ?? false)`. This conditional controls whether the raw `filteredChunk` is UTF-8 decoded into a `data` string. Without this update, the trust handler would never receive decoded output (compile error on the removed field, and behavioral break if bypassed).
- In task onData: replace trust buffer accumulation block (lines 398-454) with:
  ```typescript
  if (active.trustHandler) {
    active.trustHandler.processOutput(data);
  }
  ```
- In Codex deferred input check: replace `active.workspaceTrustBuffer` reads with `active.trustHandler?.getBuffer()`. Use null narrowing:
  ```typescript
  const buf = active.trustHandler?.getBuffer();
  const trustPromptVisible = buf != null && hasCodexWorkspaceTrustPrompt(buf);
  ```
  Similarly in onData (lines 466-468), replace `entry.active.workspaceTrustBuffer` references with `active.trustHandler?.getBuffer() ?? null` and null-narrow before passing to `hasCodexInteractivePrompt`/`hasCodexStartupUiRendered`.
- In `applySessionEventWithSideEffects`: replace trust buffer clear with `active.trustHandler?.clearBuffer()`
- Replace ALL `stopWorkspaceTrustTimers(active)` calls with `active.trustHandler?.stop()`. There are **7** call sites in the current code:
  1. `startTaskSession` line 301 — cleanup before respawn
  2. `startShellSession` line 631 — cleanup before respawn
  3. Shell `onExit` line 697 — shell session exit cleanup
  4. `stopTaskSession` line 910
  5. `markInterruptedAndStopAll` line 946
  6. `onExit` line 507 (now inside `finalizeProcessExit` from Phase 1)
  7. `applyReconciliationAction` `recover_dead_process` line 1120 (now inside `finalizeProcessExit` from Phase 1)
  After Phase 1, sites 6 and 7 are consolidated in `finalizeProcessExit`. All 5 remaining direct sites (1-5 above + `finalizeProcessExit`) must be updated.
- Remove the `stopWorkspaceTrustTimers` import from `claude-workspace-trust.ts` — it is no longer needed.
- **Shell sessions**: Do NOT create a `WorkspaceTrustHandler` for shell sessions. Currently shells set `workspaceTrustBuffer: null` (line 736). After this phase, shells set `trustHandler: null`. The shell `onData` trust buffer check (lines 674-681) becomes `active.trustHandler?.processOutput(data)` which safely no-ops when `trustHandler` is null.
- Update `trySendDeferredCodexStartupInput` to use `active.trustHandler?.getBuffer()`

**Critical note**: The 4 tests in `session-manager.test.ts` that construct fake `ActiveProcessState` objects will need the new `trustHandler` field. But wait — these tests construct objects with `active: { session, terminalProtocolFilter, ... }` — they don't include trust fields at all currently. Adding `trustHandler: null` to the fake objects is a one-field addition per test, not a behavioral change.

**Risk to !1**: Check whether the 4 test fixtures at lines 231, 434, 468, 496 of `session-manager.test.ts` would break. If they set `workspaceTrustBuffer: null` explicitly (they don't — research showed they don't include trust fields), we're fine. If they rely on the interface having specific fields via type checking, we need to verify.

#### Success Criteria

##### Automated
- [ ] `npm run test:fast` passes
- [ ] `npm run typecheck` passes

##### Behavioral
- [ ] Start Claude task in worktree → trust prompt auto-confirmed
- [ ] `session-manager.ts` decreases by ~60-70 lines

**Checkpoint**: Commit.

---

### Phase 4: PTY Process Management Extraction

#### Overview

The largest phase. Extract spawn logic, onData pipeline, onExit handling, writeInput, resize, and pause/resume into a focused module. By this point, timers and workspace trust are already extracted, which significantly simplifies the onData and onExit closures.

This phase is split into two commits for safety:
- **4a**: Refactor closures into methods (no file moves, same class)
- **4b**: Move methods to new file

#### Changes Required

##### 4a. Refactor closures into methods

**File**: `src/terminal/session-manager.ts`
**Action**: Modify
**Changes**:
- Extract the task onData closure (lines ~376-491, now shorter after trust extraction) into a method:
  `private handleTaskSessionData(entry: ProcessEntry, request: StartTaskSessionRequest, chunk: Buffer): void`
- Extract the task onExit closure into a method:
  `private handleTaskSessionExit(entry: ProcessEntry, request: StartTaskSessionRequest, exitCode: number | null): void`
  (calls `finalizeProcessExit` from Phase 1, then handles auto-restart)
  **Important**: The current `onExit` closure re-fetches `entry` from the `entries` Map (line 499: `const currentEntry = this.entries.get(request.taskId)`). The extracted method receives `entry` as a parameter from the closure `onExit: (event) => this.handleTaskSessionExit(entry, request, event.exitCode)`, but the `entry` captured by the closure is the same object reference that lives in the Map — it is not stale because `ProcessEntry` objects are mutable and never replaced. The re-fetch pattern in the original code is a safety guard. The extracted method should also re-fetch from the Map to preserve this guard:
  ```typescript
  private handleTaskSessionExit(entry: ProcessEntry, request: StartTaskSessionRequest, exitCode: number | null): void {
    const currentEntry = this.entries.get(request.taskId);
    if (!currentEntry?.active) return;
    // ... rest of logic uses currentEntry
  }
  ```
- Extract the shell onData closure similarly
- Extract the shell onExit closure similarly
- The spawn calls in `startTaskSession`/`startShellSession` now reference methods instead of inline closures:
  ```typescript
  onData: (chunk) => this.handleTaskSessionData(entry, request, chunk),
  onExit: (event) => this.handleTaskSessionExit(entry, request, event.exitCode),
  ```

**Critical invariant (!3)**: The method bodies must preserve the exact synchronous ordering of the original closures. This is a pure refactor — move code, don't reorder it.

**Verification**: Run `npm run test` after this step. If any test fails, the closure-to-method conversion changed behavior.

##### 4b. Move PTY operations to new file

**File**: `src/terminal/pty-process-manager.ts` (new, ~400-450 lines)
**Action**: Create
**Changes**:
- Export `PtyProcessManager` class
- Constructor takes dependencies:
  ```typescript
  interface PtyProcessManagerDeps {
    store: SessionSummaryStore;
    getEntry: (taskId: string) => ProcessEntry | undefined;
    timerManager: SessionTimerManager;
    applySessionEvent: (entry: ProcessEntry, event: SessionTransitionEvent) => SessionTransitionResult | null;  // maps to coordinator's applySessionEventWithSideEffects — includes trust buffer clear, interrupt timer clear, Codex flag reset
    broadcastToListeners: (entry: ProcessEntry, event: {...}) => void;
    finalizeProcessExit: (entry: ProcessEntry, exitCode: number | null, interrupted: boolean) => void;
    hasLiveOutputListener: (entry: ProcessEntry) => boolean;
  }
  ```
  Note: `prepareAgentLaunch` is a module-level import from `agent-session-adapters.ts`, not a coordinator method — the PTY manager imports it directly. `trySendDeferredCodexStartupInput` moves to the PTY manager as a private method since it reads trust handler state and writes to PTY (both PTY manager concerns after Phase 3). `hasLiveOutputListener` needs the entry's `listeners` Map which lives on the coordinator, so it is passed as a callback.
- Methods moved from session-manager:
  - `spawnTaskSession(entry: ProcessEntry, request: StartTaskSessionRequest, launch: PreparedAgentLaunch): PtySession` — the PTY spawn call plus creating `ActiveProcessState`
  - `spawnShellSession(entry: ProcessEntry, request: StartShellSessionRequest): PtySession`
  - `handleTaskSessionData(entry, request, chunk)` — the full onData pipeline
  - `handleTaskSessionExit(entry, request, exitCode)`
  - `handleShellSessionData(entry, request, chunk)`
  - `handleShellSessionExit(entry, request, exitCode)`
  - `trySendDeferredCodexStartupInput(taskId)` — reads trust handler buffer + writes to PTY
  - `resize(entry, cols, rows, pixelWidth, pixelHeight)`
  - `pauseOutput(entry)`, `resumeOutput(entry)`
- Move: `ActiveProcessState` interface, helper functions (`hasCodexInteractivePrompt`, `hasCodexStartupUiRendered`, `buildTerminalEnvironment`, `formatSpawnFailure`, `formatShellSpawnFailure`)
- Move constants: `SIGINT_BYTE`, `ESC_BYTE`, `MAX_SIGINT_DETECT_BUFFER_SIZE`, `OSC_FOREGROUND_QUERY_REPLY`, `OSC_BACKGROUND_QUERY_REPLY`, `MAX_WORKSPACE_TRUST_BUFFER_CHARS` (if not already in trust handler)
- **Import chain updates**: After moving `ActiveProcessState` to this file, update `session-timer-manager.ts` to `import type { ActiveProcessState } from "./pty-process-manager"` (was `"./session-manager"`). Use `import type` — this is a type-only import and must remain so to avoid circular dependencies.
- **Circular dependency prevention**: `pty-process-manager.ts` imports `ProcessEntry` from `session-manager.ts` — this MUST use `import type { ProcessEntry }` (type-only). `session-manager.ts` imports the `PtyProcessManager` class (value import) from `pty-process-manager.ts`. Value imports in one direction + type-only imports in the other direction is safe with ESM. Do NOT use value imports in both directions.

**File**: `src/terminal/session-manager.ts`
**Action**: Modify (significant reduction)
**Changes**:
- Add `private readonly ptyManager: PtyProcessManager` field
- In constructor: instantiate `PtyProcessManager` with dependencies
- `startTaskSession`: keeps entry management, store initialization, `prepareAgentLaunch` call, `TerminalStateMirror` creation. Delegates spawn + closure setup to `ptyManager.spawnTaskSession(entry, request, launch)`
- `startShellSession`: same pattern
- `writeInput`: stays entirely on the coordinator — it orchestrates state transitions + PTY write + interrupt detection synchronously in one method (!4). Only ~45 lines.
- `resize`, `pauseOutput`, `resumeOutput`: delegate to pty manager
- `stopTaskSession`: still on coordinator (calls `timerManager.suppressAutoRestart`, trust/timer cleanup, then `session.stop()`)
- Remove all moved methods and types

#### Success Criteria

##### Automated
- [ ] `npm run test:fast` passes after 4a
- [ ] `npm run test:fast` passes after 4b
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes

##### Behavioral
- [ ] Start Claude task → agent runs, output streams, transitions work
- [ ] Start Codex task → deferred input delivered, prompt detection works
- [ ] Start shell session → output streams, clean exit
- [ ] `session-manager.ts` is ~250-300 lines

**Checkpoint**: Two commits (4a and 4b separately).

---

### Phase 5: Coordinator Cleanup

#### Overview

Final pass to ensure the coordinator is clean, well-organized, and easy to navigate. No new extractions — this is cleanup of what remains.

#### Changes Required

##### 1. Clean up ProcessEntry

**File**: `src/terminal/session-manager.ts`
**Action**: Modify
**Changes**:
- `ProcessEntry` stays on session-manager (it's the coordinator's internal bookkeeping)
- Remove any fields that are now managed by extracted modules and only stored for forwarding
- Verify `ProcessEntry` is exported (timer manager and PTY manager need it as a type)

##### 2. Verify coordinator method count

**File**: `src/terminal/session-manager.ts`
**Action**: Verify
**Expected methods**:
- `constructor`
- `hydrateFromRecord`
- `attach`
- `getRestoreSnapshot`
- `startTaskSession` (delegates spawn to PTY manager)
- `startShellSession` (delegates spawn to PTY manager)
- `recoverStaleSession`
- `writeInput` (orchestrates state + I/O + timers)
- `resize`, `pauseOutput`, `resumeOutput` (delegate to PTY manager)
- `stopTaskSession`, `stopTaskSessionAndWaitForExit`, `markInterruptedAndStopAll`
- `startReconciliation`, `stopReconciliation`
- `reconcileSessionStates`, `applyReconciliationAction` (private)
- `finalizeProcessExit`, `broadcastToListeners` (private helpers from Phase 1)
- `applySessionEventWithSideEffects` (private, dispatches side effects to trust handler + timer manager)
- `ensureProcessEntry`, `createProcessEntry` (private)
- `hasLiveOutputListener` (private — delegates to PTY manager via callback, but the coordinator is the call site for `TerminalStateMirror.onInputResponse`)

##### 3. Update exports

**File**: `src/terminal/session-manager.ts`
**Action**: Modify
**Changes**:
- Ensure `StartTaskSessionRequest` and `StartShellSessionRequest` are still exported from this file (consumers import them)
- `ActiveProcessState` is defined in `pty-process-manager.ts` (moved in Phase 4b). Export it from there. Update `session-manager.ts` to import it. Do NOT re-export it from `session-manager.ts` — the 4 test fixtures that construct fake `ActiveProcessState` objects use `as unknown as { entries: Map<...> }` casts, which bypass the type import. If any test file does import `ActiveProcessState` by name, update the import path to point to `pty-process-manager.ts`. Avoid re-export chains that hide the canonical source.

#### Success Criteria

##### Automated
- [ ] `npm run test` passes (full suite)
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds

##### Behavioral
- [ ] All 12 functional verification steps from the top of this spec pass
- [ ] `session-manager.ts` is 250-350 lines
- [ ] `wc -l src/terminal/session-timer-manager.ts src/terminal/workspace-trust-handler.ts src/terminal/pty-process-manager.ts` shows ~600-750 total lines in new files

**Checkpoint**: Final commit.

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|---|---|---|
| PTY spawn fails | `formatSpawnFailure` message, state set to `failed` | Existing test in session-manager tests |
| Trust handler receives output after stop | No-op, timer already cleared | Unit test for trust handler |
| Timer fires after session ended | Guard checks entry.active, returns if null | Existing interrupt recovery tests |
| Auto-restart exceeds rate limit | `shouldAutoRestart` returns false | Existing auto-restart tests |

## Rollback Strategy

- **Phase 1 rollback**: `git revert <commit>` — removes helpers, restores inline code
- **Phase 2 rollback**: `git revert <commit>` — removes timer manager, restores inline timer code
- **Phase 3 rollback**: `git revert <commit>` — removes trust handler, restores inline trust code
- **Phase 4 rollback**: `git revert <4b-commit> && git revert <4a-commit>` — two commits to revert
- **Phase 5 rollback**: `git revert <commit>` — cleanup only
- **Full rollback**: Revert all commits in reverse order. Each phase is independent.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| onData ordering broken during Phase 4 | Medium | High (UI shows wrong state) | Phase 4a extracts closures to methods first without moving files. Run tests between 4a and 4b. |
| Test fixtures break when ActiveProcessState changes | Low | Medium (4 tests to fix) | Phase 3 adds `trustHandler` field to ActiveProcessState. Check if test fakes include trust fields — research shows they don't, so adding `trustHandler: null` may be needed. |
| Circular dependency between PTY manager and coordinator | Medium | High (won't compile) | PTY manager takes callbacks, doesn't import session-manager. Timer manager same pattern. |
| writeInput split across coordinator and PTY manager breaks !4 | Medium | High (Codex prompt bug, interrupt detection fails) | Keep writeInput entirely on coordinator. Don't split synchronous sequences across modules. |
| Auto-restart Promise scheduling changes timing | Low | Medium (flaky auto-restart) | Preserve the exact `pendingAutoRestart` assignment pattern. Timer manager returns the Promise, coordinator assigns it. |

## Implementation Notes / Gotchas

- **Don't move `trySendDeferredCodexStartupInput` too early**: It reads trust handler state AND writes to PTY AND checks store. It's a cross-cutting helper. It can move to PTY manager in Phase 4, but only after trust handler is extracted (Phase 3).
- **`stopWorkspaceTrustTimers` import from `claude-workspace-trust.ts`**: After Phase 3, this function is no longer needed in session-manager — the trust handler's `stop()` method replaces it. Remove the import.
- **`clearInterruptRecoveryTimer` helper function**: Currently a module-level function at line 187. After Phase 2, it moves to the timer manager. Remove it from session-manager.
- **`hasLiveOutputListener` method**: Used by `TerminalStateMirror.onInputResponse` callback to decide whether to forward input. It reads `entry.listeners`. The `listeners` Map lives on `ProcessEntry` (coordinator's bookkeeping), so it is passed as a callback in `PtyProcessManagerDeps.hasLiveOutputListener`.
- **Shell sessions have simpler onData/onExit**: Don't over-abstract. The shell onData is ~25 lines (protocol filter, mirror, trust buffer, output update, listener broadcast). It doesn't have transition detection, Codex quirks, or most of the complexity. A shared base with task-specific extensions would be wrong — keep them as separate methods.

## References

- **Refactor plan**: `docs/refactor-session-lifecycle.md` — original analysis and plan (some claims corrected by this spec's research)
- **Related todo**: `docs/todo.md` item #9
- **Key files**:
  - `src/terminal/session-manager.ts` — file under refactor
  - `src/terminal/session-state-machine.ts:1-97` — pure reducer (unchanged)
  - `src/terminal/session-summary-store.ts:1-432` — already extracted store
  - `src/terminal/session-reconciliation.ts:1-155` — already extracted checks
  - `src/terminal/agent-session-adapters.ts:1-438` — adapter hook config
  - `src/terminal/terminal-session-service.ts` — public interface
- **Test files**:
  - `test/runtime/terminal/session-manager.test.ts` — 4 internal-cast tests at risk
  - `test/runtime/terminal/session-manager-reconciliation.test.ts` — public API only
  - `test/runtime/terminal/session-manager-interrupt-recovery.test.ts` — public API only
  - `test/runtime/terminal/session-manager-auto-restart.test.ts` — public API only
  - `test/runtime/terminal/session-reconciliation.test.ts` — pure function tests
- **Test Spec**: `docs/forge/2026-04-12-session-lifecycle-refactor/test-spec.md`
