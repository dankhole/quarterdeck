# Session Lifecycle Refactor — Test Specification

**Date**: 2026-04-12
**SDD**: docs/forge/2026-04-12-session-lifecycle-refactor/spec.md

## Strategy

The primary test strategy is: **all existing tests pass unchanged**. The existing test suite exercises the full session lifecycle through the public API and covers all behavioral paths. New unit tests are added only for the newly extracted modules.

## Existing Tests (must pass unchanged)

| File | Tests | Risk Level |
|---|---|---|
| `test/runtime/terminal/session-manager.test.ts` | 23 tests, 4 use internal casts | Medium — may need `trustHandler: null` in fakes |
| `test/runtime/terminal/session-manager-reconciliation.test.ts` | 21 tests, public API | None |
| `test/runtime/terminal/session-manager-interrupt-recovery.test.ts` | 16 tests, public API | None |
| `test/runtime/terminal/session-manager-auto-restart.test.ts` | 6 tests, public API | None |
| `test/runtime/terminal/session-reconciliation.test.ts` | 37 tests, pure functions | None |
| `test/runtime/trpc/hooks-api.test.ts` | 21 tests, mocked store | None |

## New Tests

### SessionTimerManager (Phase 2)

**File**: `test/runtime/terminal/session-timer-manager.test.ts`

| # | Test | What it verifies |
|---|---|---|
| 1 | `scheduleInterruptRecovery fires callback after INTERRUPT_RECOVERY_DELAY_MS` | Timer fires, callback invoked with correct taskId |
| 2 | `clearInterruptRecoveryTimer cancels pending timer` | Timer cleared, callback never fires |
| 3 | `scheduleInterruptRecovery replaces existing timer` | Old timer cleared, new timer starts |
| 4 | `shouldAutoRestart returns false when suppressed` | suppressAutoRestartOnExit flag respected |
| 5 | `shouldAutoRestart returns false with no listeners` | No restart when no one is watching |
| 6 | `shouldAutoRestart returns false when rate limited` | MAX_AUTO_RESTARTS_PER_WINDOW enforced |
| 7 | `shouldAutoRestart returns true under normal conditions` | Happy path |
| 8 | `scheduleAutoRestart sets pendingAutoRestart synchronously` | !5 — Promise assigned in same tick |
| 9 | `scheduleAutoRestart no-ops if already pending` | Idempotent |
| 10 | `scheduleAutoRestart calls onAutoRestart callback` | Callback invoked with correct request |

### WorkspaceTrustHandler (Phase 3)

**File**: `test/runtime/terminal/workspace-trust-handler.test.ts`

| # | Test | What it verifies |
|---|---|---|
| 1 | `processOutput accumulates buffer up to MAX_WORKSPACE_TRUST_BUFFER_CHARS` | Buffer caps at limit, older content trimmed |
| 2 | `processOutput detects Claude workspace trust prompt` | Calls onConfirm after delay |
| 3 | `processOutput detects Codex workspace trust prompt` | Same for Codex |
| 4 | `auto-confirm fires after WORKSPACE_TRUST_CONFIRM_DELAY_MS` | Timer-based confirm |
| 5 | `clearBuffer resets buffer to empty` | Buffer cleared on state transition |
| 6 | `getBuffer returns current buffer content` | Used by Codex deferred input check |
| 7 | `stop clears confirm timer` | No confirm after stop |
| 8 | `caps at MAX_AUTO_TRUST_CONFIRMS then disables` | Confirm count cap, calls onWarning |
| 9 | `isEnabled returns false when constructed without auto-trust` | Shell sessions |
| 10 | `multiple trust prompts auto-confirmed up to cap` | Sequential trust confirmations (--add-dir) |
| 11 | `after confirm, re-enables detection for next trust prompt` | autoConfirmedWorkspaceTrust resets to false after confirm fires (below cap) |
| 12 | `processOutput is no-op after stop` | No buffer accumulation, no timer scheduling after stop() |

### PtyProcessManager (Phase 4)

No new test file. The existing integration-style tests (`session-manager-reconciliation.test.ts`, `session-manager-interrupt-recovery.test.ts`, `session-manager-auto-restart.test.ts`) exercise the PTY process manager through the coordinator. The coordinator delegates to the PTY manager, so these tests implicitly cover it.

If specific PTY manager behaviors are found to be undertested during implementation, add targeted tests at that point.

## Test Commands

```bash
# Run all tests (must pass at every phase checkpoint)
npm run test:fast

# Run specific test file
npx vitest run test/runtime/terminal/session-timer-manager.test.ts
npx vitest run test/runtime/terminal/workspace-trust-handler.test.ts

# Run full suite including integration
npm run test

# Typecheck
npm run typecheck
```
