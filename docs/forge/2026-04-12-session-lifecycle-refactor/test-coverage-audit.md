# Session Lifecycle — Test Coverage Audit

**Date**: 2026-04-12
**Purpose**: Map existing test coverage and identify gaps before the session-manager structural refactor. These gaps represent behaviors that have zero automated regression protection — any refactoring that subtly breaks them would go undetected.

## Existing Test Inventory

| Test File | Tests | Coverage Focus | Mock Strategy |
|---|---|---|---|
| `session-manager.test.ts` | 23 | Store operations, attach behavior, resize, restore snapshot | Internal casts to `entries` Map, real store |
| `session-manager-reconciliation.test.ts` | 21 | 10s sweep, dead process, stale badges, concurrent hooks | Mock `PtySession.spawn` + `prepareAgentLaunch` |
| `session-manager-interrupt-recovery.test.ts` | 16 | Ctrl+C/Escape, interrupt timer, stale session recovery | Mock `PtySession.spawn` + `prepareAgentLaunch` |
| `session-manager-auto-restart.test.ts` | 6 | Auto-restart on exit, Codex deferred input | Mock `PtySession.spawn` + `prepareAgentLaunch` |
| `session-reconciliation.test.ts` | 37 | Pure reconciliation check functions | No mocks — pure functions |
| `hooks-api.test.ts` | 21 | Hook ingestion, permission guard, checkpoint, summaries | Fully mocked store + manager |

**Total: 124 tests across 6 files.**

**Missing dedicated test files:**
- `session-state-machine.test.ts` — does not exist. Reducer tested inline in other files.
- `session-summary-store.test.ts` — does not exist. Store tested via `session-manager.test.ts`.
- `claude-workspace-trust.test.ts` — does not exist. **Zero test coverage.**
- `codex-workspace-trust.test.ts` — does not exist. **Zero test coverage.**

---

## Coverage Gaps

### Tier 1: Ordering Invariants (High Risk for Refactor)

These are the behaviors most likely to break during the structural refactor. They depend on synchronous execution order within a single tick, and no existing test verifies them.

#### Gap 1: onData transition-before-broadcast ordering

**What**: When the onData callback triggers a state machine transition (via `detectOutputTransition` → `applySessionEventWithSideEffects`), listeners attached via `attach()` must see the post-transition state in their `onOutput` callback — not the pre-transition state.

**Where**: `session-manager.ts` lines 473-491 (transition at 482, broadcast at 489)

**Why it matters**: The refactor extracts this callback into a method (Phase 4a) then moves it to a new file (Phase 4b). If the ordering changes, the UI would show stale state — a card appears "running" while the terminal shows a review prompt.

**Current coverage**: NOT TESTED. No test attaches a listener and checks store state inside the `onOutput` callback.

**Suggested test**:
```
Describe: "onData ordering invariant"
  - Start a task session with a detectOutputTransition mock that triggers agent.prompt-ready
  - Attach a listener with onOutput callback that calls store.getSummary(taskId)
  - Trigger data matching the transition detector
  - Assert: inside onOutput, summary.state === "awaiting_review" (not "running")
```

#### Gap 2: writeInput CR/LF optimistic transition

**What**: When a non-Codex agent is in `awaiting_review` and the user presses Enter (CR/LF), `writeInput` immediately transitions to `running` via `store.transitionToRunning()` BEFORE writing to the PTY. This eliminates the perceptible delay between prompt submission and the agent's hook arriving.

**Where**: `session-manager.ts` lines 840-847

**Why it matters**: This is the fast path for user responsiveness. If the transition happens AFTER the PTY write, the card stays in "review" until the agent's hook fires (could be seconds).

**Current coverage**: NOT TESTED. The interrupt recovery tests exercise `writeInput` for Ctrl+C/Escape but never test the CR/LF transition path.

**Suggested tests**:
```
Describe: "writeInput CR/LF immediate transition"
  - Start task, transition to awaiting_review (hook reason)
  - writeInput with Buffer containing 0x0D (CR)
  - Assert: store.getSummary shows state=running BEFORE any hook fires
  - Assert: session.write was called (PTY received the input)

  - Same test but with Codex agent — verify state does NOT change (Codex excluded)
```

#### Gap 3: writeInput Codex flag ordering

**What**: When a Codex agent is in `awaiting_review` and the user presses Enter, `writeInput` sets `awaitingCodexPromptAfterEnter = true` BEFORE writing to the PTY. This flag prevents premature `agent.prompt-ready` transitions in the next onData tick.

**Where**: `session-manager.ts` lines 822-833

**Why it matters**: If the flag is set AFTER the write, the Codex TUI could redraw its prompt in the same tick, the onData handler would see the prompt before the flag is set, and a spurious transition would fire.

**Current coverage**: NOT TESTED. No test verifies the flag state at PTY-write time.

**Suggested test**:
```
Describe: "writeInput Codex prompt flag before PTY write"
  - Start Codex task, transition to awaiting_review
  - Spy on session.write, capturing the active state at call time
  - writeInput with Enter
  - Assert: at the moment session.write was called, awaitingCodexPromptAfterEnter was true
```

#### Gap 4: Checkpoint capture ordering (activity before async checkpoint)

**What**: In `hooks-api.ts`, when a `to_review` hook arrives, `applyHookActivity` is called synchronously BEFORE the async `checkpointCapture`. This ensures the frontend's 500ms settle window has activity data to determine the correct notification sound (review vs permission).

**Where**: `hooks-api.ts` lines 191-219

**Why it matters**: If the ordering flips (checkpoint first, then activity), the settle window expires without activity data and the wrong beep plays.

**Current coverage**: PARTIALLY TESTED. Checkpoint capture itself is tested. Ordering is NOT tested.

**Suggested test**:
```
Describe: "hook activity applied before checkpoint capture"
  - Mock captureTaskTurnCheckpoint to record when it's called
  - Mock store.applyHookActivity to record when it's called
  - Send to_review hook with metadata (hookEventName=Stop, activityText=...)
  - Assert: applyHookActivity was called BEFORE captureTaskTurnCheckpoint
```

---

### Tier 2: Untested Subsystems (Medium Risk)

These are entire code paths with zero test coverage.

#### Gap 5: Workspace trust auto-confirm

**What**: The entire workspace trust flow — buffer accumulation, Claude/Codex prompt detection, timer-scheduled `\r` confirm, confirm count cap, warning on cap exceeded, `--add-dir` multi-prompt re-arming.

**Where**: `session-manager.ts` lines 398-454 (trust detection in onData), `claude-workspace-trust.ts`, `codex-workspace-trust.ts`

**Why it matters**: The refactor extracts this into `WorkspaceTrustHandler` (Phase 3). Zero test coverage means the extraction could break prompt detection, timer behavior, or cap enforcement with no automated signal.

**Current coverage**: ZERO. No test file for trust helpers. No integration test exercises the trust flow.

**Suggested tests** (new file: `workspace-trust-handler.test.ts` for post-extraction, but pre-refactor tests should exercise the flow through `session-manager`):
```
Describe: "workspace trust auto-confirm"
  - Start task with willAutoTrust=true
  - Trigger data containing Claude trust prompt text
  - Advance timer by WORKSPACE_TRUST_CONFIRM_DELAY_MS
  - Assert: session.write("\r") was called exactly once

Describe: "workspace trust cap enforcement"
  - Trigger MAX_AUTO_TRUST_CONFIRMS trust prompts, confirming each via timer
  - Trigger one more trust prompt
  - Assert: no additional session.write("\r")
  - Assert: store.update called with warningMessage

Describe: "workspace trust re-arms between prompts"
  - Trigger first trust prompt, confirm via timer
  - Trigger second trust prompt (--add-dir)
  - Assert: second prompt also auto-confirmed

Describe: "trust helpers"
  - hasClaudeWorkspaceTrustPrompt with realistic prompt text → true
  - hasClaudeWorkspaceTrustPrompt with normal agent output → false
  - hasCodexWorkspaceTrustPrompt with realistic prompt text → true
  - shouldAutoConfirmClaudeWorkspaceTrust: claude + worktree → true; claude + non-worktree → false; codex → false
```

#### Gap 6: Shell session lifecycle

**What**: `startShellSession`, shell onData, shell onExit. The entire shell session path.

**Where**: `session-manager.ts` lines 619-773

**Why it matters**: Shell sessions have a different exit handler (uses `store.update` directly, not the state machine). The refactor extracts this as a separate `handleShellSessionExit` method. With zero coverage, the extraction could silently break shell exit state.

**Current coverage**: ZERO. No test calls `startShellSession`.

**Suggested tests**:
```
Describe: "shell session lifecycle"
  - startShellSession, verify state=running, pid set
  - Trigger data output, verify listeners receive it
  - Trigger exit(0), verify state=idle, pid=null
  - Trigger exit(null) with interrupted, verify state=interrupted
  - startShellSession with spawn failure, verify state=failed
```

#### Gap 7: Auto-restart error handling and rate limiting

**What**: When `scheduleAutoRestart` fires and the spawn fails, the catch block sets `warningMessage` and broadcasts error output to listeners. Separately, `shouldAutoRestart` enforces `MAX_AUTO_RESTARTS_PER_WINDOW` (3 restarts in 5s).

**Where**: `session-manager.ts` lines 1048-1085

**Why it matters**: Phase 2 extracts this to the timer manager. The error path and rate limiter have zero coverage.

**Current coverage**: NOT TESTED. The 6 auto-restart tests cover happy-path restart and suppression but never test spawn failure or rate limiting.

**Suggested tests**:
```
Describe: "auto-restart error handling"
  - Mock prepareAgentLaunch to throw on second call
  - Start session, trigger exit (fires auto-restart), wait for restart attempt
  - Assert: store.update called with warningMessage
  - Assert: listener.onOutput received "[quarterdeck] Failed to launch..." text

Describe: "auto-restart rate limiting"
  - Start session with listener attached
  - Trigger 3 rapid exits (within AUTO_RESTART_WINDOW_MS)
  - Assert: 3 spawns occurred
  - Trigger 4th exit
  - Assert: no 4th spawn (rate limited)
```

#### Gap 8: markInterruptedAndStopAll

**What**: Shutdown path that marks all active sessions as interrupted and stops them. Called by `ShutdownCoordinator`.

**Where**: `session-manager.ts` lines 939-951

**Why it matters**: Phase 5 leaves this on the coordinator. It's tested indirectly via shutdown coordinator integration tests, but never directly.

**Current coverage**: NOT DIRECTLY TESTED (only via shutdown coordinator).

**Suggested test**:
```
Describe: "markInterruptedAndStopAll"
  - Start 2 task sessions
  - Call markInterruptedAndStopAll
  - Assert: both sessions in "interrupted" state
  - Assert: both PIDs stopped
```

#### Gap 9: Spawn failure paths

**What**: When `PtySession.spawn` throws (ENOENT, system error), the manager sets state to "failed" and runs launch cleanup.

**Where**: `session-manager.ts` lines 540-570 (task), lines 716-733 (shell)

**Current coverage**: NOT TESTED.

**Suggested test**:
```
Describe: "task session spawn failure"
  - Mock PtySession.spawn to throw Error("ENOENT")
  - Call startTaskSession
  - Assert: throws with "Failed to launch" message
  - Assert: store has state=failed, reviewReason=error
  - Assert: launch.cleanup() was called
```

---

### Tier 3: Lower-Risk Gaps

These are real gaps but less likely to break during the refactor.

| Gap | What's Missing | Risk | Notes |
|---|---|---|---|
| State machine edge cases | `hook.to_review` no-op from non-running states | Low | Implicit in other tests |
| `process.exit` with interrupted=true | Direct reducer test | Medium | Only tested indirectly |
| `agent.prompt-ready` transition | Direct reducer test for Codex flow | Medium | Tested via deferred startup tests |
| `canReturnToRunning` comprehensive | All reason values | Low | Most are tested indirectly |
| `pauseOutput` / `resumeOutput` | Delegate to PTY | Low | Trivial pass-through |
| `stopTaskSessionAndWaitForExit` | Async stop with timeout | Low | Used in runtime-api, tested via E2E |
| Store mutation safety | `listSummaries` returns clones | Low | Convention, not critical |
| `isProcessAlive` EPERM handling | Windows edge case | Low | Not relevant to macOS dev |

---

## Recommended Test Build-Out Sequence

### Before refactor (regression safety net)

**Phase A: Ordering invariants** (Tier 1, ~10 tests)
1. onData transition-before-broadcast (Gap 1)
2. writeInput CR/LF optimistic transition (Gap 2)
3. writeInput Codex flag ordering (Gap 3)
4. Checkpoint activity-before-capture ordering (Gap 4)

**Phase B: Untested subsystems** (Tier 2, ~20 tests)
5. Workspace trust auto-confirm flow (Gap 5)
6. Trust helper unit tests (Gap 5)
7. Shell session lifecycle (Gap 6)
8. Auto-restart error handling + rate limiting (Gap 7)
9. markInterruptedAndStopAll (Gap 8)
10. Spawn failure paths (Gap 9)

**Phase C: State machine completeness** (Tier 3, ~8 tests)
11. Missing reducer transitions (interrupted, agent.prompt-ready)
12. `canReturnToRunning` comprehensive
13. `detectOutputTransition` adapter integration

### After refactor (new module tests)

14. `SessionTimerManager` unit tests (10 tests, per test spec)
15. `WorkspaceTrustHandler` unit tests (12 tests, per test spec)

---

## Test Infrastructure Notes

**Mocking pattern**: All integration-style tests use `vi.mock` on `PtySession` and `prepareAgentLaunch` at the module level. The mock PtySession provides `triggerData(chunk)`, `triggerExit(code)`, `write` spy, `resize` spy, `pid`, `stop`, `pause`, `resume`, `wasInterrupted`. Follow this pattern for new tests.

**Timer testing**: Use `vi.useFakeTimers()` for any test involving `setTimeout` (interrupt recovery, workspace trust confirm, auto-restart rate limiting). Call `vi.advanceTimersByTime(ms)` to advance. Remember to call `vi.useRealTimers()` in afterEach.

**Store access**: Instantiate `new InMemorySessionSummaryStore()` (real, not mocked) and pass to `new TerminalSessionManager(store)`. Use `store.getSummary(taskId)` to assert state. Only `hooks-api.test.ts` fully mocks the store.

**File locations**: New test files go in `test/runtime/terminal/`. Trust helper tests: `test/runtime/terminal/claude-workspace-trust.test.ts`, `test/runtime/terminal/codex-workspace-trust.test.ts`.
