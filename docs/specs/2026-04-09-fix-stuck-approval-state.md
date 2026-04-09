# Fix Stuck "Waiting for Approval" State — Implementation Specification

**Date**: 2026-04-09
**Branch**: HEAD (detached — worktree)
**Adversarial Review Passes**: 3
**Test Spec**: docs/specs/2026-04-09-fix-stuck-approval-state-tests.md

<!-- Raw Intent (preserved for traceability, not for implementation agents):
"weve tried to fix this kind of issue several times and have gona over this data flow several tims without succsess. deep dive into it archetecurally . read the convo history and context --auto"

The user reports a recurring bug where the board card gets stuck showing "Waiting for approval" even after the agent has resumed working. Multiple prior fix attempts have failed because the issue has four independent root causes that all present identically.
-->

## Goal

Fix the "stuck waiting for approval" state by addressing four independent root causes: (1) Stop hook clobbering permission metadata, (2) no reconciliation for alive-but-stale awaiting_review sessions, (3) auto-review trashing permission-waiting cards, and (4) transient null-window in activity data during state transitions. The fix must preserve the "hook system is authoritative" principle from AGENTS.md.

## Behavioral Change Statement

> **BEFORE**: When an agent requests permission, the card enters "Waiting for approval." Multiple failure modes can leave it stuck:
> - A subsequent Stop hook overwrites the permission metadata fields, changing the card to "Ready for review" even though the agent is still waiting for permission.
> - If `to_in_progress` is missed (timeout, command failure), the card stays in "Waiting for approval" indefinitely.
> - Auto-review can trash a card that is actively waiting for permission approval.
> - The `transitionToReview` clear-then-repopulate window briefly shows "Ready for review" before correcting to "Waiting for approval."
>
> **AFTER**: Permission metadata is never clobbered by non-permission hooks (guard skips `applyHookActivity` entirely — no `lastHookAt` refresh). Stuck permission-related `awaiting_review` states self-heal within 30 seconds via reconciliation by clearing permission activity (card stays in review column, degrades to "Ready for review"). Auto-review skips cards in approval state. The null-window is eliminated by removing the preemptive clear (safety invariant documented in code).
>
> **SCOPE — all code paths affected**:
> 1. Hook ingest (non-transitioning path) → `applyHookActivity` metadata merge — `src/trpc/hooks-api.ts:103-111`
> 2. Hook ingest (transitioning path) → `transitionToReview` clear + repopulate — `src/terminal/session-manager.ts:841-865` → `src/trpc/hooks-api.ts:128-129`
> 3. Session reconciliation sweep → `src/terminal/session-reconciliation.ts:53-97`
> 4. Auto-review card evaluation → `web-ui/src/hooks/use-review-auto-actions.ts:114-144`

## Functional Verification

| # | What to do | Expected result | Code path verified |
|---|-----------|----------------|-------------------|
| 1 | Agent requests permission → PermissionRequest hook fires → Stop hook fires immediately after | Card shows "Waiting for approval" (not "Ready for review"). Permission metadata preserved despite Stop's applyHookActivity call. | Path 1 |
| 2 | Agent requests permission → user approves → PostToolUse fires `to_in_progress` | Card returns to "Running" within 1 second. | Path 2 |
| 3 | Agent requests permission → `to_in_progress` hook silently fails → agent continues working | Card self-heals within 30 seconds via reconciliation: permission activity is cleared, card degrades from "Waiting for approval" to "Ready for review" (stays in review column). | Path 3 |
| 4 | Agent finishes turn → Stop fires → card shows "Ready for review" (no permission metadata) | Card correctly shows "Ready for review", NOT "Waiting for approval". Regression: permission fields from a previous event don't leak. | Path 2 |
| 5 | Card in review column with `autoReviewEnabled=true` enters "Waiting for approval" state | Auto-review does NOT trash the card. Card stays in review column. | Path 4 |
| 6 | Card in review column with `autoReviewEnabled=true`, session state is "Ready for review" (exit reason) | Auto-review DOES trash the card (existing behavior preserved). | Path 4 |
| 7 | PermissionRequest fires → `transitionToReview` runs | Card goes directly from "Running" to "Waiting for approval" with no intermediate "Ready for review" flash. | Path 2 |
| 8 | Agent process dies while in "Waiting for approval" state | Dead process reconciliation fires correctly (existing behavior preserved). | Path 3 |

## Current State

- `src/trpc/hooks-api.ts:103-111` — When `canTransitionTaskForHookEvent` returns false (e.g., Stop hook arrives while already `awaiting_review`), the handler still calls `manager.applyHookActivity(taskId, body.metadata)` unconditionally. This allows non-permission hooks to overwrite permission metadata.
- `src/terminal/session-manager.ts:867-886` — `applyHookActivity` treats any incoming `hookEventName` or `notificationType` as `isNewEvent=true`, which clears all previous fields not provided by the new event. Stop's `hookEventName: "Stop"` triggers this, nulling `notificationType` and changing `hookEventName` from `"PermissionRequest"` to `"Stop"`.
- `src/terminal/session-manager.ts:854-856` — `transitionToReview` clears `latestHookActivity` to null BEFORE the new metadata is applied. This creates a window where the summary has `state="awaiting_review"` + `reviewReason="hook"` + `latestHookActivity=null`, causing `isApprovalState()` to return false.
- `src/terminal/session-reconciliation.ts:53-97` — Only two checks: `checkDeadProcess` (only fires if process is dead) and `checkStaleHookActivity` (only clears metadata, doesn't transition state). No check for alive-but-stale sessions. The `_nowMs` parameter is plumbed but unused.
- `web-ui/src/hooks/use-review-auto-actions.ts:114-144` — `evaluateAutoReview` iterates all cards in the `review` column and schedules trash for any with `autoReviewEnabled=true`. No check for `isApprovalState`.
- `web-ui/src/utils/session-status.ts:5-21` — `isApprovalState()` requires all three: `state="awaiting_review"` + `reviewReason="hook"` + permission fields in `latestHookActivity`. If any is missing, returns false.

## Desired End State

1. **Permission metadata is protected**: When a task is in `awaiting_review` with permission-related activity, non-permission hooks cannot overwrite the permission fields. Only a state transition (to `running` or exit) or a new permission event clears them.
2. **Stale awaiting_review self-heals**: A new reconciliation check detects alive processes that have been in `awaiting_review` with `reviewReason="hook"` and permission-related activity where `lastHookAt` is older than the threshold (30s). Since the permission guard does not refresh `lastHookAt`, this window runs from the original permission event. It clears the permission activity data so the card degrades from "Waiting for approval" to "Ready for review" (staying in the review column).
3. **Auto-review respects approval state**: Cards in "Waiting for approval" are excluded from auto-review actions.
4. **No null-window in activity data**: `transitionToReview` applies new metadata atomically — no intermediate null state is observable by listeners.

## Out of Scope

- Adding a UI "Approve" or "Dismiss" button for permission prompts (future enhancement)
- Changing Claude Code's hook configuration or hook event ordering
- WebSocket transport reliability improvements
- Output-based transition detection for Claude (Codex has `codexPromptDetector`; adding one for Claude is separate work)
- Fixing the inconsistent `updatedAt` tie-breaking between stream reducer (`<=`) and workspace-sync (`>=`)

## Dependencies

- **Teams**: None
- **Services**: None
- **Data**: None
- **Timing**: None

## New Dependencies & Configuration

None. All changes use existing infrastructure.

## Architecture & Approach

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Permission metadata protection | Guard in `hooks-api.ts` non-transition path: skip `applyHookActivity` if current activity has permission fields and incoming event is not permission-related. No `lastHookAt` refresh on skip — keeps the guard simple and lets reconciliation detect missed-hook-while-agent-active scenarios. | Simplest fix — prevents clobbering at the source. Doesn't require changes to `applyHookActivity`'s merge logic. No new public methods on `TerminalSessionManager`. | (a) Refresh `lastHookAt` on skip — protects genuine waits from reconciliation but prevents recovery when `to_in_progress` is missed and agent continues sending activity hooks. Since reconciliation's soft degradation (clear activity, card stays in review) is acceptable for genuine waits, the simpler no-refresh approach wins. (b) Change `applyHookActivity` to never overwrite permission fields — too complex, would affect all callers. | Guard MUST only block non-transitioning hooks. Transitioning hooks (which clear + repopulate) must still work. Permission-on-permission must be allowed through. |
| Stale awaiting_review recovery | New reconciliation check: `checkStaleAwaitingReview` — if state is `awaiting_review`, `reviewReason="hook"`, activity is permission-related, process is alive, AND `lastHookAt` is older than 30s, emit `{ type: "clear_hook_activity" }` | Uses existing `lastHookAt` signal (already tracked per-hook-change). Doesn't use `lastOutputAt` (respects AGENTS.md warning). 30s threshold is generous enough to avoid false positives. Scoped to permission-related reviews only to avoid bouncing normal "Ready for review" cards back to Running. Soft degradation: card stays in review column but loses the permission badge instead of incorrectly showing "Running". Since the permission guard does NOT refresh `lastHookAt`, the 30s window runs from the original permission event regardless of intervening hooks. This means genuine waits also degrade after 30s — acceptable because the soft degradation (card shows "Ready for review", stays in review column) is benign. | Use `lastOutputAt` as combined signal — explicitly prohibited by AGENTS.md. Transition to `running` — would show incorrect state for genuine permission waits; no hook re-fires since Claude is frozen at the prompt. | Reuses existing `clear_hook_activity` action — no new `ReconciliationAction` type needed. Threshold must be configurable in tests. |
| Auto-review approval guard | Check `isApprovalState` in the auto-review evaluation loop and skip cards that match | Minimal change — one guard in the right place. Uses existing `isApprovalState()` utility. | Add approval state to the `isTaskAutoReviewEnabled` function — conflates two concerns | Must import and use the server-side `isPermissionActivity` or recreate the check from session data available in the store |
| Atomic activity replacement in transitionToReview | Instead of clearing then repopulating, do nothing — the caller (`hooks-api.ts`) already applies activity AFTER the transition. Remove the preemptive clear. | The clear was added to prevent stale fields from leaking, but the actual protection should be in the metadata merge, not a preemptive nuke. | Keep the clear but batch it atomically with the transition — would require refactoring `applySessionEvent` | The activity from the PREVIOUS review must not leak into the new review. Verify this is handled by the caller's `applyHookActivity` via `isNewEvent` clearing. |

## Implementation Phases

### Phase 1: Protect Permission Metadata from Clobbering (RC1 + RC4)

#### Overview

Fix the root cause of permission metadata being overwritten by Stop hooks, and eliminate the null-window flash. These are tightly coupled — both involve how `latestHookActivity` is managed during the `to_review` flow.

#### Changes Required

##### 1. Guard non-transitioning hooks from clobbering permission activity

**File**: `src/trpc/hooks-api.ts`
**Action**: Modify
**Location**: Non-transition path at lines 103-111
**Changes**:
- Before calling `manager.applyHookActivity(taskId, body.metadata)` on the non-transition path, check if `summary.state === "awaiting_review"` AND the current `latestHookActivity` has permission-related fields (using `isPermissionActivity` from `session-reconciliation.ts`). The state check prevents the guard from triggering on stale `latestHookActivity` from a previous review cycle when the task is no longer in `awaiting_review`.
- If the current activity IS a permission prompt AND the incoming metadata is NOT a permission event (using `isPermissionActivity` with null-filled partial — see step 3), then SKIP the `applyHookActivity` call entirely. Do NOT refresh `lastHookAt` — the guard is a pure skip with no side effects on session state.
- If the incoming metadata IS also a permission event (permission-on-permission), allow `applyHookActivity` through. This lets a second PermissionRequest update the fields normally.
- Still allow `applyConversationSummaryFromMetadata` to run (conversation summaries should still be captured).
- **Import path**: `import { isPermissionActivity } from "../terminal/session-reconciliation";` (matches existing import convention in hooks-api.ts — no `.js` extension).
- **Unaffected code path**: The existing `reviewReason !== "hook"` early return (for attention/exit/error reasons) fires before the non-transition path and is unaffected by this guard. The guard only applies to hooks that reach the `canTransitionTaskForHookEvent === false` branch.

**Code Pattern to Follow**: The existing `isPermissionActivity()` in `src/terminal/session-reconciliation.ts:37-47` already implements the permission detection logic. Import and reuse it.

##### 2. Remove preemptive `latestHookActivity` clear from `transitionToReview`

**File**: `src/terminal/session-manager.ts`
**Action**: Modify
**Location**: `transitionToReview` method at lines 850-856
**Changes**:
- Remove the `if (entry.summary.latestHookActivity) { updateSummary(entry, { latestHookActivity: null }); }` block.
- The caller in `hooks-api.ts:128-129` already calls `applyHookActivity` after `transitionToReview`. When `applyHookActivity` receives a new event with `hookEventName` or `notificationType` set, `isNewEvent=true` clears fields not provided by the new event (`activityText`, `finalMessage`, `hookEventName`, `notificationType` are nulled), while `toolName`, `toolInputSummary`, and `source` carry forward from previous activity. This provides the same staleness protection without the null-window.

**RC4 Safety Invariant**: After this change, the summary emitted by `transitionToReview` at line 862 will still have the PREVIOUS `latestHookActivity` (from the prior review). This is safe because:
1. `applyHookActivity` runs immediately after in `hooks-api.ts:128-129` and replaces it with the new event's data.
2. Both calls happen in the same synchronous tick of the event loop (no `await` between them in `hooks-api.ts:113-132`), so no listener can observe the stale intermediate state.
3. The `isNewEvent=true` path in `applyHookActivity` nulls fields not provided by the new event (`activityText`, `finalMessage`, `hookEventName`, `notificationType`), while `toolName`, `toolInputSummary`, and `source` carry forward. This prevents the previous review's meaningful activity from leaking into the new review.

Add a comment block in `transitionToReview` explaining this invariant so future maintainers don't re-add the preemptive clear:
```
// RC4 invariant: Do NOT clear latestHookActivity here. The caller (hooks-api.ts)
// calls applyHookActivity immediately after this method in the same synchronous tick,
// which replaces the activity atomically via isNewEvent=true clearing. Clearing here
// would create a null-window observable by WebSocket listeners between transitionToReview
// and applyHookActivity. See SDD: 2026-04-09-fix-stuck-approval-state.md Phase 1.
```

##### 3. Check incoming metadata using `isPermissionActivity` with null defaults

**File**: `src/trpc/hooks-api.ts`
**Action**: Modify (no new function needed)
**Changes**:
- Instead of creating a third permission-detection function (`isPermissionHookMetadata`), construct a full `RuntimeTaskHookActivity` from the partial metadata by filling missing fields with null defaults, then pass it to the existing `isPermissionActivity` from `session-reconciliation.ts`.
- Pattern: Construct a full `RuntimeTaskHookActivity` with all schema fields explicitly set to null defaults — no `as` cast needed because the literal satisfies the interface directly:
  ```ts
  const incomingActivity: RuntimeTaskHookActivity = {
    hookEventName: metadata.hookEventName ?? null,
    notificationType: metadata.notificationType ?? null,
    activityText: metadata.activityText ?? null,
    toolName: metadata.toolName ?? null,
    toolInputSummary: metadata.toolInputSummary ?? null,
    finalMessage: metadata.finalMessage ?? null,
    source: metadata.source ?? null,
    conversationSummaryText: metadata.conversationSummaryText ?? null,
  };
  isPermissionActivity(incomingActivity)
  ```
- This keeps only two permission-detection functions (server-side `isPermissionActivity` and frontend `isPermissionRequest`), eliminating a third variant that would need to stay in sync.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] All tests pass: `npm run test`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`

##### Behavioral

- [ ] New unit test: PermissionRequest metadata survives a subsequent Stop hook on the non-transition path
- [ ] New unit test: `transitionToReview` does NOT emit a summary with `latestHookActivity: null`
- [ ] Existing test: normal Stop metadata still applies when no permission activity exists

**Checkpoint**: Pause here for verification before proceeding to Phase 2.

---

### Phase 2: Add Stale Awaiting-Review Reconciliation (RC2)

#### Overview

Add a new reconciliation check that detects alive processes stuck in `awaiting_review` with permission-related activity and a stale `lastHookAt`. Instead of transitioning to "Running" (which would be incorrect for genuine permission waits where no hook re-fires), the reconciliation clears the hook activity data. The card stays in the review column but degrades from "Waiting for approval" to "Ready for review" — a softer degradation that correctly signals the card needs attention without misrepresenting agent state.

**Why not `transition_to_running`**: When reconciliation fires for a genuine permission wait (user AFK >30s), transitioning to "Running" would be permanently wrong — Claude is frozen at the permission prompt and won't send another PermissionRequest hook to restore the correct state. Clearing activity is recoverable: the card stays in review, and when the user returns and approves, PostToolUse fires normally.

**Why scope to permission-related reviews only**: The `awaiting_review` + `reviewReason="hook"` condition also matches normal "Ready for review" cards (when Claude stops after finishing work). Without the permission scope, the reconciliation check would fire for ALL hook-based reviews after 30s, bouncing normal review cards back to an incorrect state. Only permission-related reviews need this recovery.

#### Changes Required

##### 1. New reconciliation check: `checkStaleAwaitingReview`

**File**: `src/terminal/session-reconciliation.ts`
**Action**: Add
**Changes**:
- Add a new export `STALE_HOOK_REVIEW_THRESHOLD_MS = 30_000` (30 seconds).
- Add function `checkStaleAwaitingReview(entry: ReconciliationEntry, nowMs: number): ReconciliationAction | null`:
  - Return null if `summary.state !== "awaiting_review"`
  - Return null if `summary.reviewReason !== "hook"`
  - Return null if `!summary.latestHookActivity` (no activity to check)
  - Return null if `!isPermissionActivity(summary.latestHookActivity)` (only recover permission-related reviews — normal "Ready for review" cards are handled by other paths)
  - Return null if `!entry.active` (process not running)
  - Return null if `summary.pid == null`
  - Return null if `!isProcessAlive(summary.pid)` (let `checkDeadProcess` handle dead processes)
  - Return null if `summary.lastHookAt == null`
  - Return null if `nowMs - summary.lastHookAt < STALE_HOOK_REVIEW_THRESHOLD_MS`
  - Otherwise return `{ type: "clear_hook_activity" }` (reuses existing action — no new `ReconciliationAction` type needed)
- Add `checkStaleAwaitingReview` to the `reconciliationChecks` array, AFTER `checkDeadProcess` but BEFORE `checkStaleHookActivity` (dead process takes priority, then stale review, then stale activity).

**No changes needed in `session-manager.ts`**: The existing `clear_hook_activity` handler in `applyReconciliationAction` already clears `latestHookActivity` and emits the updated summary. This is exactly the behavior we want — the card stays in `awaiting_review` but `isApprovalState()` returns false (because permission fields are cleared), so it shows "Ready for review" instead of "Waiting for approval".

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] All tests pass: `npm run test`
- [ ] Typecheck passes: `npm run typecheck`

##### Behavioral

- [ ] New unit test: `checkStaleAwaitingReview` returns `clear_hook_activity` when conditions met (alive, hook reason, permission activity, stale lastHookAt)
- [ ] New unit test: `checkStaleAwaitingReview` returns null for non-hook reasons (attention, exit, error)
- [ ] New unit test: `checkStaleAwaitingReview` returns null when lastHookAt is recent (< threshold)
- [ ] New unit test: `checkStaleAwaitingReview` returns null for dead processes (let checkDeadProcess handle)
- [ ] New unit test: `checkStaleAwaitingReview` returns null for non-permission hook reviews (normal "Ready for review" cards)
- [ ] New unit test: existing `clear_hook_activity` handler correctly clears activity (already tested — verify no regression)

**Checkpoint**: Pause here for verification before proceeding to Phase 3.

---

### Phase 3: Guard Auto-Review Against Approval State (RC3)

#### Overview

Prevent `use-review-auto-actions` from trashing cards that are in "Waiting for approval" state.

#### Changes Required

##### 1. Add approval-state guard to auto-review evaluation

**File**: `web-ui/src/hooks/use-review-auto-actions.ts`
**Action**: Modify
**Location**: Inside the `for (const reviewTask of reviewCardsForAutomation)` loop (around line 114)
**Changes**:
- Import `isApprovalState` from `@/utils/session-status`
- The auto-review loop currently checks `isTaskAutoReviewEnabled(reviewTask)`. After that check passes, add a session lookup: get the session summary for `reviewTask.id` from the sessions ref.
- Read from `sessionsRef.current`, NOT from the `sessions` closure variable. Do NOT add `sessions` to the `useCallback` dependency array — the ref pattern avoids stale closures.
- Use null-coalesce: `const sessionSummary = sessionsRef.current[reviewTask.id] ?? null;` (the dict lookup returns `undefined` for missing keys, but `isApprovalState` expects `null`).
- If `isApprovalState(sessionSummary)` returns true, call `clearAutoReviewTimer(reviewTask.id)` and `continue` — skip this card.

**Challenge**: The `useReviewAutoActions` hook currently receives `board: BoardData` which contains cards but NOT session summaries. Session summaries come from a different data path (`workspaceState.sessions`). We need to thread session data into this hook.

**Solution**: Add a `sessions: Record<string, RuntimeTaskSessionSummary>` parameter to `UseReviewAutoActionsOptions`. The caller (`use-board-interactions.ts`) already has access to sessions via the workspace state. Pass it through.

##### 2. Thread sessions into the auto-review hook

**File**: `web-ui/src/hooks/use-board-interactions.ts`
**Action**: Modify
**Changes**:
- In the `useReviewAutoActions` call, add the `sessions` prop from workspace state.
- The hook stores `sessionsRef` via `useRef` (same pattern as existing `boardRef`) so the evaluation callback can access current session data without stale closures.
- Add a `useEffect` to keep `sessionsRef.current` in sync: `useEffect(() => { sessionsRef.current = sessions; }, [sessions]);`
- The `evaluateAutoReview` callback reads `sessionsRef.current[taskId] ?? null` — NEVER from the `sessions` closure.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Web UI tests pass: `npm run web:test`
- [ ] Web UI typecheck passes: `npm run web:typecheck`

##### Behavioral

- [ ] New test: auto-review skips cards where `isApprovalState` returns true
- [ ] Existing test: auto-review still trashes cards where session is completed (exit reason)
- [ ] Existing test: auto-review still trashes cards where `autoReviewEnabled=false` is not trashed

**Checkpoint**: Verify all phases together.

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| Permission metadata guard blocks Stop hook activity | Conversation summary from Stop is still applied (only `applyHookActivity` is skipped, not `applyConversationSummaryFromMetadata`) | Unit test: Stop hook on non-transition path still applies conversation summary |
| Stale reconciliation triggers during genuine wait | Soft degradation: agent is genuinely waiting for user input, but 30s passes (since the guard does not refresh `lastHookAt`). Reconciliation clears permission activity data. Card stays in review column but shows "Ready for review" instead of "Waiting for approval" (loses the permission badge). When user comes back and approves, PostToolUse fires normally and the agent resumes. | Manual: start agent, wait at permission prompt for 40s, verify card stays in review column showing "Ready for review" (not "Running"). Approve the permission, verify agent resumes and card returns to "Running". |
| `isApprovalState` called with null session in auto-review | `isApprovalState(null)` returns false — auto-review proceeds normally (card may or may not be trashable based on other criteria) | Unit test: null session summary doesn't crash or block auto-review |

## Rollback Strategy

- **Phase 1 rollback**: Revert the `hooks-api.ts` guard and restore the `transitionToReview` clear. Permission clobbering returns but no new bugs.
- **Phase 2 rollback**: Remove `checkStaleAwaitingReview` from the reconciliation checks array. Stuck permission sessions return but no new bugs. No action handler changes to revert (reuses existing `clear_hook_activity`).
- **Phase 3 rollback**: Remove the `isApprovalState` guard from auto-review. Permission cards may be trashed but no new bugs.
- **Full rollback**: `git revert` — all phases are additive with no migrations or schema changes.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Stale reconciliation false positive (clears permission badge on genuinely-waiting agent) | Medium | Low — card stays in review column, just shows "Ready for review" instead of "Waiting for approval". When user approves, PostToolUse fires normally. | 30s threshold is generous. Soft degradation (clear activity) instead of hard degradation (transition to Running) avoids permanently incorrect state. |
| Permission guard blocks legitimate metadata updates | Low | Low — only conversation summaries are still applied | Guard only blocks `applyHookActivity`, not `applyConversationSummaryFromMetadata`. Test thoroughly. |
| Threading sessions into auto-review introduces stale closure bug | Low | Medium — auto-review uses wrong session data | Use `useRef` pattern (already established for `boardRef` in the hook). |

## Implementation Notes / Gotchas

- **Board state single-writer rule** (from AGENTS.md): The auto-review change is frontend-only and modifies board state through the normal UI writer path. No server-side board mutation is introduced.
- **`isPermissionActivity` vs `isPermissionRequest`**: Two copies exist — `session-reconciliation.ts:37-47` (server-side) and `session-status.ts:10-21` (frontend). Both must stay in sync. The `session-reconciliation.ts` file has a comment noting this (line 35). No third variant is needed — incoming partial metadata is handled by constructing a full `RuntimeTaskHookActivity` with null defaults and passing it to `isPermissionActivity` (see Phase 1 step 3).
- **Codex permission detection (known limitation)**: Codex permission is detected via `activityText === "waiting for approval"` string match. The `activityText` is set by `inferActivityText` in `hooks.ts`, which the Quarterdeck codebase controls. If that text changes, both `isPermissionActivity` (server) and `isPermissionRequest` (frontend) must be updated simultaneously. This is the existing contract — the spec doesn't change it.
- **Gemini/Droid agent coverage**: Gemini and Droid agents are not yet tested for permission hook flows. They may use different hook event names or notification types. If permission detection needs to expand for these agents, add cases to both `isPermissionActivity` and `isPermissionRequest`.
- **Synchronous section safety**: Several fixes in this spec rely on operations happening in the same synchronous tick of the Node.js event loop (e.g., `transitionToReview` + `applyHookActivity` in `hooks-api.ts:113-132`). This is safe because Node.js is single-threaded and no `await` separates these calls. However, if a future refactor introduces an `await` between them, the null-window bug (RC4) could resurface. The RC4 invariant comment in `transitionToReview` documents this constraint.
- **Test fixture mock pattern**: Per AGENTS.md, avoid touching test fixture mocks in feature branches. The reconciliation tests already have a helper pattern — follow it rather than modifying shared fixtures.
- **The `_nowMs` parameter**: Already plumbed through to reconciliation checks. The new check is the first to actually use it. No plumbing changes needed.
- **No `refreshHookTimestamp` method needed**: The guard in `hooks-api.ts` does NOT refresh `lastHookAt` when it blocks `applyHookActivity`. This is intentional — `updateSummary` is a module-level function in `session-manager.ts` (not accessible from `hooks-api.ts`), and adding a public method just for this would be unnecessary complexity. The trade-off (reconciliation fires at 30s from the original permission event, even for genuine waits) is acceptable given the soft degradation behavior.
- **`lastHookAt` refresh trade-off**: Without refreshing `lastHookAt` on guarded hooks, reconciliation fires 30s after the original permission event regardless of intervening activity hooks. For genuine permission waits (user AFK >30s), the card degrades from "Waiting for approval" to "Ready for review" but stays in the review column. When the user returns and approves, PostToolUse fires normally and the agent resumes. This is benign. The upside: if `to_in_progress` was missed but the agent continues sending activity hooks, reconciliation detects the stale state and clears it — the "missed hook while agent active" scenario is recovered.
- **`clear_hook_activity` re-fire behavior**: If reconciliation fires `clear_hook_activity` and the activity is already `null` (e.g., cleared by a previous reconciliation pass), the `applyReconciliationAction` handler in `session-manager.ts` calls `updateSummary(entry, { latestHookActivity: null })` — which is a no-op since the field is already null. The `didChange` check in the summary update still bumps `updatedAt`, but this is harmless. A subsequent reconciliation pass will not re-fire because `checkStaleAwaitingReview` returns `null` when `latestHookActivity` is already `null` (one of its early-return conditions).
- **Reconciliation check ordering**: The existing `checkStaleHookActivity` test should be updated (not duplicated) to verify the new three-element ordering: `checkDeadProcess` > `checkStaleAwaitingReview` > `checkStaleHookActivity`.
- **hooks-api test mock structure**: Follow the existing `createHooksApi` test pattern in `test/runtime/trpc/hooks-api.test.ts`. The test creates a `CreateHooksApiDependencies` object with mock implementations. The session manager mock should expose `getSummary`, `applyHookActivity`, `transitionToReview`, `transitionToRunning`, and `appendConversationSummary`.

## References

- **Related files**: `src/trpc/hooks-api.ts`, `src/terminal/session-manager.ts`, `src/terminal/session-reconciliation.ts`, `web-ui/src/hooks/use-review-auto-actions.ts`, `web-ui/src/utils/session-status.ts`
- **Prior art**: `checkDeadProcess` in `session-reconciliation.ts` — pattern for new reconciliation check
- **Test Spec**: docs/specs/2026-04-09-fix-stuck-approval-state-tests.md
