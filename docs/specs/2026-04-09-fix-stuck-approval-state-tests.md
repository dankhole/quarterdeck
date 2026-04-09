# Test Specification: Fix Stuck "Waiting for Approval" State

**Date**: 2026-04-09
**Companion SDD**: docs/specs/2026-04-09-fix-stuck-approval-state.md
**Adversarial Review Passes**: 3

## Test Strategy

Test each root cause fix independently with focused unit tests, then verify the full flow with integration tests. The reconciliation check is tested with pure functions (no process spawning). The auto-review guard is tested with the existing React test harness.

### Test Infrastructure

- **Framework**: Vitest (runtime), Vitest + React Testing Library (web-ui)
- **Test directories**: `test/runtime/` (runtime unit), `test/integration/` (integration), `web-ui/tests/` or `web-ui/src/hooks/*.test.tsx` (web-ui)
- **Run command**: `npm run test` (runtime), `npm run web:test` (web-ui)
- **CI integration**: `test.yml` runs both suites on Ubuntu + macOS

### Coverage Goals

- Every root cause (RC1-RC4) has at least 2 tests (positive + negative)
- Every reconciliation check edge case is covered
- Auto-review guard has positive, negative, and null-session tests
- Regression tests verify existing behavior is preserved

## Unit Tests

### Reconciliation: `checkStaleAwaitingReview`

**Test file**: `test/runtime/terminal/session-reconciliation.test.ts`
**Pattern to follow**: Existing tests for `checkDeadProcess` and `checkStaleHookActivity` in the same file.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `returns clear_hook_activity when alive process has stale permission-review` | Core detection: alive + awaiting_review + hook reason + permission activity + stale lastHookAt |
| 2 | `returns null when lastHookAt is recent` | Time threshold respected — no false positives |
| 3 | `returns null for non-hook review reasons` | Only hook-based reviews are auto-recovered (attention, exit, error are excluded) |
| 4 | `returns null when process is dead` | Defers to checkDeadProcess instead of double-handling |
| 5 | `returns null when state is running` | Only fires for awaiting_review |
| 6 | `returns null when entry.active is null` | No process to check — skip |
| 7 | `returns null when pid is null` | Edge case — no pid means no process to verify |
| 8 | `returns null when lastHookAt is null` | Edge case — no hook timestamp means we can't determine staleness |
| 9 | `check ordering: checkDeadProcess fires before checkStaleAwaitingReview` | Priority ordering in reconciliationChecks array |
| 10 | `returns null for non-permission hook-review (normal "Ready for review")` | Scoping: only permission-related reviews trigger reconciliation, not normal Stop-based reviews |
| 11 | `returns null when latestHookActivity is null` | Edge case — no activity to evaluate for permission check |

#### Test Details

##### 1. `returns clear_hook_activity when alive process has stale permission-review`

**Setup**: Create a `ReconciliationEntry` with:
- `summary.state = "awaiting_review"`, `summary.reviewReason = "hook"`
- `summary.latestHookActivity = { hookEventName: "PermissionRequest", activityText: "Waiting for approval", notificationType: null, ... }` (permission-related activity)
- `summary.pid = 99999` (mock), `summary.lastHookAt = Date.now() - 35_000` (35s ago)
- `entry.active = {}` (truthy)
- Mock `isProcessAlive` to return true

**Action**: Call `checkStaleAwaitingReview(entry, Date.now())`
**Assertions**:
- Returns `{ type: "clear_hook_activity" }`

##### 2. `returns null when lastHookAt is recent`

**Setup**: Same as #1 (including permission activity) but `summary.lastHookAt = Date.now() - 5_000` (5s ago — under threshold)
**Action**: Call `checkStaleAwaitingReview(entry, Date.now())`
**Assertions**:
- Returns `null`

##### 3. `returns null for non-hook review reasons`

**Setup**: Same as #1 but test each non-hook reason: `"attention"`, `"exit"`, `"error"` (note: `"interrupted"` is excluded because it maps to `state: "interrupted"`, not `state: "awaiting_review"` — it's an impossible combination)
**Action**: Call `checkStaleAwaitingReview(entry, nowMs)` for each
**Assertions**:
- Returns `null` for all non-hook reasons

##### 4. `returns null when process is dead`

**Setup**: Same as #1 but mock `isProcessAlive` to return false
**Action**: Call `checkStaleAwaitingReview(entry, Date.now())`
**Assertions**:
- Returns `null`

##### 5-8. Edge cases

Follow the same pattern: set up the entry with the specific condition (including permission activity), verify null return.

##### 10. `returns null for non-permission hook-review (normal "Ready for review")`

**Setup**: Create a `ReconciliationEntry` with:
- `summary.state = "awaiting_review"`, `summary.reviewReason = "hook"`
- `summary.latestHookActivity = { hookEventName: "Stop", activityText: "Final: done", notificationType: null, ... }` (non-permission activity)
- `summary.pid = 99999` (mock), `summary.lastHookAt = Date.now() - 35_000` (35s ago)
- `entry.active = {}` (truthy)
- Mock `isProcessAlive` to return true

**Action**: Call `checkStaleAwaitingReview(entry, Date.now())`
**Assertions**:
- Returns `null` (non-permission reviews are NOT auto-recovered)

##### 11. `returns null when latestHookActivity is null`

**Setup**: Create a `ReconciliationEntry` with:
- `summary.state = "awaiting_review"`, `summary.reviewReason = "hook"`
- `summary.latestHookActivity = null`
- Other fields same as #1

**Action**: Call `checkStaleAwaitingReview(entry, Date.now())`
**Assertions**:
- Returns `null`

##### 9. `check ordering`

**Note**: This updates the existing ordering test in `session-reconciliation.test.ts` (which currently asserts a two-element array). Do not add a parallel new test — modify the existing one.

**Setup**: Read the exported `reconciliationChecks` array
**Assertions**:
- `reconciliationChecks.length` is `3`
- `reconciliationChecks[0]` is `checkDeadProcess`
- `reconciliationChecks[1]` is `checkStaleAwaitingReview`
- `reconciliationChecks[2]` is `checkStaleHookActivity`

### Reconciliation: `clear_hook_activity` for stale permission reviews

**Test file**: `test/runtime/terminal/session-manager-reconciliation.test.ts` (or add to existing session-manager tests)
**Pattern to follow**: Existing tests for `clear_hook_activity` action handling.

**Note**: No new `ReconciliationAction` type is added — `checkStaleAwaitingReview` emits the existing `{ type: "clear_hook_activity" }`. These tests verify that the existing handler works correctly for the permission-review scenario.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `clear_hook_activity on permission review clears latestHookActivity` | Permission metadata is removed, card stays in awaiting_review |
| 2 | `clear_hook_activity on permission review keeps state as awaiting_review` | Card stays in review column (does NOT transition to running) |
| 3 | `clear_hook_activity on permission review emits summary to listeners` | UI receives the update |

### Hook Metadata Protection

**Test file**: `test/runtime/trpc/hooks-api.test.ts` (or add to existing hooks integration tests)

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `permission metadata survives Stop hook on non-transition path` | RC1 core fix: Stop can't clobber permission |
| 2 | `permission metadata survives generic activity hook` | Non-permission activity hooks also can't clobber |
| 3 | `non-permission metadata is still applied on non-transition path` | Regression: Stop metadata still applies when no permission activity exists |
| 4 | `new permission hook overwrites old permission metadata` | Regression: a second PermissionRequest can update fields |
| 5 | `conversation summary from Stop is still applied even when activity is guarded` | applyConversationSummaryFromMetadata runs regardless |
| 6 | `transitionToReview does not emit null latestHookActivity` | RC4 fix: no null-window |
| 7 | `guard does not fire when task is not in awaiting_review` | State check: guard only triggers in `awaiting_review` state, not `running` or other states (prevents blocking activity updates on stale `latestHookActivity` from a previous review cycle) |

#### Test Details

##### 1. `permission metadata survives Stop hook on non-transition path`

**Setup**:
- Create a mock `TerminalSessionManager` with a task in `awaiting_review` state, `reviewReason: "hook"`, `latestHookActivity: { hookEventName: "PermissionRequest", activityText: "Waiting for approval", notificationType: null, ... }`
- Create a hooks API instance via `createHooksApi` following the existing test pattern: provide `getWorkspacePathById`, `ensureTerminalManagerForWorkspace`, `broadcastRuntimeWorkspaceStateUpdated`, and `broadcastTaskReadyForReview` as mock dependencies. The `ensureTerminalManagerForWorkspace` mock should return the mock session manager.

**Action**: Ingest a `to_review` event with metadata `{ hookEventName: "Stop", activityText: "Final: done", source: "claude" }`
**Assertions**:
- `manager.getSummary(taskId).latestHookActivity.hookEventName` is still `"PermissionRequest"`
- `manager.getSummary(taskId).latestHookActivity.activityText` is still `"Waiting for approval"`

##### 5. `conversation summary from Stop is still applied`

**Setup**: Same as #1
**Action**: Ingest `to_review` with metadata `{ hookEventName: "Stop", conversationSummaryText: "I fixed the bug" }`
**Assertions**:
- `applyConversationSummaryFromMetadata` was called (conversation summary is captured)
- `latestHookActivity` permission fields are unchanged

##### 6. `transitionToReview does not emit null latestHookActivity`

**Setup**: Create a session manager, start a session, set it to `running` state with some existing `latestHookActivity`
**Action**: Call `transitionToReview(taskId, "hook")`, capture emitted summaries
**Assertions**:
- No emitted summary has `latestHookActivity === null`

##### 7. `guard does not fire when task is not in awaiting_review`

**Why the naive setup is unreachable**: A task in `running` state cannot have permission-related `latestHookActivity` left over from a prior review cycle — `applyTransitionToRunning` always clears `latestHookActivity` to null. The test must use an indirect approach.

**Setup**:
- Create a mock `TerminalSessionManager` with a task in `running` state.
- Directly set `latestHookActivity` on the mock summary to have permission fields (`{ hookEventName: "PermissionRequest", activityText: "Waiting for approval", notificationType: null, ... }`) — simulating a hypothetical state where stale activity data exists. This is reachable via the mock but not via normal state transitions, which is exactly the scenario the guard must handle defensively.
- Create a hooks API instance via `createHooksApi`.

**Action**: Ingest an `activity` event (which always returns false from `canTransitionTaskForHookEvent`, so the non-transition path is taken). The non-transition path should check `summary.state === "awaiting_review"` before applying the permission guard. Since the task is `running`, the guard does not block and `applyHookActivity` is called normally.

**Assertions**:
- `applyHookActivity` was called (not blocked by the guard)
- `latestHookActivity` is updated with the new activity metadata

### Permission detection via `isPermissionActivity` with null-filled partial metadata

**Test file**: `test/runtime/trpc/hooks-api.test.ts`
**Note**: No separate `isPermissionHookMetadata` function exists. The guard in `hooks-api.ts` constructs a full `RuntimeTaskHookActivity` from partial metadata (filling missing fields with null) and passes it to the existing `isPermissionActivity`. These tests verify that pattern works correctly.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `isPermissionActivity detects PermissionRequest from partial metadata` | Case-insensitive match with null-filled fields |
| 2 | `isPermissionActivity detects permission_prompt from partial metadata` | Notification path with null-filled fields |
| 3 | `isPermissionActivity detects permission.asked from partial metadata` | OpenCode path with null-filled fields |
| 4 | `isPermissionActivity detects "Waiting for approval" from partial metadata` | Fallback/defensive path — covers any agent that sets activityText without hookEventName/notificationType |
| 5 | `isPermissionActivity returns false for Stop from partial metadata` | Not a permission event |
| 6 | `isPermissionActivity returns false for all-null partial metadata` | Edge case — empty metadata object |

## Web UI Unit Tests

### Auto-Review Approval Guard

**Test file**: `web-ui/src/hooks/use-review-auto-actions.test.tsx`
**Pattern to follow**: Existing tests in the same file.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `does not trash card in approval state` | RC3 core fix |
| 2 | `trashes card in completed state with autoReviewEnabled` | Regression: normal auto-review works |
| 3 | `handles null session summary gracefully` | Edge: session not yet available |
| 4 | `re-evaluates when session transitions out of approval state` | Card becomes trashable after approval is granted |

#### Test Details

##### 1. `does not trash card in approval state`

**Setup**: 
- Board with a card in `review` column, `autoReviewEnabled: true`.
- Create a sessions dict: `{ [cardId]: { state: "awaiting_review", reviewReason: "hook", latestHookActivity: { hookEventName: "PermissionRequest", activityText: "Waiting for approval", notificationType: null, ... } } }`
- Pass `sessions` prop to `useReviewAutoActions` options (the hook stores it in a `sessionsRef` for the evaluation callback).
- The hook's `evaluateAutoReview` reads `sessionsRef.current[reviewTask.id] ?? null` — the `?? null` is critical because dict lookup returns `undefined` for missing keys, but `isApprovalState` expects `RuntimeTaskSessionSummary | null`.
- Verify the `sessionsRef` is updated when sessions prop changes (re-render with updated sessions, confirm ref reflects new value).

**Action**: Render the hook, let the 500ms timer fire.
**Assertions**:
- `requestMoveTaskToTrash` was NOT called for this card.

##### 2. `trashes card in completed state`

**Setup**: Same board setup but sessions dict has `{ [cardId]: { state: "awaiting_review", reviewReason: "exit", exitCode: 0, latestHookActivity: null } }`. Pass `sessions` prop to hook.
**Action**: Render, wait for timer.
**Assertions**:
- `requestMoveTaskToTrash` WAS called.

##### 4. `re-evaluates when session transitions out of approval state`

**Setup**:
- Board with a card in `review` column, `autoReviewEnabled: true`.
- Initial sessions dict has the card in approval state: `{ [cardId]: { state: "awaiting_review", reviewReason: "hook", latestHookActivity: { hookEventName: "PermissionRequest", activityText: "Waiting for approval", notificationType: null, ... } } }`.
- Pass `sessions` prop to hook.

**Action (step 1)**: Render the hook, let the 500ms timer fire.
**Assertions (step 1)**:
- `requestMoveTaskToTrash` was NOT called (card is in approval state, guard blocks it).

**Action (step 2)**: Re-render with updated sessions dict where the card's `latestHookActivity` is cleared (simulating reconciliation clearing permission activity): `{ [cardId]: { state: "awaiting_review", reviewReason: "hook", latestHookActivity: null } }`. Let the next evaluation timer fire.
**Assertions (step 2)**:
- `requestMoveTaskToTrash` WAS called (card is no longer in approval state — `isApprovalState` returns false because `latestHookActivity` is null).

### Happy Path: Permission Request → Approval → Running

**Test file**: `test/runtime/trpc/hooks-api.test.ts`

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `permission request followed by approval transitions card from awaiting_review to running` | Full happy-path lifecycle: PermissionRequest hook -> card shows "Waiting for approval" -> PostToolUse fires to_in_progress -> card returns to "Running" |

#### Test Details

##### 1. `permission request followed by approval transitions card from awaiting_review to running`

**Setup**:
- Create a mock session manager with a task in `running` state.
- Create a hooks API instance.

**Action (step 1)**: Ingest a `to_review` event with metadata `{ hookEventName: "PermissionRequest", activityText: "Waiting for approval", source: "claude" }`.
**Assertions (step 1)**:
- Task state is `awaiting_review`, `reviewReason: "hook"`
- `latestHookActivity.hookEventName` is `"PermissionRequest"`
- `isApprovalState` returns true for the summary

**Action (step 2)**: Ingest a `to_in_progress` event (PostToolUse).
**Assertions (step 2)**:
- Task state is `running`
- `latestHookActivity` is cleared (null)
- `isApprovalState` returns false for the summary

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 1 | `stale reconciliation during genuine wait` | Agent is genuinely waiting for permission, 30s passes | Reconciliation fires `clear_hook_activity`, card degrades from "Waiting for approval" to "Ready for review" (stays in review column). When user approves, PostToolUse fires normally. | Soft degradation — acceptable tradeoff |
| 2 | `multiple rapid permission hooks` | PermissionRequest + Notification[permission_prompt] fire within 100ms | First transitions, second is allowed through the guard (permission-on-permission is not blocked). `latestHookActivity` is updated with the second event's fields. | Hook ordering race |
| 3 | `to_in_progress arrives during checkpoint capture` | `to_review` starts checkpoint, `to_in_progress` arrives mid-capture | Both process correctly due to synchronous state transitions | Confirmed working in research — regression test |

#### Edge Case Test Details

##### 2. `multiple rapid permission hooks`

**Setup**:
- Create a mock session manager with a task in `running` state.
- Create a hooks API instance.

**Action**: Ingest a `to_review` event with metadata `{ hookEventName: "PermissionRequest", activityText: "Waiting for approval" }`, then immediately (no await) ingest a second `to_review` event with metadata `{ notificationType: "permission_prompt", activityText: "Allow bash?" }`.

**Assertions**:
- Task state is `awaiting_review` after both hooks.
- The guard in the non-transition path fires for the second hook. Since the incoming metadata is ALSO a permission event (permission-on-permission), `applyHookActivity` is allowed through.
- `isApprovalState(summary)` returns true (observable behavior — the card is still in approval state after the second permission hook).
- `latestHookActivity.activityText` is `"Allow bash?"` (second event's text replaced the first).

## Regression Tests

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 1 | `normal Stop hook applies metadata when no permission activity` | Stop hook still updates activity fields for normal review flow | `hooks-api.ts:103-111` |
| 2 | `checkDeadProcess still fires for dead processes` | Dead process recovery unchanged | `session-reconciliation.ts:53-68` |
| 3 | `checkStaleHookActivity still clears permission on non-hook review` | Stale activity cleanup unchanged | `session-reconciliation.ts:74-94` |
| 4 | `auto-review trashes non-approval cards` | Normal auto-review flow unchanged | `use-review-auto-actions.ts:114-144` |

## Test Execution Plan

### Phase 1: Permission Metadata Protection

1. **Write unit tests** for `isPermissionActivity` with null-filled partial metadata
   - Run: `npm run test -- --grep "isPermissionActivity"` — all FAIL
2. **Write unit tests** for permission guard in hooks-api
   - Run: `npm run test -- --grep "permission metadata"` — all FAIL
3. **Write regression test** for normal Stop metadata application
4. **Write unit test** for transitionToReview null-window fix
5. **Write happy-path test** for permission request -> approval -> running lifecycle
6. **Implement Phase 1**
   - Run: `npm run test` — all pass

### Phase 2: Stale Reconciliation

1. **Write unit tests** for `checkStaleAwaitingReview` (including permission-scope tests #10, #11)
   - Run: `npm run test -- --grep "checkStaleAwaitingReview"` — all FAIL
2. **Write unit tests** for `clear_hook_activity` on permission-review scenario (verify existing handler works)
3. **Implement Phase 2**
   - Run: `npm run test` — all pass

### Phase 3: Auto-Review Guard

1. **Write web-ui tests** for approval guard
   - Run: `npm run web:test -- --grep "approval"` — all FAIL
2. **Implement Phase 3**
   - Run: `npm run web:test` — all pass

### Commands

```bash
# Run all runtime tests
npm run test

# Run reconciliation tests specifically
npm run test -- --grep "reconciliation"

# Run hooks API tests specifically
npm run test -- --grep "hooks"

# Run web-ui tests
npm run web:test

# Run auto-review tests specifically
npm run web:test -- --grep "auto-review"

# Full check (lint + typecheck + test)
npm run check
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Phase 1: Permission guard | `permission metadata survives Stop hook`, `non-permission metadata still applied` | Unit |
| Phase 1: Permission guard state check | Guard only fires when `summary.state === "awaiting_review"` (test #7) | Unit |
| Phase 1: Permission guard no side effects | Guard skips `applyHookActivity` without refreshing `lastHookAt` or touching other state | Unit |
| Phase 1: Permission-on-permission | Guard allows permission-on-permission through (test #4, Edge Case #2) | Unit |
| Phase 1: Null-window fix | `transitionToReview does not emit null latestHookActivity` | Unit |
| Phase 1: Permission detection (partial metadata) | 6 `isPermissionActivity` with null-filled partial tests | Unit |
| Phase 1: Happy path lifecycle | `permission request followed by approval transitions to running` | Unit |
| Phase 2: checkStaleAwaitingReview | 11 reconciliation tests (including permission-scope tests #10, #11) | Unit |
| Phase 2: Permission-scope filtering | `returns null for non-permission hook-review` (#10) | Unit |
| Phase 2: clear_hook_activity on permission review | 3 existing-handler verification tests | Unit |
| Phase 3: Auto-review guard | 4 web-ui tests | Unit |
| Phase 3: Sessions threading | Test setup explicitly passes `sessions` prop and verifies `sessionsRef` update. Session lookup uses `?? null` (not raw dict access). | Unit |
| Edge case: Multiple rapid permission hooks | `multiple rapid permission hooks` | Edge |
| Edge case: Stale reconciliation genuine wait | Soft degradation: card stays in review, shows "Ready for review" | Edge |
| Regression: normal Stop flow | `normal Stop hook applies metadata` | Regression |
| Regression: dead process | `checkDeadProcess still fires` | Regression |
| Regression: auto-review normal | `trashes non-approval cards` | Regression |
