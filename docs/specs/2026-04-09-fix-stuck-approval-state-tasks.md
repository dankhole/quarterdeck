# Task Graph: Fix Stuck Approval State

**Generated**: 2026-04-09
**Spec**: docs/specs/2026-04-09-fix-stuck-approval-state.md
**Test Spec**: docs/specs/2026-04-09-fix-stuck-approval-state-tests.md
**Total tasks**: 15 (6 grade-1, 9 grade-2, 0 subtasks)

## Execution Order

```
T1  [G1] Export isPermissionActivity (no deps)
T2  [G2] Write Phase 1 hooks-api tests — permission guard + null-window (depends: T1)
T3  [G2] Write Phase 1 isPermissionActivity null-fill tests (no deps)
T4  [G2] Implement Phase 1 permission guard in hooks-api.ts (depends: T2, T3)
T5  [G1] Remove preemptive latestHookActivity clear from transitionToReview (depends: T4)
T6  [G1] Verify Phase 1 — build + typecheck + full test suite (depends: T5)
T7  [G2] Write Phase 2 checkStaleAwaitingReview tests (depends: T6)
T8  [G2] Implement checkStaleAwaitingReview reconciliation check (depends: T7)
T9  [G1] Update reconciliation ordering test (depends: T8)
T10 [G1] Verify Phase 2 — build + typecheck + full test suite (depends: T9)
T11 [G2] Thread sessions into useReviewAutoActions hook (depends: T10)
T12 [G2] Add isApprovalState guard in auto-review evaluation loop (depends: T11)
T13 [G2] Write Phase 3 auto-review approval guard tests (depends: T12)
T14 [G1] Verify Phase 3 — build + typecheck + full test suite (depends: T13)
T15 [G2] Update docs: todo.md, CHANGELOG.md, implementation-log.md (depends: T14)
```

## Tasks

### T1: Export isPermissionActivity — verify import path from hooks-api

- **Grade**: 1
- **Status**: pending
- **Depends on**: none
- **SDD Phase**: Phase 1 (prerequisite)
- **Files to modify**: none (read-only verification)
- **Description**: Verify that `isPermissionActivity` is already exported from `src/terminal/session-reconciliation.ts` and can be imported from `src/trpc/hooks-api.ts` using `import { isPermissionActivity } from "../terminal/session-reconciliation"`. The function already exists and is exported — this task confirms the import path works and no `.js` extension is needed (matching existing import convention in hooks-api.ts). No code changes needed if the export is already in place.
- **Acceptance criteria**:
  - [ ] `isPermissionActivity` is exported from `src/terminal/session-reconciliation.ts` (already true — confirmed in read)
  - [ ] Import path `"../terminal/session-reconciliation"` is correct relative to `src/trpc/hooks-api.ts`
  - [ ] `npm run typecheck` passes
- **Outcome notes**: 
- **Attempts**: 

### T2: Write Phase 1 hooks-api tests — permission guard, null-window, happy path

- **Grade**: 2
- **Status**: pending
- **Depends on**: T1
- **SDD Phase**: Phase 1 (tests first)
- **Files to modify**: `test/runtime/trpc/hooks-api.test.ts` — add 8 new test cases
- **Description**: Add the following tests to the existing `createHooksApi` describe block in `hooks-api.test.ts`. These tests will FAIL until T4 and T5 implement the fixes. Follow the existing test pattern: create a mock manager with `getSummary` returning a crafted summary, create a hooks API via `createHooksApi`, and ingest hook events.

  **Test cases** (from test spec):
  1. `permission metadata survives Stop hook on non-transition path` — manager in `awaiting_review` with permission `latestHookActivity`, ingest `to_review` with Stop metadata, assert `applyHookActivity` was NOT called
  2. `permission metadata survives generic activity hook` — same setup but ingest `activity` event with non-permission metadata, assert `applyHookActivity` was NOT called
  3. `non-permission metadata is still applied on non-transition path` — manager in `awaiting_review` with non-permission `latestHookActivity` (e.g. toolActivity), ingest `to_review` with Stop metadata, assert `applyHookActivity` WAS called
  4. `new permission hook overwrites old permission metadata` — manager in `awaiting_review` with permission activity, ingest `to_review` with new permission metadata, assert `applyHookActivity` WAS called (permission-on-permission allowed through)
  5. `conversation summary from Stop is still applied even when activity is guarded` — manager in `awaiting_review` with permission activity, ingest `to_review` with Stop metadata + `conversationSummaryText`, assert `appendConversationSummary` WAS called but `applyHookActivity` was NOT
  6. `transitionToReview does not emit null latestHookActivity` — manager in `running` with some existing `latestHookActivity`, call `transitionToReview`, capture emitted summaries, assert none have `latestHookActivity === null`
  7. `guard does not fire when task is not in awaiting_review` — manager in `running` with stale permission `latestHookActivity` (set on mock), ingest `activity` event, assert `applyHookActivity` WAS called (guard only fires in `awaiting_review`)
  8. `permission request followed by approval transitions card from awaiting_review to running` — happy path lifecycle test

  The `createSummary` helper in the test file needs `warningMessage`, `latestTurnCheckpoint`, and `previousTurnCheckpoint` fields added to match the full `RuntimeTaskSessionSummary` shape (the reconciliation test file has these but hooks-api test does not).

- **Acceptance criteria**:
  - [ ] 8 new test cases added to `test/runtime/trpc/hooks-api.test.ts`
  - [ ] Tests compile: `npm run typecheck`
  - [ ] Tests FAIL as expected (implementation not yet in place): `npm run test -- test/runtime/trpc/hooks-api.test.ts`
- **Outcome notes**: 
- **Attempts**: 

### T3: Write Phase 1 isPermissionActivity null-fill pattern tests

- **Grade**: 2
- **Status**: pending
- **Depends on**: none
- **SDD Phase**: Phase 1 (tests first)
- **Files to modify**: `test/runtime/trpc/hooks-api.test.ts` — add 6 new test cases in a new describe block
- **Description**: Add a `describe("isPermissionActivity with null-filled partial metadata")` block. These tests verify the null-fill pattern that hooks-api.ts will use to check incoming partial metadata against `isPermissionActivity`. The tests construct a `RuntimeTaskHookActivity` from partial metadata (filling missing fields with null) and pass it to `isPermissionActivity`.

  **Test cases** (from test spec):
  1. `detects PermissionRequest from partial metadata` — `{ hookEventName: "PermissionRequest" }` + nulls
  2. `detects permission_prompt from partial metadata` — `{ notificationType: "permission_prompt" }` + nulls
  3. `detects permission.asked from partial metadata` — `{ notificationType: "permission.asked" }` + nulls
  4. `detects "Waiting for approval" from partial metadata` — `{ activityText: "Waiting for approval" }` + nulls
  5. `returns false for Stop from partial metadata` — `{ hookEventName: "Stop" }` + nulls
  6. `returns false for all-null partial metadata` — all fields null

  Import `isPermissionActivity` from `"../../../src/terminal/session-reconciliation"` (same file as reconciliation tests).

- **Acceptance criteria**:
  - [ ] 6 new test cases added in a new describe block
  - [ ] All 6 tests PASS immediately (they test existing `isPermissionActivity` with a new calling pattern — no implementation change needed)
  - [ ] `npm run test -- test/runtime/trpc/hooks-api.test.ts`
- **Outcome notes**: 
- **Attempts**: 

### T4: Implement Phase 1 permission guard in hooks-api.ts

- **Grade**: 2
- **Status**: pending
- **Depends on**: T2, T3
- **SDD Phase**: Phase 1 step 1 + step 3
- **Files to modify**: `src/trpc/hooks-api.ts` — modify non-transition path at lines 103-111
- **Description**: Add the permission metadata protection guard on the non-transition path in `hooks-api.ts`.

  **Changes**:
  1. Add import: `import { isPermissionActivity } from "../terminal/session-reconciliation";`
  2. Import `RuntimeTaskHookActivity` type from `"../core/api-contract"` (add to existing import).
  3. In the `if (!canTransitionTaskForHookEvent(summary, event))` block (lines 103-111), before the existing `if (body.metadata)` check:
     - Check if `summary.state === "awaiting_review"` AND `summary.latestHookActivity` is truthy AND `isPermissionActivity(summary.latestHookActivity)` returns true.
     - If so, construct a full `RuntimeTaskHookActivity` from `body.metadata` using the null-fill pattern (all fields default to null via `??`).
     - If `!isPermissionActivity(incomingActivity)`, skip the `manager.applyHookActivity(taskId, body.metadata)` call entirely. Do NOT refresh `lastHookAt`.
     - If the incoming IS a permission event, allow `applyHookActivity` through (permission-on-permission).
  4. `applyConversationSummaryFromMetadata` must still run regardless of the guard.

- **Acceptance criteria**:
  - [ ] Permission guard blocks non-permission hooks from overwriting permission metadata in `awaiting_review` state
  - [ ] Permission-on-permission hooks are allowed through
  - [ ] Conversation summaries still applied when activity is guarded
  - [ ] Guard does not fire when task is not in `awaiting_review`
  - [ ] `npm run typecheck` passes
  - [ ] Phase 1 hooks-api tests pass: `npm run test -- test/runtime/trpc/hooks-api.test.ts`
- **Outcome notes**: 
- **Attempts**: 

### T5: Remove preemptive latestHookActivity clear from transitionToReview

- **Grade**: 1
- **Status**: pending
- **Depends on**: T4
- **SDD Phase**: Phase 1 step 2
- **Files to modify**: `src/terminal/session-manager.ts` — modify `transitionToReview` at lines 850-856
- **Description**: Remove the `if (entry.summary.latestHookActivity) { updateSummary(entry, { latestHookActivity: null }); }` block from `transitionToReview`. Replace the existing comment block (lines 850-853) with the RC4 invariant comment:
  ```
  // RC4 invariant: Do NOT clear latestHookActivity here. The caller (hooks-api.ts)
  // calls applyHookActivity immediately after this method in the same synchronous tick,
  // which replaces the activity atomically via isNewEvent=true clearing. Clearing here
  // would create a null-window observable by WebSocket listeners between transitionToReview
  // and applyHookActivity. See SDD: 2026-04-09-fix-stuck-approval-state.md Phase 1.
  ```
- **Acceptance criteria**:
  - [ ] The `updateSummary(entry, { latestHookActivity: null })` call is removed from `transitionToReview`
  - [ ] RC4 invariant comment is in place
  - [ ] `transitionToReview does not emit null latestHookActivity` test passes
  - [ ] `npm run typecheck` passes
  - [ ] `npm run test` passes (all existing tests still work)
- **Outcome notes**: 
- **Attempts**: 

### T6: Verify Phase 1 — build + typecheck + full test suite

- **Grade**: 1
- **Status**: pending
- **Depends on**: T5
- **SDD Phase**: Phase 1 checkpoint
- **Files to modify**: none
- **Description**: Run the full verification suite to confirm Phase 1 is complete before proceeding.
- **Acceptance criteria**:
  - [ ] `npm run build` succeeds
  - [ ] `npm run typecheck` passes
  - [ ] `npm run lint` passes
  - [ ] `npm run test` passes (all runtime tests)
  - [ ] `npm run web:typecheck` passes
- **Outcome notes**: 
- **Attempts**: 

### T7: Write Phase 2 checkStaleAwaitingReview tests

- **Grade**: 2
- **Status**: pending
- **Depends on**: T6
- **SDD Phase**: Phase 2 (tests first)
- **Files to modify**: `test/runtime/terminal/session-reconciliation.test.ts` — add 10 new test cases
- **Description**: Add a new `describe("checkStaleAwaitingReview")` block to the reconciliation test file, following the existing patterns (`createEntry`, `permissionActivity`, `toolActivity` helpers).

  **Test cases** (from test spec):
  1. `returns clear_hook_activity when alive process has stale permission-review` — core detection: alive + `awaiting_review` + hook reason + permission activity + stale `lastHookAt` (35s ago). Mock `isProcessAlive` to return true for `process.pid` (use own PID).
  2. `returns null when lastHookAt is recent` — same but `lastHookAt` is 5s ago
  3. `returns null for non-hook review reasons` — test `"attention"`, `"exit"`, `"error"` review reasons
  4. `returns null when process is dead` — use PID `999_999_999` (guaranteed dead)
  5. `returns null when state is running` — state is `running`, not `awaiting_review`
  6. `returns null when entry.active is null` — `active: null`
  7. `returns null when pid is null` — `pid: null`
  8. `returns null when lastHookAt is null` — `lastHookAt: null`
  9. `returns null for non-permission hook-review (normal "Ready for review")` — `latestHookActivity` has `hookEventName: "Stop"` (not permission)
  10. `returns null when latestHookActivity is null` — `latestHookActivity: null`

  For tests needing an alive process, use `process.pid` (the test runner's own PID, guaranteed alive). For dead process tests, use `999_999_999`.

  These tests will FAIL until T8 implements `checkStaleAwaitingReview`.

- **Acceptance criteria**:
  - [ ] 10 new test cases added in a `describe("checkStaleAwaitingReview")` block
  - [ ] Tests compile: `npm run typecheck`
  - [ ] Tests FAIL as expected: `npm run test -- test/runtime/terminal/session-reconciliation.test.ts`
- **Outcome notes**: 
- **Attempts**: 

### T8: Implement checkStaleAwaitingReview reconciliation check

- **Grade**: 2
- **Status**: pending
- **Depends on**: T7
- **SDD Phase**: Phase 2 step 1
- **Files to modify**: `src/terminal/session-reconciliation.ts`
- **Description**: Add the new reconciliation check function and wire it into the checks array.

  **Changes**:
  1. Export `STALE_HOOK_REVIEW_THRESHOLD_MS = 30_000`.
  2. Add and export function `checkStaleAwaitingReview(entry: ReconciliationEntry, nowMs: number): ReconciliationAction | null` with the following early-return chain:
     - Return null if `summary.state !== "awaiting_review"`
     - Return null if `summary.reviewReason !== "hook"`
     - Return null if `!summary.latestHookActivity`
     - Return null if `!isPermissionActivity(summary.latestHookActivity)`
     - Return null if `!entry.active`
     - Return null if `summary.pid == null`
     - Return null if `!isProcessAlive(summary.pid)`
     - Return null if `summary.lastHookAt == null`
     - Return null if `nowMs - summary.lastHookAt < STALE_HOOK_REVIEW_THRESHOLD_MS`
     - Otherwise return `{ type: "clear_hook_activity" }`
  3. Update `reconciliationChecks` array: insert `checkStaleAwaitingReview` between `checkDeadProcess` and `checkStaleHookActivity` (3 elements).
  4. Update the ordering comment: `/** Ordered by priority: dead process > stale awaiting review > clear activity. */`

- **Acceptance criteria**:
  - [ ] `checkStaleAwaitingReview` function implemented with all early returns
  - [ ] `STALE_HOOK_REVIEW_THRESHOLD_MS` exported as 30000
  - [ ] `reconciliationChecks` array has 3 elements in correct order
  - [ ] All 10 new tests pass: `npm run test -- test/runtime/terminal/session-reconciliation.test.ts`
  - [ ] `npm run typecheck` passes
- **Outcome notes**: 
- **Attempts**: 

### T9: Update reconciliation ordering test

- **Grade**: 1
- **Status**: pending
- **Depends on**: T8
- **SDD Phase**: Phase 2 (test update)
- **Files to modify**: `test/runtime/terminal/session-reconciliation.test.ts` — modify existing ordering test
- **Description**: Update the existing `reconciliationChecks` ordering test (test #24 in the file) to assert 3 elements instead of 2. The test currently asserts `reconciliationChecks[0]` is `checkDeadProcess`, `reconciliationChecks[1]` is `checkStaleHookActivity`, and length is 2. Change to:
  - `reconciliationChecks[0]` is `checkDeadProcess`
  - `reconciliationChecks[1]` is `checkStaleAwaitingReview`
  - `reconciliationChecks[2]` is `checkStaleHookActivity`
  - `reconciliationChecks.length` is `3`

  Import `checkStaleAwaitingReview` in the existing import statement.

- **Acceptance criteria**:
  - [ ] Ordering test updated to assert 3-element array
  - [ ] `checkStaleAwaitingReview` imported in the test file
  - [ ] `npm run test -- test/runtime/terminal/session-reconciliation.test.ts` passes
- **Outcome notes**: 
- **Attempts**: 

### T10: Verify Phase 2 — build + typecheck + full test suite

- **Grade**: 1
- **Status**: pending
- **Depends on**: T9
- **SDD Phase**: Phase 2 checkpoint
- **Files to modify**: none
- **Description**: Run the full verification suite to confirm Phase 2 is complete before proceeding to Phase 3.
- **Acceptance criteria**:
  - [ ] `npm run build` succeeds
  - [ ] `npm run typecheck` passes
  - [ ] `npm run test` passes (all runtime tests)
- **Outcome notes**: 
- **Attempts**: 

### T11: Thread sessions into useReviewAutoActions hook

- **Grade**: 2
- **Status**: pending
- **Depends on**: T10
- **SDD Phase**: Phase 3 step 2
- **Files to modify**:
  - `web-ui/src/hooks/use-review-auto-actions.ts` — add `sessions` to options interface, add `sessionsRef`
  - `web-ui/src/hooks/use-board-interactions.ts` — pass `sessions` prop to the hook call
- **Description**: Thread session data from the board interactions hook into the auto-review hook so it can check `isApprovalState`.

  **Changes in `use-review-auto-actions.ts`**:
  1. Import `RuntimeTaskSessionSummary` from `@/runtime/types`.
  2. Add `sessions: Record<string, RuntimeTaskSessionSummary>` to `UseReviewAutoActionsOptions`.
  3. Destructure `sessions` from the options in `useReviewAutoActions`.
  4. Add `const sessionsRef = useRef<Record<string, RuntimeTaskSessionSummary>>(sessions);`
  5. Add `useEffect(() => { sessionsRef.current = sessions; }, [sessions]);`

  **Changes in `use-board-interactions.ts`**:
  1. In the `useReviewAutoActions` call (around line 541), add `sessions` prop from the destructured `sessions` parameter.

- **Acceptance criteria**:
  - [ ] `UseReviewAutoActionsOptions` has `sessions` field
  - [ ] `sessionsRef` created and synced via `useEffect`
  - [ ] `use-board-interactions.ts` passes `sessions` to the hook
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run web:test` passes (existing test updated if needed to pass empty `sessions: {}`)
- **Outcome notes**: 
- **Attempts**: 

### T12: Add isApprovalState guard in auto-review evaluation loop

- **Grade**: 2
- **Status**: pending
- **Depends on**: T11
- **SDD Phase**: Phase 3 step 1
- **Files to modify**: `web-ui/src/hooks/use-review-auto-actions.ts` — modify `evaluateAutoReview` callback
- **Description**: Add the approval-state check inside the auto-review evaluation loop.

  **Changes**:
  1. Import `isApprovalState` from `@/utils/session-status`.
  2. Inside the `for (const reviewTask of reviewCardsForAutomation)` loop, after the `isTaskAutoReviewEnabled` check passes and before `scheduleAutoReviewAction`:
     - Look up session: `const sessionSummary = sessionsRef.current[reviewTask.id] ?? null;`
     - If `isApprovalState(sessionSummary)` returns true, call `clearAutoReviewTimer(reviewTask.id)` and `continue`.

- **Acceptance criteria**:
  - [ ] `isApprovalState` imported and used in the evaluation loop
  - [ ] Session lookup uses `sessionsRef.current` (not closure variable)
  - [ ] `?? null` used for dict lookup (converts `undefined` to `null`)
  - [ ] `npm run web:typecheck` passes
- **Outcome notes**: 
- **Attempts**: 

### T13: Write Phase 3 auto-review approval guard tests

- **Grade**: 2
- **Status**: pending
- **Depends on**: T12
- **SDD Phase**: Phase 3 (tests)
- **Files to modify**: `web-ui/src/hooks/use-review-auto-actions.test.tsx` — add 4 new test cases
- **Description**: Add tests for the approval state guard in the auto-review hook. Follow the existing test pattern using `createRoot`, `act`, and `vi.useFakeTimers`.

  **Changes to test harness**:
  - Update `HookHarness` to accept an optional `sessions` prop (defaulting to `{}`).
  - Pass `sessions` through to `useReviewAutoActions`.

  **Test cases** (from test spec):
  1. `does not trash card in approval state` — render with sessions dict containing `awaiting_review` + permission activity for `task-1`, advance timers, assert `requestMoveTaskToTrash` NOT called
  2. `trashes card in completed state with autoReviewEnabled` — sessions dict has exit-reason review, advance timers, assert `requestMoveTaskToTrash` WAS called
  3. `handles null session summary gracefully` — sessions dict is empty (`{}`), advance timers, assert no crash (card may or may not be trashed — depends on `isApprovalState(null)` returning false)
  4. `re-evaluates when session transitions out of approval state` — first render with approval session (not trashed), re-render with cleared `latestHookActivity` (trashed)

- **Acceptance criteria**:
  - [ ] 4 new test cases added
  - [ ] All tests pass: `npm run web:test`
  - [ ] Existing test still passes
- **Outcome notes**: 
- **Attempts**: 

### T14: Verify Phase 3 — full build + typecheck + all test suites

- **Grade**: 1
- **Status**: pending
- **Depends on**: T13
- **SDD Phase**: Phase 3 checkpoint / final verification
- **Files to modify**: none
- **Description**: Run the complete verification suite across both runtime and web-ui to confirm all three phases work together.
- **Acceptance criteria**:
  - [ ] `npm run build` succeeds
  - [ ] `npm run typecheck` passes
  - [ ] `npm run web:typecheck` passes
  - [ ] `npm run lint` passes
  - [ ] `npm run test` passes (all runtime tests)
  - [ ] `npm run web:test` passes (all web-ui tests)
- **Outcome notes**: 
- **Attempts**: 

### T15: Update docs — todo.md, CHANGELOG.md, implementation-log.md

- **Grade**: 2
- **Status**: pending
- **Depends on**: T14
- **SDD Phase**: Release hygiene (per AGENTS.md)
- **Files to modify**:
  - `docs/todo.md` — remove the completed item if applicable, renumber
  - `CHANGELOG.md` — add bullet under current version section
  - `docs/implementation-log.md` — add detailed entry at top
- **Description**: Per AGENTS.md "Completing a feature or fix" convention, update all three documentation files in the same commit. The CHANGELOG entry should describe the four root causes fixed (RC1-RC4). The implementation log should detail all files touched, the architectural approach, and the commit hash (placeholder until commit).
- **Acceptance criteria**:
  - [ ] `CHANGELOG.md` has a bullet for the stuck approval state fix
  - [ ] `docs/implementation-log.md` has a detailed entry covering all three phases
  - [ ] `docs/todo.md` updated if there was a related item
  - [ ] All three files consistent with each other
- **Outcome notes**: 
- **Attempts**: 

## Dependency Graph

```
T1 ─────┐
        ├──► T2 ─┐
T3 ─────┤        ├──► T4 ──► T5 ──► T6 ──► T7 ──► T8 ──► T9 ──► T10 ──► T11 ──► T12 ──► T13 ──► T14 ──► T15
        │        │
        └────────┘

Parallelizable pairs:
  - T1 + T3 (independent)
  - T2 depends on T1; T3 is independent of T2
```

## Plan Corrections Log
[empty]

## Summary
[empty]
