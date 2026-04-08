# Session State Reconciliation — Implementation Specification

**Date**: 2026-04-08
**Branch**: feature/session-state-reconciliation
**Adversarial Review Passes**: 3
**Test Spec**: [docs/specs/2026-04-08-session-state-reconciliation-tests.md](./2026-04-08-session-state-reconciliation-tests.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
Todo item #7: "Self-healing for stale task status indicators". UI status indicators like "needs perms" and "waiting for approval" can get stuck when the underlying agent state changes in ways the UI doesn't catch — e.g. hitting Escape on a permission prompt dismisses it in the agent but the card still shows "waiting for approval". Add a periodic reconciliation job that polls actual agent/session state and corrects stale UI badges. This should be a general-purpose periodic sync of the UI to actual agent state, not a narrow permission-badge fix. ~10s interval since the checks are lightweight. Related research: docs/research/2026-04-08-branch-display-desync.md (same root cause pattern — live data should beat stale data).
-->

## Goal

Add a periodic session state reconciliation mechanism to `TerminalSessionManager` that detects and corrects drift between the server-side session summary and the actual state of the agent process. Currently, session state is only updated by discrete events (hooks, process exit, interrupts); if an event is missed or a transition doesn't clear stale fields, the UI shows incorrect status badges indefinitely. The reconciliation sweep runs every ~10 seconds, is general-purpose (new checks are trivially addable), and follows the same architectural patterns as the existing stale process watchdog and workspace metadata monitor.

## Behavioral Change Statement

> **BEFORE**: When session state drifts from actual agent state (permission prompt dismissed via Escape, agent self-recovers from a blocked state, hook event missed, process dies in `awaiting_review`), the UI displays stale status badges indefinitely — "Waiting for approval" on a card whose agent is running, "Ready for review" when the agent has resumed, or a live-looking card for a dead process. There is no periodic correction. The stale process watchdog only detects dead PIDs in `state === "running"` sessions.
>
> **AFTER**: Every ~10 seconds, a reconciliation sweep checks all session entries for state drift using ground-truth signals (process liveness, terminal output timestamps, hook activity age, state consistency). Stale badges auto-clear. Dead processes are detected regardless of session state. The mechanism is composable — each check is an independent function, making it straightforward to add new reconciliation rules for future status indicators.
>
> **SCOPE — all code paths affected**:
> 1. **Stale permission badge after Escape**: User hits Escape → `scheduleInterruptRecovery()` fires → `latestHookActivity` persists with permission fields → badge shows "Waiting for approval" on an `attention` review card — `session-manager.ts:800-804`, `session-manager.ts:1286-1310`
> 2. **Agent resumes after `awaiting_review`**: Agent is in `awaiting_review`/`reviewReason: "hook"` → agent produces new terminal output (detectable via `lastOutputAt > lastHookAt`) → no transition fires for Claude/Gemini (no `detectOutputTransition` adapter) → session stays stuck — `session-manager.ts:439`, `session-state-machine.ts:45-57`
> 3. **Process dies in `awaiting_review`**: Process crashes while session is in `awaiting_review` → current watchdog skips it (guard: `state !== "running"`) → dead process invisible — `session-manager.ts:1251-1253`
> 4. **`latestHookActivity` persists across `transitionToRunning`**: `hook.to_in_progress` fires → state becomes `running` but `latestHookActivity` from prior review carries forward → stale tool/permission context on running card — `session-manager.ts:1050-1063`
> 5. **`latestHookActivity` persists across `process.exit`**: Agent exits → state becomes `awaiting_review`/`reviewReason: "exit"` or `"error"` but `latestHookActivity` from last tool use carries forward — `session-manager.ts:478-515`, `session-manager.ts:1267`. **Addressed by reconciliation sweep** (not proactive clearing) because the process exit broadcast path is batched and clearing before flush would lose data needed by notifications.

## Functional Verification

| # | What to do | Expected result | Code path verified |
|---|-----------|----------------|-------------------|
| 1 | Start Claude task → wait for permission prompt → card shows "Waiting for approval" (orange) → press Escape → observe two transitions | **Step A (~5s)**: Interrupt recovery fires → `reviewReason` changes from `"hook"` to `"attention"` → badge **text** changes from "Waiting for approval" to "Waiting for input", but badge **color stays orange** because `latestHookActivity` still has permission fields (`isPermissionRequest()` returns true). **Step B (~15s, next reconciliation sweep)**: `checkStaleHookActivity` clears `latestHookActivity` → `isPermissionRequest()` now returns false → badge **color changes from orange to blue** ("info" style). | Path 1 (Escape dismissal) |
| 2 | Start Claude task → trigger permission hook → before acting, the agent auto-approves and resumes producing output → wait 10s | Badge clears from "Waiting for approval" to "Running" (green). Session transitions back to `running`. | Path 2 (agent resumes from review) |
| 3 | Start Claude task → trigger permission hook → kill the agent process externally (`kill <pid>`) while card shows "Waiting for approval" → wait 10s | Card transitions to "Error" (red) review state. Process death detected despite being in `awaiting_review`. | Path 3 (process dies in review) |
| 4 | Agent is genuinely blocked on permission prompt (no new output, process alive, hook is recent) → wait 10s+ | Badge stays "Waiting for approval". Reconciliation does NOT clear a legitimate blocking state. | Negative test — all paths |
| 5 | Agent finishes normally → card shows "Completed" → wait 10s+ | Badge stays "Completed". Reconciliation does not modify these sessions. Note: `interrupted` sessions (state `"interrupted"`) are excluded by the `isActiveState()` filter and never iterated. Completed sessions (`awaiting_review` with `reviewReason: "exit"`) pass the `isActiveState()` filter and are iterated, but no check matches them — `canReturnToRunning("exit")` returns false. Both are safe. | Negative test — terminal states |
| 6 | Start a running task → `latestHookActivity` shows tool use → agent transitions to running via `hook.to_in_progress` → verify card running activity label | Running activity label reflects current activity, not stale permission context from prior review cycle. | Path 4 (stale activity on running) |
| 7 | Run existing test suites: `npm run test:fast` and `npm run web:test` | All existing tests pass. No regressions. | All paths — regression |

## Current State

### Stale Process Watchdog (the pattern to extend)

- `session-manager.ts:43` — `STALE_PROCESS_CHECK_INTERVAL_MS = 30_000` (30s interval)
- `session-manager.ts:1234-1242` — `startStaleProcessWatchdog()` creates `setInterval` + `unref()`
- `session-manager.ts:1244-1249` — `stopStaleProcessWatchdog()` clears interval
- `session-manager.ts:1251-1284` — `recoverStaleProcesses()` iterates entries, checks `isProcessAlive(pid)`, fires synthetic `process.exit`
- **Limitation**: Only checks `state === "running"` (line 1253), misses dead processes in `awaiting_review`

### Session State Machine

- `session-state-machine.ts:3-8` — 5 event types: `hook.to_review`, `hook.to_in_progress`, `agent.prompt-ready`, `process.exit`, `interrupt.recovery`
- `session-state-machine.ts:27-92` — `reduceSessionTransition()` pure reducer
- `session-state-machine.ts:16-18` — `canReturnToRunning()` gates: only `attention`, `hook`, `error` can return to running

### `latestHookActivity` Lifecycle

- **Set**: `session-manager.ts:947-949` via `applyHookActivity()` — merges partial activity, updates `lastHookAt`
- **Cleared to null**: `session-manager.ts:862` (before hook transition), `session-manager.ts:582` (session start), `session-manager.ts:767` (stale recovery)
- **NOT cleared** (pre-change): `transitionToRunning()` (line 1056), `process.exit` handler (line 490), `interrupt.recovery` (line 1304), `agent.prompt-ready` (via state machine)
- **Phase 3 adds clearing to**: `transitionToRunning()`, `applyReconciliationAction("resume_from_review")`
- **Intentionally NOT cleared by Phase 3**: `process.exit` handler — the batched summary broadcast path (runtime-state-hub.ts:150-163) would propagate the cleared value before notifications consume `finalMessage`. The reconciliation sweep handles this case instead.

### Downstream Consumers (all null-safe)

- `session-status.ts:5-21` — `isApprovalState()` / `isPermissionRequest()` — returns `false` when null
- `use-audible-notifications.ts:68-89` — `resolveSessionSoundEvent()` — falls back to "review" sound, has 500ms settle window
- `use-review-ready-notifications.ts:50-51` — falls back to task title for notification body
- `board-card.tsx:120-145` — `getRunningActivityLabel()` — returns `null` when activity is null (only active for `state === "running"`)
- `app-router.ts:490,533` — title/summary generation — falls back to `conversationSummaries`
- Card detail sidebar — does NOT read `latestHookActivity`

## Desired End State

1. **A single `reconcileSessionStates()` method** on `TerminalSessionManager` that runs every 10 seconds, iterating all session entries and applying a series of independent, composable reconciliation checks.

2. **The existing `recoverStaleProcesses()` is absorbed** into the reconciliation sweep (it becomes one of the checks), and the 30s stale process interval is retired in favor of the 10s reconciliation interval. The dead-PID check also extends to `awaiting_review` sessions.

3. **New reconciliation checks** detect and correct:
   - Stale `latestHookActivity` on sessions that have transitioned away from the state that set it
   - Sessions in `awaiting_review` with `reviewReason: "hook"` where the agent is producing output (`lastOutputAt > lastHookAt`)
   - Dead processes in any active state (not just `running`)

4. **Each check is a pure function** that takes a session entry and returns either `null` (no correction needed) or a correction action. The sweep applies corrections and broadcasts updated summaries. Adding a new check = adding one function to the array.

5. **The UI requires no changes**. Corrections flow through the existing `emitSummary()` → `RuntimeStateHub` → `task_sessions_updated` WebSocket → `mergeTaskSessionSummaries()` pipeline. All consumers already handle null `latestHookActivity`.

## Out of Scope

- Agent-side changes (no modifications to Claude/Codex/Gemini hook emission)
- UI-side polling or display-layer fixes (the branch desync is a separate fix)
- Changing the state machine transitions or adding new event types
- Adding new session summary fields
- Modifying the existing `interrupt.recovery` or `transitionToReview` paths (those work correctly for their designed purpose; reconciliation handles the gaps they leave)

## Dependencies

- **Teams**: None — self-contained runtime change
- **Services**: None
- **Data**: None — no migration, no persisted format changes
- **Timing**: None — can ship independently

## New Dependencies & Configuration

None. No new packages, no configuration changes, no feature flags. The reconciliation interval constant is the only new tunable.

## Architecture & Approach

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Reconciliation location | Inside `TerminalSessionManager` | Owns session entries, has all ground-truth signals, already has the watchdog pattern | Separate `SessionReconciler` class | Must use the same `entries` Map and `emitSummary()` pipeline |
| Absorb stale process watchdog | Yes — merge into reconciliation sweep | Eliminates a separate timer, reduces interval from 30s to 10s, dead-PID check benefits from running more frequently | Keep separate timer alongside reconciliation | Must preserve all existing watchdog behavior and test coverage |
| Reconciliation interval | 10 seconds (`SESSION_RECONCILIATION_INTERVAL_MS`) | Lightweight checks (PID signal-0, timestamp comparisons) make 10s feasible. Fast enough to feel "self-healing" to the user, slow enough to be invisible in profiling. | 5s (too frequent for near-zero-cost checks), 30s (too slow — user waits half a minute for stale badge to clear) | Timer must use `unref()` to not block shutdown |
| Check architecture | Array of pure check functions | Composable, testable independently, trivial to extend. Each check receives a `SessionEntry` + `now` timestamp and returns a `ReconciliationAction` or `null`. | Single monolithic `reconcile()` method | Each check must be stateless — no side effects, no reading other entries |
| `latestHookActivity` clearing strategy | Clear to `null` when stale | Established precedent (`transitionToReview:862`, `recoverStaleSession:767`). All 8 downstream consumers are null-safe. | Clear individual fields (e.g., null out `hookEventName` but keep `activityText`) | MUST NOT clear during legitimate blocking states — check `lastOutputAt > lastHookAt` AND age threshold |
| Stale output heuristic | `lastOutputAt > lastHookAt` within active session | If terminal output arrived after the last hook, the agent is working. This is agent-agnostic — works for Claude, Codex, Gemini, OpenCode without adapter-specific logic. | Per-adapter heuristics | `lastOutputAt` can be null if no output yet — skip check when null |
| State transition for output-after-review | Use existing `hook.to_in_progress` event | Reuses the state machine's existing transition path. No new event type needed. The guard `canReturnToRunning(reviewReason)` already allows `hook`, `attention`, `error` to return to running. | New `reconciliation.resume` event type | Only apply when `canReturnToRunning(reviewReason)` is `true` — don't try to resume `exit` or `interrupted` sessions |

### Reconciliation Check Design

Each check is a function with this signature:

```typescript
type ReconciliationCheck = (
   entry: SessionEntry,
   nowMs: number,
) => ReconciliationAction | null;
```

Where `ReconciliationAction` is a discriminated union:

```typescript
type ReconciliationAction =
   | { type: "clear_hook_activity" }
   | { type: "resume_from_review" }
   | { type: "recover_dead_process" };
```

The sweep iterates entries, runs each check, and applies the **first** non-null action (checks are ordered by priority: dead process > resume > clear activity). After applying, the updated summary is emitted through the standard broadcast pipeline.

**Adding a new check in the future**: Define a new function matching `ReconciliationCheck`, add it to the array, optionally add a new action variant. No other code changes needed.

## Implementation Phases

### Phase 1: Define reconciliation types and check functions

#### Overview

Introduce the reconciliation check architecture as pure, testable functions. No timer yet — these are unit-testable building blocks.

#### Changes Required

##### 1. New reconciliation checks module

**File**: `src/terminal/session-reconciliation.ts` (new file)
**Action**: Create

**Contents**:
- Export `ReconciliationAction` type (discriminated union: `clear_hook_activity`, `resume_from_review`, `recover_dead_process`)
- Export `ReconciliationCheck` function type
- Export `checkDeadProcess(entry, nowMs)`: Returns `recover_dead_process` if:
  - `entry.summary.state` is `"running"` or `"awaiting_review"` (extends current watchdog to cover `awaiting_review`)
  - `entry.active` is truthy (has an active process handle)
  - `entry.summary.pid` is not null
  - `isProcessAlive(entry.summary.pid)` returns `false`
- Export `checkOutputAfterReview(entry, nowMs)`: Returns `resume_from_review` if:
  - `entry.summary.state === "awaiting_review"`
  - `canReturnToRunning(entry.summary.reviewReason)` is `true` (i.e., reason is `hook`, `attention`, or `error`)
  - `entry.summary.lastOutputAt` is not null
  - `entry.summary.lastHookAt` is not null
  - `entry.summary.lastOutputAt > entry.summary.lastHookAt`
  - Time since `lastOutputAt` is < 30 seconds (output is recent, not a historical timestamp from before the review)
- Export `isPermissionActivity(activity: RuntimeTaskHookActivity): boolean`: Shared helper that returns `true` when the hook activity contains permission-related fields. `RuntimeTaskHookActivity` is the existing Zod-inferred type from `api-contract.ts`. Uses **case-insensitive matching** to mirror the UI's `isPermissionRequest()` in `web-ui/src/utils/session-status.ts:10-20`:
  - `activity.hookEventName?.toLowerCase() === "permissionrequest"`
  - OR `activity.notificationType?.toLowerCase() === "permission_prompt"`
  - OR `activity.notificationType?.toLowerCase() === "permission.asked"`
  - OR `activity.activityText?.toLowerCase() === "waiting for approval"`
  - **Note**: This duplicates the UI's `isPermissionRequest()` logic. Both functions must stay in sync. A future refactor should extract a shared utility importable by both server and UI (the current `session-status.ts` lives under `web-ui/` and cannot be imported server-side). Track as a follow-up.
- Export `checkStaleHookActivity(entry, nowMs)`: Returns `clear_hook_activity` if:
  - `entry.summary.latestHookActivity` is not null
  - AND one of:
    - `entry.summary.state === "running"` and `isPermissionActivity(entry.summary.latestHookActivity)` returns `true` — stale permission context on a running card
    - `entry.summary.state === "awaiting_review"` and `entry.summary.reviewReason !== "hook"` and `isPermissionActivity(entry.summary.latestHookActivity)` returns `true` — permission badge on a non-hook review (e.g., `attention` after Escape)
    - `entry.summary.state === "awaiting_review"` and `entry.summary.reviewReason === "hook"` and `entry.summary.lastOutputAt` is not null and `entry.summary.lastHookAt` is not null and `lastOutputAt > lastHookAt` and `nowMs - lastOutputAt < 30_000` — agent producing output while supposedly blocked. (Note: this condition is a strict subset of `checkOutputAfterReview`'s conditions and is unreachable in normal sweep execution because `checkOutputAfterReview` runs first and would match. It is retained as intentional defense-in-depth for cases where the check order might change or `checkStaleHookActivity` is called independently.)
- Export `reconciliationChecks` array: `[checkDeadProcess, checkOutputAfterReview, checkStaleHookActivity]` — ordered by priority
- Import `isProcessAlive` (extract from session-manager.ts to make it importable, or re-implement the same `process.kill(pid, 0)` pattern)

**Code Pattern to Follow**: The pure-function-returning-action pattern is similar to `reduceSessionTransition()` in `session-state-machine.ts:27-92` — take state in, return a typed result, let the caller handle side effects.

##### 2. Extract `isProcessAlive` for reuse

**File**: `src/terminal/session-manager.ts`
**Action**: Modify
**Location**: `isProcessAlive` function at line 219-226
**Changes**:
- Move `isProcessAlive` to `src/terminal/session-reconciliation.ts` and export it
- Import it back into `session-manager.ts`
- This avoids duplicating the function while keeping it available to the reconciliation module

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] Existing tests pass: `npm run test:fast`

##### Behavioral

- [ ] Each check function can be tested in isolation with mock `SessionEntry` data
- [ ] `checkDeadProcess` returns `recover_dead_process` for a dead PID in both `running` and `awaiting_review` states
- [ ] `checkOutputAfterReview` returns `resume_from_review` only when output is more recent than the last hook AND within 30s
- [ ] `checkStaleHookActivity` returns `clear_hook_activity` for permission fields on non-permission states

**Checkpoint**: Pause here for verification before proceeding to Phase 2.

---

### Phase 2: Integrate reconciliation sweep into TerminalSessionManager

#### Overview

Wire the check functions into a periodic sweep, absorb the stale process watchdog, and broadcast corrections through the existing pipeline.

#### Changes Required

##### 1. Replace stale process watchdog with reconciliation sweep

**File**: `src/terminal/session-manager.ts`
**Action**: Modify

**Changes**:

a) **Add constant** (near line 43):
```typescript
const SESSION_RECONCILIATION_INTERVAL_MS = 10_000;
```

b) **Rename timer field** (line 238): Change `staleProcessCheckTimer` to `reconciliationTimer` (or add a new field and remove the old one).

c) **Replace `startStaleProcessWatchdog()`** (line 1234) with `startReconciliation()`:
- Same guard pattern (check if timer already exists)
- `setInterval(() => this.reconcileSessionStates(), SESSION_RECONCILIATION_INTERVAL_MS)`
- `timer.unref()`

d) **Replace `stopStaleProcessWatchdog()`** (line 1244) with `stopReconciliation()`:
- Same pattern — clear interval, null the field

e) **Add `reconcileSessionStates()` method** (replaces `recoverStaleProcesses()`):
```typescript
private reconcileSessionStates(): void {
    const nowMs = Date.now();
    for (const entry of this.entries.values()) {
        try {
            // Skip idle/inactive sessions — nothing to reconcile
            if (!isActiveState(entry.summary.state)) {
                continue;
            }
            // Run checks in priority order, apply first match
            for (const check of reconciliationChecks) {
                const action = check(entry, nowMs);
                if (action) {
                    this.applyReconciliationAction(entry, action);
                    break; // One correction per entry per sweep
                }
            }
        } catch (err) {
            // Per-entry error isolation: a poisoned entry must not prevent
            // checking remaining entries. Log and continue.
            console.error(`[reconciliation] Error processing ${entry.summary.taskId}:`, err);
        }
    }
}
```

f) **Add `applyReconciliationAction()` method**:
```typescript
private applyReconciliationAction(entry: SessionEntry, action: ReconciliationAction): void {
    switch (action.type) {
        case "recover_dead_process": {
            // Existing logic from recoverStaleProcesses(), extracted here.
            // NOTE: Pre-existing gap intentionally preserved — pendingExitResolvers
            // are not drained here (unlike the normal onExit handler at line 502-505).
            // This matches current recoverStaleProcesses() behavior. Track as a
            // separate follow-up fix.
            if (!entry.active) break;
            stopWorkspaceTrustTimers(entry.active);
            clearInterruptRecoveryTimer(entry.active);
            const cleanupFn = entry.active.onSessionCleanup;
            entry.active.onSessionCleanup = null;
            const summary = this.applySessionEvent(entry, {
                type: "process.exit",
                exitCode: null,
                interrupted: false,
            });
            for (const listener of entry.listeners.values()) {
                listener.onState?.(cloneSummary(summary));
                listener.onExit?.(null);
            }
            entry.active = null;
            this.emitSummary(summary);
            if (cleanupFn) {
                cleanupFn().catch(() => {});
            }
            break;
        }
        case "resume_from_review": {
            // Clear stale hook activity before transitioning — this action bypasses
            // transitionToRunning() (which has its own clearing in Phase 3), so we
            // must clear explicitly here.
            if (entry.summary.latestHookActivity) {
                updateSummary(entry, { latestHookActivity: null });
            }
            // Capture reference BEFORE applySessionEvent, which replaces entry.summary
            // via updateSummary(). Without this, `summary === entry.summary` is always
            // true and the listener notification + emitSummary() would never execute.
            // This mirrors the pattern in transitionToRunning() (line 1055).
            const before = entry.summary;
            const summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
            if (summary !== before && entry.active) {
                for (const listener of entry.listeners.values()) {
                    listener.onState?.(cloneSummary(summary));
                }
                this.emitSummary(summary);
            }
            break;
        }
        case "clear_hook_activity": {
            // Always emit even when entry.active is null — hydrated entries
            // (from persisted state after reconnect) may have stale
            // latestHookActivity that needs clearing for display correctness.
            const summary = updateSummary(entry, { latestHookActivity: null });
            if (entry.active) {
                for (const listener of entry.listeners.values()) {
                    listener.onState?.(cloneSummary(summary));
                }
            }
            this.emitSummary(summary);
            break;
        }
    }
}
```

g) **Remove `recoverStaleProcesses()`** (lines 1251-1284) — its logic is now in `applyReconciliationAction` case `recover_dead_process` + `checkDeadProcess`.

##### 2. Update workspace-registry.ts callsite

**File**: `src/server/workspace-registry.ts`
**Action**: Modify
**Location**: Line 243 (`manager.startStaleProcessWatchdog()`)
**Changes**: Rename to `manager.startReconciliation()`

##### 3. Update shutdown callsite

**File**: `src/server/shutdown-coordinator.ts`
**Action**: Modify
**Location**: Line 162 (`terminalManager.stopStaleProcessWatchdog()`)
**Changes**: Rename to `terminalManager.stopReconciliation()`

##### 4. Update existing test files that reference old method names

**File**: `test/runtime/terminal/session-manager-interrupt-recovery.test.ts`
**Action**: Modify
**Location**: Lines 306, 315 (`manager.startStaleProcessWatchdog()` / `manager.stopStaleProcessWatchdog()`)
**Changes**: Rename to `manager.startReconciliation()` / `manager.stopReconciliation()`

**File**: `test/integration/shutdown-coordinator.integration.test.ts`
**Action**: Modify
**Location**: Line 139 (`stopStaleProcessWatchdog: () => {}`)
**Changes**: Rename to `stopReconciliation: () => {}`

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] All tests pass: `npm run test:fast`

##### Behavioral

- [ ] Reconciliation runs every 10s (observable via debug logging or timer inspection in tests)
- [ ] Dead process in `running` state detected (existing behavior preserved)
- [ ] Dead process in `awaiting_review` state detected (new behavior)
- [ ] Session in `awaiting_review` with recent output after hook transitions back to `running`
- [ ] Stale `latestHookActivity` cleared on non-hook review states
- [ ] Legitimate `awaiting_review` with `reviewReason: "hook"` and no new output is NOT cleared
- [ ] Terminal states (`exit`, `interrupted`) are not touched

##### Manual

- [ ] Start a Claude task, trigger permission prompt, press Escape — badge clears within ~10s
- [ ] Start a Claude task, let it complete normally — "Completed" badge persists indefinitely

**Checkpoint**: Pause here for verification before proceeding to Phase 3.

---

### Phase 3: Clear `latestHookActivity` on outbound transitions

#### Overview

In addition to periodic reconciliation, proactively clear `latestHookActivity` on transitions that currently leave it stale. This reduces the window of staleness from "up to 10s" to "immediate" for transitions that the server already knows about.

#### Changes Required

##### 1. Clear `latestHookActivity` in `transitionToRunning()`

**File**: `src/terminal/session-manager.ts`
**Action**: Modify
**Location**: `transitionToRunning()` at line 1050-1063
**Changes**:
- Before calling `applySessionEvent`, clear `latestHookActivity`:
```typescript
if (entry.summary.latestHookActivity) {
    updateSummary(entry, { latestHookActivity: null });
}
```
- This mirrors the existing pattern in `transitionToReview()` (line 861-862)
- **Why**: When an agent transitions to running, the old hook activity (permission prompt, tool context) from the prior review cycle is no longer relevant. The next hook event will repopulate it with current data.

##### ~~2. Clear `latestHookActivity` on process exit~~ — REMOVED

Process exit clearing is intentionally omitted from Phase 3. The process exit path goes through `emitSummary()` → `queueTaskSessionSummaryBroadcast()` → batched flush (runtime-state-hub.ts:150-163). The `broadcastTaskReadyForReview` message is only emitted from the hook path (hooks-api.ts:145), NOT the process exit path. Clearing `latestHookActivity` before the batched summary flush would propagate the cleared value to UI consumers, potentially degrading notification body content and summary generation that reads `finalMessage` from the activity.

Instead, the Phase 1 reconciliation sweep handles stale `latestHookActivity` after process exit: sessions in `awaiting_review` with `reviewReason: "exit"` or `"error"` and stale permission fields will be cleared by `checkStaleHookActivity`. The 10-second delay is acceptable because the `reviewReason` alone drives the correct card display state — the stale `latestHookActivity` is cosmetic at that point.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] All tests pass: `npm run test:fast` and `npm run web:test`

##### Behavioral

- [ ] When agent transitions to running via `hook.to_in_progress`, `latestHookActivity` is null until the next hook fires
- [ ] Running activity label on cards shows fresh data from new hooks, not stale data from prior review
- [ ] When agent process exits, `latestHookActivity` is preserved through the exit path (notifications and summaries can still read `finalMessage`). The reconciliation sweep clears it on the next tick if stale.

**Checkpoint**: Verification complete.

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| `isProcessAlive` throws unexpected error | Catch returns `false` (process assumed dead) — existing behavior at `session-manager.ts:219-226` | Unit test with mocked `process.kill` that throws non-ESRCH error |
| `reconcileSessionStates` throws during iteration | Individual entry error should not prevent checking remaining entries. Wrap per-entry logic in try/catch. | Unit test with a poisoned entry followed by a valid one |
| `applySessionEvent` returns unchanged summary | No broadcast emitted — existing guard in state machine (`transition.changed === false`) | Unit test applying `hook.to_in_progress` to a session already in `running` state |
| Timer fires during shutdown | `reconciliationTimer.unref()` prevents blocking. `stopReconciliation()` called during graceful shutdown clears the interval. | Integration test: start reconciliation, call stop, verify no further ticks |

## Rollback Strategy

- **Phase 1 rollback**: Delete `src/terminal/session-reconciliation.ts`. No other files affected.
- **Phase 2 rollback**: Revert `session-manager.ts` to restore `recoverStaleProcesses()` and `startStaleProcessWatchdog()`/`stopStaleProcessWatchdog()`. Revert `workspace-registry.ts` callsite. The reconciliation module can remain as dead code or be deleted.
- **Phase 3 rollback**: Remove the `latestHookActivity` clearing in `transitionToRunning()`. This is an isolated 3-line addition.
- **Full rollback**: `git revert` the feature branch merge. No data migration, no schema changes, no external dependencies.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| False positive: reconciliation clears a legitimate permission badge | Low | Medium — user misses that agent needs approval | Guard: only clear when `lastOutputAt > lastHookAt` (agent is producing output) or `reviewReason !== "hook"`. A genuinely blocked agent produces no output. Also require recent output (within 30s) to avoid acting on stale timestamps. **Accepted risk**: terminal keep-alive output (cursor blinks, heartbeat sequences) could trigger a false-positive resume. If the agent actually blocks again, the next hook re-transitions the session. |
| Existing tests break due to watchdog rename | Medium | Low — test failures, not production impact | Update the 3 callsites: `session-manager-interrupt-recovery.test.ts:306,315` and `shutdown-coordinator.integration.test.ts:139`. These are method renames only, not fixture changes. |
| Audible notification plays wrong sound | Low | Low — "review" sound instead of "permission" sound for sessions that are genuinely transitioning | The 500ms settle window in `use-audible-notifications.ts` already handles transient null states. Reconciliation only fires after 10s, well past the settle window. |
| Race between reconciliation and incoming hook | Low | Low — reconciliation might clear `latestHookActivity` right before a new hook repopulates it | Hooks always write `latestHookActivity` via `applyHookActivity()`, which unconditionally sets the field. Even if reconciliation clears it, the next hook restores it on the same tick or next. |

## Implementation Notes / Gotchas

- **`isActiveState` guard**: The reconciliation sweep uses `isActiveState()` (line 158: returns true for `running` and `awaiting_review`) to skip `idle`, `failed`, and `interrupted` sessions. These are terminal/dormant states with nothing to reconcile. Specifically:
  - `idle` — no session started yet, nothing to check.
  - `failed` — spawn failure; both occurrences (session-manager.ts:527-538 and :689-700) explicitly set `latestHookActivity: null`, `pid: null`, and `active` is never assigned. No stale state possible.
  - `interrupted` — terminal state from `process.exit` with `interrupted: true`. Process is dead, no further transitions expected.
- **`reconcileSessionStates` must remain synchronous (no `await`)**: The sweep iterates the `entries` Map and mutates entries in-place. If the method were `async` or yielded between iterations, an incoming hook or process exit could mutate the same entry mid-sweep, causing inconsistent state. All check functions are synchronous (PID signal-0, timestamp comparisons) and `applyReconciliationAction` is synchronous, so there is no reason to introduce `async`.
- **One action per entry per sweep**: Running all checks but applying only the first match prevents cascading corrections in a single tick. Dead process recovery should take priority since it changes the most state.
- **`updateSummary` bumps `updatedAt`**: Every correction updates the `updatedAt` timestamp, which flows to the UI's `mergeTaskSessionSummaries()` monotonic merge. This ensures the UI accepts the correction (it only accepts summaries with higher `updatedAt`).
- **Test fixture sensitivity**: Per AGENTS.md, avoid touching test fixture mocks broadly. The reconciliation tests should use their own `createSummary()` factory, not modify shared fixtures. Import `reconciliationChecks` and test them as pure functions against hand-crafted entries.
- **Board state single-writer rule**: The reconciliation corrects server-side session summaries, NOT board state. Session summaries flow through `RuntimeStateHub` → WebSocket → UI, which re-renders based on the new summary. The UI remains the single writer of board state. No `mutateWorkspaceState` calls needed.
- **`isProcessAlive` extraction**: When moving `isProcessAlive` to the reconciliation module, ensure the function signature stays identical. It's used directly in `recoverStaleProcesses` (being absorbed) and nowhere else — but verify with `grep` before removing the original.

## References

- **Related files**:
  - `src/terminal/session-manager.ts:1234-1310` — existing watchdog and interrupt recovery
  - `src/terminal/session-state-machine.ts` — pure state reducer
  - `src/terminal/session-reconciliation.ts` — new file (this spec)
  - `src/server/workspace-metadata-monitor.ts:352-404` — reference pattern for periodic polling
  - `web-ui/src/utils/session-status.ts` — UI consumer of reconciliation results
  - `docs/research/2026-04-08-branch-display-desync.md` — related desync pattern (on `research/branch-display-desync` branch)
- **Prior art**: `recoverStaleProcesses()` (being absorbed), `workspace-metadata-monitor` (architectural pattern)
- **Test Spec**: [docs/specs/2026-04-08-session-state-reconciliation-tests.md](./2026-04-08-session-state-reconciliation-tests.md)
