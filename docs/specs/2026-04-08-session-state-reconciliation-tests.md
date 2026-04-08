# Test Specification: Session State Reconciliation

**Date**: 2026-04-08
**Companion SDD**: [docs/specs/2026-04-08-session-state-reconciliation.md](./2026-04-08-session-state-reconciliation.md)
**Adversarial Review Passes**: 3

## Test Strategy

The reconciliation mechanism has two distinct testing layers:

1. **Pure function tests**: Each reconciliation check is a stateless function that takes an entry + timestamp and returns an action. These are trivially unit-testable with hand-crafted session entries — no mocks, no timers, no PTY.
2. **Integration tests**: The sweep timer, action application, and broadcast pipeline require `vi.useFakeTimers()` and mock PTY sessions, following the pattern established in `session-manager-interrupt-recovery.test.ts`.

### Test Infrastructure

- **Framework**: Vitest (node environment)
- **Test directories**: `test/runtime/terminal/` for backend, `web-ui/src/` colocated for frontend
- **Run command**: `npx vitest run test/runtime/terminal/session-reconciliation.test.ts test/runtime/terminal/session-manager-reconciliation.test.ts`
- **CI integration**: Covered by `npm run test:fast` (includes `test/runtime/`)

### Coverage Goals

- Every reconciliation check has tests for: trigger condition, each guard that prevents triggering, boundary cases
- Every action type has tests for correct state mutation and broadcast
- The sweep timer lifecycle (start/stop/interval) is tested
- Existing stale process watchdog behavior is preserved after absorption
- Minimal modifications to existing test files (method renames only — `startStaleProcessWatchdog` → `startReconciliation`, `stopStaleProcessWatchdog` → `stopReconciliation`)

## Unit Tests

### Reconciliation Check Functions

**Test file**: `test/runtime/terminal/session-reconciliation.test.ts`
**Pattern to follow**: Pure function testing like `session-state-machine.ts` tests in `session-manager-interrupt-recovery.test.ts:319+` — no mocks, just input→output assertions.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `checkDeadProcess returns recover_dead_process for dead PID in running state` | Dead process detection for running sessions (existing behavior) |
| 2 | `checkDeadProcess returns recover_dead_process for dead PID in awaiting_review state` | Dead process detection extended to awaiting_review (new behavior) |
| 3 | `checkDeadProcess returns null for alive PID` | Living processes are not touched |
| 4 | `checkDeadProcess returns null when pid is null` | Sessions without a PID (pre-spawn or post-cleanup) are skipped |
| 5 | `checkDeadProcess returns null when entry.active is falsy` | No active process handle means nothing to recover |
| 6 | `checkDeadProcess returns null for idle state` | Idle sessions are skipped |
| 6a | `checkDeadProcess returns null for failed state` | Failed sessions always have null `latestHookActivity` and null `pid` (session-manager.ts:527-538, :689-700) — nothing to reconcile |
| 7 | `checkOutputAfterReview returns resume_from_review when output is after hook` | Core heuristic: output after last hook means agent is working |
| 8 | `checkOutputAfterReview returns null when lastOutputAt is before lastHookAt` | No new output since hook — agent may still be blocked |
| 9 | `checkOutputAfterReview returns null when state is not awaiting_review` | Only applies to review states |
| 10 | `checkOutputAfterReview returns null when reviewReason is exit` | Terminal review reasons cannot return to running |
| 11 | `checkOutputAfterReview returns null when reviewReason is interrupted` | Terminal review reasons cannot return to running |
| 12 | `checkOutputAfterReview returns null when lastOutputAt is null` | No output ever received — can't determine if agent is active |
| 13 | `checkOutputAfterReview returns null when lastHookAt is null` | No hook ever received — can't compare timestamps |
| 14 | `checkOutputAfterReview returns null when output is older than 30s` | Stale output timestamp from before the review — not evidence of current activity |
| 14a | `checkOutputAfterReview returns null when output is exactly 30s old` | Boundary: output at exactly the 30s threshold is not recent enough (guard is `< 30_000`, not `<=`) |
| 15 | `checkOutputAfterReview returns resume_from_review for reviewReason hook` | Hook-based reviews can be resumed |
| 16 | `checkOutputAfterReview returns resume_from_review for reviewReason attention` | Attention-based reviews can be resumed |
| 17 | `checkOutputAfterReview returns resume_from_review for reviewReason error` | Error-based reviews can be resumed |
| 18 | `checkStaleHookActivity returns clear_hook_activity for permission fields on attention review` | Escape-dismissal case: permission badge on non-hook review |
| 19 | `checkStaleHookActivity returns clear_hook_activity for permission fields on running state` | Stale permission context carried into running state |
| 20 | `checkStaleHookActivity returns null when latestHookActivity is null` | Nothing to clear |
| 21 | `checkStaleHookActivity returns null for legitimate hook review with permission fields` | Genuine permission prompt with no contradicting signals |
| 22 | `checkStaleHookActivity returns clear_hook_activity for hook review with recent output` | Agent producing output while supposedly blocked on permission |
| 23 | `checkStaleHookActivity returns null for non-permission hook activity on running state` | Normal tool activity on running card should persist |
| 23a | `checkStaleHookActivity returns clear_hook_activity for permission fields on exit review` | SDD path 5: permission badge stale after process exit |
| 23b | `checkStaleHookActivity returns clear_hook_activity for permission fields on error review` | SDD path 5: permission badge stale after process exit with error |
| 24 | `reconciliationChecks are ordered by priority` | Dead process check runs before resume, resume before clear |
| 24a | `isPermissionActivity returns true for hookEventName "PermissionRequest"` | Matches `hookEventName` condition |
| 24b | `isPermissionActivity returns true for notificationType "permission_prompt"` | Matches first `notificationType` condition |
| 24c | `isPermissionActivity returns true for notificationType "permission.asked"` | Matches second `notificationType` condition |
| 24d | `isPermissionActivity returns true for activityText "Waiting for approval"` | Matches `activityText` condition |
| 24e | `isPermissionActivity is case-insensitive` | Mixed-case values like `"permissionRequest"`, `"PERMISSION_PROMPT"` match | 
| 24f | `isPermissionActivity returns false for non-matching activity` | Activity with `hookEventName: "ToolUse"` and `activityText: "Running bash"` does not match |
| 24g | `isPermissionActivity returns false for null/undefined fields` | Activity with all relevant fields null/undefined returns false without throwing |

#### Test Details

##### 24a. `isPermissionActivity returns true for hookEventName "PermissionRequest"`

**Setup**: `activity = { hookEventName: "PermissionRequest", notificationType: null, activityText: null, source: "claude" }`

**Action**: `isPermissionActivity(activity)`

**Assertions**: Returns `true`

##### 24b. `isPermissionActivity returns true for notificationType "permission_prompt"`

**Setup**: `activity = { hookEventName: null, notificationType: "permission_prompt", activityText: null, source: "claude" }`

**Action**: `isPermissionActivity(activity)`

**Assertions**: Returns `true`

##### 24c. `isPermissionActivity returns true for notificationType "permission.asked"`

**Setup**: `activity = { hookEventName: null, notificationType: "permission.asked", activityText: null, source: "claude" }`

**Action**: `isPermissionActivity(activity)`

**Assertions**: Returns `true`

##### 24d. `isPermissionActivity returns true for activityText "Waiting for approval"`

**Setup**: `activity = { hookEventName: null, notificationType: null, activityText: "Waiting for approval", source: "claude" }`

**Action**: `isPermissionActivity(activity)`

**Assertions**: Returns `true`

##### 24e. `isPermissionActivity is case-insensitive`

**Setup**: Test with mixed-case values:
- `{ hookEventName: "permissionrequest" }` → `true`
- `{ hookEventName: "PERMISSIONREQUEST" }` → `true`
- `{ notificationType: "Permission_Prompt" }` → `true`
- `{ activityText: "WAITING FOR APPROVAL" }` → `true`

**Action**: `isPermissionActivity(activity)` for each

**Assertions**: All return `true`

##### 24f. `isPermissionActivity returns false for non-matching activity`

**Setup**: `activity = { hookEventName: "ToolUse", notificationType: "tool_use", activityText: "Running bash", source: "claude" }`

**Action**: `isPermissionActivity(activity)`

**Assertions**: Returns `false`

##### 24g. `isPermissionActivity returns false for null/undefined fields`

**Setup**: `activity = { hookEventName: null, notificationType: null, activityText: null, source: "claude" }`

**Action**: `isPermissionActivity(activity)`

**Assertions**: Returns `false` — no exception thrown

##### 1. `checkDeadProcess returns recover_dead_process for dead PID in running state`

**Setup**: Create a session entry with:
- `summary.state: "running"`, `summary.pid: 999_999_999` (non-existent PID)
- `active: {}` (truthy — minimal mock, only existence matters)

**Action**: `checkDeadProcess(entry, Date.now())`

**Assertions**:
- Returns `{ type: "recover_dead_process" }`

##### 2. `checkDeadProcess returns recover_dead_process for dead PID in awaiting_review state`

**Setup**: Same as #1 but `summary.state: "awaiting_review"`, `summary.reviewReason: "hook"`

**Action**: `checkDeadProcess(entry, Date.now())`

**Assertions**:
- Returns `{ type: "recover_dead_process" }`

##### 7. `checkOutputAfterReview returns resume_from_review when output is after hook`

**Setup**: Create a session entry with:
- `summary.state: "awaiting_review"`, `summary.reviewReason: "hook"`
- `summary.lastHookAt: 1000`, `summary.lastOutputAt: 2000`
- `nowMs: 2500` (output is within 30s window)

**Action**: `checkOutputAfterReview(entry, 2500)`

**Assertions**:
- Returns `{ type: "resume_from_review" }`

##### 14. `checkOutputAfterReview returns null when output is older than 30s`

**Setup**: Create a session entry with:
- `summary.state: "awaiting_review"`, `summary.reviewReason: "hook"`
- `summary.lastHookAt: 1000`, `summary.lastOutputAt: 2000`
- `nowMs: 35_000` (output is >30s ago)

**Action**: `checkOutputAfterReview(entry, 35_000)`

**Assertions**:
- Returns `null`

##### 14a. `checkOutputAfterReview returns null when output is exactly 30s old`

**Setup**: Create a session entry with:
- `summary.state: "awaiting_review"`, `summary.reviewReason: "hook"`
- `summary.lastHookAt: 1000`, `summary.lastOutputAt: 2000`
- `nowMs: 32_000` (`nowMs - lastOutputAt` = 30_000, exactly at the boundary)

**Action**: `checkOutputAfterReview(entry, 32_000)`

**Assertions**:
- Returns `null` — the guard requires `nowMs - lastOutputAt < 30_000` (strictly less than), so exactly 30_000ms is not recent enough

##### 18. `checkStaleHookActivity returns clear_hook_activity for permission fields on attention review`

**Setup**: Create a session entry with:
- `summary.state: "awaiting_review"`, `summary.reviewReason: "attention"`
- `summary.latestHookActivity: { hookEventName: "PermissionRequest", notificationType: null, activityText: "Waiting for approval", ... }`

**Action**: `checkStaleHookActivity(entry, Date.now())`

**Assertions**:
- Returns `{ type: "clear_hook_activity" }`

##### 22. `checkStaleHookActivity returns clear_hook_activity for hook review with recent output`

**Setup**: Create a session entry with:
- `summary.state: "awaiting_review"`, `summary.reviewReason: "hook"`
- `summary.latestHookActivity: { hookEventName: "PermissionRequest", ... }`
- `summary.lastHookAt: 1000`, `summary.lastOutputAt: 5000`
- `nowMs: 6000`

**Action**: `checkStaleHookActivity(entry, 6000)`

**Assertions**:
- Returns `{ type: "clear_hook_activity" }`

##### 23a. `checkStaleHookActivity returns clear_hook_activity for permission fields on exit review`

**Setup**: Create a session entry with:
- `summary.state: "awaiting_review"`, `summary.reviewReason: "exit"`
- `summary.latestHookActivity: { hookEventName: "PermissionRequest", notificationType: null, activityText: "Waiting for approval", source: "claude" }`

**Action**: `checkStaleHookActivity(entry, Date.now())`

**Assertions**:
- Returns `{ type: "clear_hook_activity" }` — `reviewReason` is `"exit"` (not `"hook"`), so the second condition matches: non-hook review with permission fields

##### 23b. `checkStaleHookActivity returns clear_hook_activity for permission fields on error review`

**Setup**: Create a session entry with:
- `summary.state: "awaiting_review"`, `summary.reviewReason: "error"`
- `summary.latestHookActivity: { hookEventName: "PermissionRequest", notificationType: null, activityText: "Waiting for approval", source: "claude" }`

**Action**: `checkStaleHookActivity(entry, Date.now())`

**Assertions**:
- Returns `{ type: "clear_hook_activity" }` — `reviewReason` is `"error"` (not `"hook"`), so the second condition matches: non-hook review with permission fields

---

### Session State Machine (regression)

**Test file**: `test/runtime/terminal/session-reconciliation.test.ts` (same file, separate `describe` block)
**Pattern to follow**: Existing `reduceSessionTransition` tests in `session-manager-interrupt-recovery.test.ts:319+`

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 25 | `hook.to_in_progress from awaiting_review with hook reason transitions to running` | State machine allows the transition reconciliation will trigger |
| 26 | `hook.to_in_progress from awaiting_review with exit reason is rejected` | State machine guard prevents reconciliation from resuming terminal states |

These are regression tests confirming the state machine behaves as the reconciliation checks assume.

---

## Integration Tests

### Reconciliation Sweep Lifecycle

**Test file**: `test/runtime/terminal/session-manager-reconciliation.test.ts`
**Dependencies**: Mock PTY via `vi.mock()` (same pattern as `session-manager-interrupt-recovery.test.ts`)
**Setup**: `vi.useFakeTimers()` / `vi.useRealTimers()` per test

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 27 | `reconciliation sweep runs every 10s` | Timer fires at correct interval |
| 28 | `startReconciliation is idempotent` | Calling twice does not create duplicate timers |
| 29 | `stopReconciliation clears the timer` | No further ticks after stopping |
| 30 | `dead process in running state triggers recovery` | Existing watchdog behavior preserved after absorption |
| 31 | `dead process in awaiting_review state triggers recovery` | New behavior — extends watchdog to review states |
| 32 | `stale permission badge cleared after Escape-triggered attention review` | End-to-end: Escape → interrupt recovery → reconciliation clears stale activity |
| 33 | `session resumes to running when output detected after review` | End-to-end: hook.to_review → output arrives → reconciliation transitions to running |
| 34 | `legitimate awaiting_review with no output is not touched` | Negative test: no false positives |
| 35 | `completed and interrupted sessions are not modified` | Negative test: `interrupted` sessions (state `"interrupted"`) are excluded by `isActiveState()` filter. Completed sessions (`awaiting_review` with `reviewReason: "exit"`) pass `isActiveState()` and are iterated, but no check matches (`canReturnToRunning("exit")` is false). Both remain unchanged. |
| 36 | `onState listener receives corrected summary` | Broadcast pipeline: listeners notified of reconciliation corrections |
| 37 | `emitSummary called for each correction` | Summary flows through RuntimeStateHub pipeline |
| 38 | `only one action applied per entry per sweep` | Priority ordering: dead process check prevents further checks |
| 39 | `error in one entry does not prevent checking others` | Resilience: per-entry try/catch |

#### Test Details

##### 27. `reconciliation sweep runs every 10s`

**Setup**:
- `vi.useFakeTimers()`
- Create `TerminalSessionManager`, call `startReconciliation()`
- Hydrate with a session in `awaiting_review` with dead PID

**Action**: `await vi.advanceTimersByTimeAsync(10_000)`

**Assertions**:
- Session state changed (dead process recovered)
- Advance by another 10_000ms → another sweep runs (verify with spy or state change on a second entry)

##### 30. `dead process in running state triggers recovery`

**Setup**:
- `vi.useFakeTimers()`
- Create `TerminalSessionManager`, hydrate with session: `state: "running"`, `pid: 999_999_999`
- Inject mock `active` entry with `onSessionCleanup: vi.fn()`
- Register `onState` listener spy
- Call `startReconciliation()`

**Action**: `await vi.advanceTimersByTimeAsync(10_000)`

**Assertions**:
- `manager.getSummary("task-1")?.state` === `"awaiting_review"`
- `manager.getSummary("task-1")?.reviewReason` === `"error"` (the `recover_dead_process` action fires `process.exit` with `exitCode: null`, and `session-state-machine.ts:73` maps `null !== 0` to `"error"`)
- `onState` listener was called
- `onExit` listener was called with `null`

This is a direct port of the existing watchdog test (line 283 in `session-manager-interrupt-recovery.test.ts`) but at 10s instead of 30s.

##### 32. `stale permission badge cleared after Escape-triggered attention review`

**Setup**:
- `vi.useFakeTimers()`
- Spawn mock task session (requires `setupMockPtySpawn()` — follow the existing pattern in `session-manager-interrupt-recovery.test.ts:155-170` for Escape simulation with mock PTY)
- Apply hook activity with permission fields: `manager.applyHookActivity("task-1", { hookEventName: "PermissionRequest", activityText: "Waiting for approval", source: "claude" })`
- Simulate Escape: `manager.writeInput("task-1", Buffer.from([0x1b]))`
- Advance 5s (interrupt recovery fires → state becomes `awaiting_review`/`attention`)

**Action**: `await vi.advanceTimersByTimeAsync(10_000)` (reconciliation sweep)

**Assertions**:
- `manager.getSummary("task-1")?.latestHookActivity` === `null`
- `manager.getSummary("task-1")?.state` === `"awaiting_review"`
- `manager.getSummary("task-1")?.reviewReason` === `"attention"`

##### 33. `session resumes to running when output detected after review`

**Setup**:
- `vi.useFakeTimers()`
- Spawn mock task session
- Transition to review: `manager.transitionToReview("task-1", "hook")`
- Apply hook activity: `manager.applyHookActivity("task-1", { hookEventName: "PermissionRequest", source: "claude" })`
- Trigger terminal output: `mockPtySession.triggerData("agent resumed working\n")`
  (This updates `lastOutputAt` to a time after `lastHookAt`)

**Action**: `await vi.advanceTimersByTimeAsync(10_000)` (reconciliation sweep)

**Assertions**:
- `manager.getSummary("task-1")?.state` === `"running"`
- `manager.getSummary("task-1")?.reviewReason` === `null`
- `manager.getSummary("task-1")?.latestHookActivity` === `null` (cleared by `resume_from_review` action handler)

##### 34. `legitimate awaiting_review with no output is not touched`

**Setup**:
- `vi.useFakeTimers()`
- Spawn mock task session with PID of current process (`process.pid` — guaranteed alive)
- Transition to review: `manager.transitionToReview("task-1", "hook")`
- Apply hook activity with permission fields
- Do NOT trigger any terminal output after the hook

**Action**: `await vi.advanceTimersByTimeAsync(10_000)`

**Assertions**:
- `manager.getSummary("task-1")?.state` === `"awaiting_review"` (unchanged)
- `manager.getSummary("task-1")?.reviewReason` === `"hook"` (unchanged)
- `manager.getSummary("task-1")?.latestHookActivity` is NOT null (preserved)

---

## Edge Cases & Error Scenarios

### Unit-level edge cases

**Test file**: `test/runtime/terminal/session-reconciliation.test.ts` (same file as check function unit tests, separate `describe` block)

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 40 | `reconciliation skips idle sessions` | Session in `idle` state with stale `latestHookActivity` | Not touched — `isActiveState("idle")` is false | Ensure sweep filter covers idle |
| 41 | `reconciliation skips sessions with no active handle and no pid` | Backlog card with no session ever started | Skipped — no active process, no PID, nothing to reconcile | Null safety |
| 42 | `output timestamp equal to hook timestamp does not trigger resume` | `lastOutputAt === lastHookAt` — ambiguous | Returns null — require strictly greater, not equal | Boundary condition |

#### Test Details

##### 40. `reconciliation skips idle sessions`

**Setup**: Create a session entry with:
- `summary.state: "idle"`, `summary.latestHookActivity: { hookEventName: "PermissionRequest", ... }` (artificially stale)

**Action**: Run all `reconciliationChecks` against the entry

**Assertions**:
- All checks return `null` (idle state fails guards in every check)
- Note: In the actual sweep, `isActiveState("idle")` is false and the entry is skipped before checks run. This test verifies the checks themselves are also safe.

##### 41. `reconciliation skips sessions with no active handle and no pid`

**Setup**: Create a session entry with:
- `summary.state: "running"`, `summary.pid: null`, `active: null`

**Action**: `checkDeadProcess(entry, Date.now())`

**Assertions**:
- Returns `null` — both `pid` null guard and `active` null guard prevent action

##### 42. `output timestamp equal to hook timestamp does not trigger resume`

**Setup**: Create a session entry with:
- `summary.state: "awaiting_review"`, `summary.reviewReason: "hook"`
- `summary.lastHookAt: 5000`, `summary.lastOutputAt: 5000`
- `nowMs: 6000`

**Action**: `checkOutputAfterReview(entry, 6000)`

**Assertions**:
- Returns `null` — the guard requires `lastOutputAt > lastHookAt` (strictly greater), not `>=`

### Integration-level edge cases

**Test file**: `test/runtime/terminal/session-manager-reconciliation.test.ts` (same file as sweep integration tests, separate `describe` block)

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 43 | `concurrent hook and reconciliation` | Hook fires in the same tick as reconciliation sweep | Hook's `applyHookActivity` writes after reconciliation clears — final state reflects hook | Race condition safety |
| 44 | `multiple entries with different corrections` | Entry A has dead process, Entry B has stale badge | Both corrected in same sweep — one action per entry | Multi-entry handling |

#### Test Details

##### 43. `concurrent hook and reconciliation`

**Setup**:
- `vi.useFakeTimers()`
- Spawn mock task session
- Transition to review with permission activity
- Simulate Escape → interrupt recovery → state becomes `awaiting_review`/`attention` with stale `latestHookActivity`
- Call `startReconciliation()`

**Action**:
- Advance timer to fire reconciliation sweep (clears `latestHookActivity`)
- Immediately after, apply new hook activity: `manager.applyHookActivity("task-1", { hookEventName: "ToolUse", activityText: "Running bash", source: "claude" })`

**Assertions**:
- `manager.getSummary("task-1")?.latestHookActivity` reflects the NEW hook activity (not null)
- The hook write overwrites the reconciliation clearing — last writer wins, which is correct

##### 44. `multiple entries with different corrections`

**Setup**:
- `vi.useFakeTimers()`
- Create two task sessions:
  - Task A: `state: "running"`, dead PID (`pid: 999_999_999`), `active: {}` (truthy)
  - Task B: `state: "awaiting_review"`, `reviewReason: "attention"`, `latestHookActivity: { hookEventName: "PermissionRequest", ... }`
- Call `startReconciliation()`

**Action**: `await vi.advanceTimersByTimeAsync(10_000)`

**Assertions**:
- Task A: state changed to `awaiting_review`/`reviewReason: "error"` (dead process recovered)
- Task B: `latestHookActivity` is `null` (stale permission cleared)
- Both corrections applied in the same sweep iteration

---

## Phase 3: Proactive Clearing Tests

**Test file**: `test/runtime/terminal/session-manager-reconciliation.test.ts` (same integration test file, separate `describe` block)

### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 50 | `transitionToRunning clears latestHookActivity` | Phase 3: stale permission context from prior review is cleared when agent transitions to running via `hook.to_in_progress` |
| 51 | `transitionToRunning with null latestHookActivity is a no-op` | Phase 3: no unnecessary `updateSummary` call when activity is already null |
| 52 | `resume_from_review action clears latestHookActivity before transition` | Phase 3: reconciliation-triggered resume also clears stale activity (does not rely on `transitionToRunning()` path) |

### Test Details

##### 50. `transitionToRunning clears latestHookActivity`

**Setup**:
- `vi.useFakeTimers()`
- Spawn mock task session
- Transition to review: `manager.transitionToReview("task-1", "hook")`
- Apply hook activity with permission fields: `manager.applyHookActivity("task-1", { hookEventName: "PermissionRequest", activityText: "Waiting for approval", source: "claude" })`
- Verify `manager.getSummary("task-1")?.latestHookActivity` is not null

**Action**: `manager.transitionToRunning("task-1")`

**Assertions**:
- `manager.getSummary("task-1")?.state` === `"running"`
- `manager.getSummary("task-1")?.latestHookActivity` === `null`

##### 51. `transitionToRunning with null latestHookActivity is a no-op`

**Setup**:
- Spawn mock task session
- Transition to review: `manager.transitionToReview("task-1", "hook")`
- Verify `manager.getSummary("task-1")?.latestHookActivity` is null (transitionToReview clears it at line 862)

**Action**: `manager.transitionToRunning("task-1")`

**Assertions**:
- `manager.getSummary("task-1")?.state` === `"running"`
- `manager.getSummary("task-1")?.latestHookActivity` === `null`
- No errors thrown

##### 52. `resume_from_review action clears latestHookActivity before transition`

**Setup**:
- `vi.useFakeTimers()`
- Spawn mock task session
- Transition to review: `manager.transitionToReview("task-1", "hook")`
- Apply hook activity: `manager.applyHookActivity("task-1", { hookEventName: "PermissionRequest", activityText: "Waiting for approval", source: "claude" })`
- Trigger terminal output: `mockPtySession.triggerData("agent resumed working\n")`
  (This updates `lastOutputAt` to a time after `lastHookAt`)

**Action**: `await vi.advanceTimersByTimeAsync(10_000)` (reconciliation sweep fires `resume_from_review` action)

**Assertions**:
- `manager.getSummary("task-1")?.state` === `"running"`
- `manager.getSummary("task-1")?.latestHookActivity` === `null` (cleared by the action handler, not by `transitionToRunning`)

---

## Regression Tests

Tests that ensure existing behavior isn't broken by the new implementation.

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 45 | `existing stale process watchdog behavior preserved at 10s interval` | Dead PID in running state transitions to error review (same as before, just faster) | `session-manager-interrupt-recovery.test.ts:283` |
| 46 | `interrupt recovery still fires at 5s` | Escape → 5s → `awaiting_review`/`attention` (interrupt recovery unchanged) | `session-manager-interrupt-recovery.test.ts:155` |
| 47 | `transitionToReview still clears latestHookActivity before hook transition` | Existing clearing behavior preserved | `session-manager.test.ts` (hook activity tests) |
| 48 | `applyHookActivity still sets latestHookActivity correctly` | Hook activity write path unchanged | `session-manager.test.ts` (hook activity tests) |
| 49 | `audible notification settle window still works` | 500ms settle window for hook sounds unaffected | `use-audible-notifications.test.tsx` |

Note: Tests 45-49 are run by ensuring the existing test suites pass (`npm run test:fast`, `npm run web:test`). Existing test files require only method renames (`startStaleProcessWatchdog` → `startReconciliation`, `stopStaleProcessWatchdog` → `stopReconciliation`) in `session-manager-interrupt-recovery.test.ts` and `shutdown-coordinator.integration.test.ts`.

---

## Test Execution Plan

### Phase 1: Reconciliation check functions

1. **Write unit tests** — define expected behavior for each check function
   - Write: Tests 1-26, 14a, 23a-23b, and 24a-24g in `test/runtime/terminal/session-reconciliation.test.ts`
   - Run: `npx vitest run test/runtime/terminal/session-reconciliation.test.ts` — all FAIL (red — functions don't exist yet)
2. **Implement Phase 1** (check functions in `src/terminal/session-reconciliation.ts`)
   - Run: `npx vitest run test/runtime/terminal/session-reconciliation.test.ts` — all pass (green)
3. **Verify regression**
   - Run: `npm run test:fast` — all existing tests still pass

### Phase 2: Sweep integration

1. **Write integration tests** — define expected sweep behavior
   - Write: Tests 27-39, 43-44 in `test/runtime/terminal/session-manager-reconciliation.test.ts`; Tests 40-42 in `test/runtime/terminal/session-reconciliation.test.ts` (unit-level edge cases)
   - Run: `npx vitest run test/runtime/terminal/session-manager-reconciliation.test.ts` — all FAIL (red)
2. **Implement Phase 2** (wire sweep into session manager)
   - Run: `npx vitest run test/runtime/terminal/session-manager-reconciliation.test.ts` — all pass (green)
3. **Verify regression**
   - Run: `npm run test:fast` — all existing tests still pass (including renamed watchdog callsites)

### Phase 3: Proactive clearing

1. **Write unit tests** for `transitionToRunning` clearing (Tests 50-52)
   - Add tests to `test/runtime/terminal/session-manager-reconciliation.test.ts`
   - Run: `npx vitest run test/runtime/terminal/session-manager-reconciliation.test.ts` — new tests FAIL (red)
2. **Implement Phase 3** (add clearing to `transitionToRunning`)
   - Run: `npx vitest run test/runtime/terminal/session-manager-reconciliation.test.ts` — all pass (green)
3. **Verify full regression**
   - Run: `npm run test:fast && npm run web:test` — all pass

### Commands

```bash
# Run all reconciliation tests
npx vitest run test/runtime/terminal/session-reconciliation.test.ts test/runtime/terminal/session-manager-reconciliation.test.ts

# Run unit tests only (pure check functions)
npx vitest run test/runtime/terminal/session-reconciliation.test.ts

# Run integration tests only (sweep lifecycle)
npx vitest run test/runtime/terminal/session-manager-reconciliation.test.ts

# Run all terminal tests (includes regression)
npx vitest run test/runtime/terminal/

# Full regression suite
npm run test:fast

# Web UI regression
npm run web:test

# Run with verbose output for debugging
npx vitest run test/runtime/terminal/session-reconciliation.test.ts --reporter=verbose
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Phase 1: `checkDeadProcess` detects dead PID in running | Test 1, 3, 4, 5, 6, 6a | Unit |
| Phase 1: `checkDeadProcess` detects dead PID in awaiting_review | Test 2 | Unit |
| Phase 1: `checkDeadProcess` skips failed state | Test 6a | Unit |
| Phase 1: `checkOutputAfterReview` detects output after hook | Test 7, 8, 12, 13, 14, 14a, 15, 16, 17 | Unit |
| Phase 1: `checkOutputAfterReview` respects terminal review reasons | Test 9, 10, 11 | Unit |
| Phase 1: `checkStaleHookActivity` clears permission on wrong state | Test 18, 19, 20, 21, 22, 23, 23a, 23b | Unit |
| Phase 1: `checkStaleHookActivity` clears permission on exit/error review (SDD path 5) | Test 23a, 23b | Unit |
| Phase 1: Check priority ordering | Test 24 | Unit |
| Phase 1: `isPermissionActivity` matches all conditions, case-insensitive | Test 24a, 24b, 24c, 24d, 24e, 24f, 24g | Unit |
| Phase 1: State machine compatibility | Test 25, 26 | Unit (regression) |
| Phase 2: 10s reconciliation interval | Test 27 | Integration |
| Phase 2: Timer lifecycle (idempotent start/stop) | Test 28, 29 | Integration |
| Phase 2: Dead process recovery (existing behavior) | Test 30, 45 | Integration, Regression |
| Phase 2: Dead process in awaiting_review (new) | Test 31 | Integration |
| Phase 2: Stale permission badge after Escape | Test 32 | Integration |
| Phase 2: Output-based resume from review | Test 33 | Integration |
| Phase 2: No false positives on legitimate review | Test 34 | Integration |
| Phase 2: Terminal states not touched | Test 35 | Integration |
| Phase 2: Broadcast pipeline | Test 36, 37 | Integration |
| Phase 2: One action per entry | Test 38 | Integration |
| Phase 2: Error resilience | Test 39 | Integration |
| Phase 3: Clear `latestHookActivity` on `transitionToRunning` | Test 50, 51 | Integration |
| Phase 3: Clear `latestHookActivity` via `resume_from_review` action | Test 52 | Integration |
| Edge case: 30s boundary for `checkOutputAfterReview` | Test 14a | Unit (edge case) |
| Edge case: idle sessions skipped | Test 40 | Unit (edge case) |
| Edge case: no-session cards skipped | Test 41 | Unit (edge case) |
| Edge case: equal timestamps | Test 42 | Unit (edge case) |
| Edge case: concurrent hook and reconciliation | Test 43 | Integration (edge case) |
| Edge case: multiple entries in one sweep | Test 44 | Integration (edge case) |
| Regression: interrupt recovery unchanged | Test 46 | Regression |
| Regression: hook activity write path unchanged | Test 48 | Regression |
| Regression: audible notification settle window | Test 49 | Regression |
