# Test Specification: Shell Terminal Auto-Restart

**Date**: 2026-04-07
**Companion SDD**: [docs/specs/2026-04-07-shell-terminal-auto-restart.md](./2026-04-07-shell-terminal-auto-restart.md)
**Adversarial Review Passes**: 3

## Test Strategy

Testing is split across two layers matching the implementation:

1. **Web UI unit tests** for the new `useShellAutoRestart` hook — the core logic (rate limiting, exit code filtering, timer management)
2. **Web UI unit tests** for the settings integration — config persistence round-trip
3. **Runtime unit tests** for the config layer — schema validation, normalization, persistence

The hook tests use the established pattern in this codebase: `createRoot`/`act` with a wrapper component that captures hook return values (see `web-ui/src/hooks/use-terminal-panels.test.tsx`).

### Test Infrastructure

- **Framework**: Vitest (both runtime and web-ui)
- **Test directories**: `web-ui/src/hooks/` for hook tests, `test/runtime/` for config tests
- **Run commands**:
  - Web UI tests: `npm run web:test`
  - Runtime tests: `npm run test:fast`
  - All tests: `npm run check`
- **CI integration**: Tests run via `test.yml` workflow on Ubuntu (Node 20, 22) and macOS (Node 22)

### Coverage Goals

- Every exit code path (0, non-zero, null) has a test
- Rate limiting boundary conditions (0, 1, 2, 3, 4 restarts) are tested
- Timer cleanup on unmount is tested
- Setting toggle on/off is tested
- Shell vs agent filtering is tested
- Config persistence round-trip is tested

## Unit Tests

### useShellAutoRestart Hook

**Test file**: `web-ui/src/hooks/use-shell-auto-restart.test.ts`
**Pattern to follow**: See `web-ui/src/hooks/use-terminal-panels.test.tsx` for hook testing pattern, and `test/runtime/terminal/session-manager-auto-restart.test.ts` for auto-restart rate-limiting test structure.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `does not restart on clean exit (exit code 0)` | Exit code 0 is treated as intentional — no restart |
| 2 | `restarts on non-zero exit code` | Exit code 1 (or any non-zero) triggers restart after delay |
| 3 | `restarts on null exit code (signal kill)` | Null exit code (OOM, SIGKILL) triggers restart |
| 4 | `does not restart when setting is disabled` | `shellAutoRestartEnabled: false` suppresses all auto-restarts |
| 5 | `waits 1 second before restarting` | Restart handler is not called immediately — only after 1000ms |
| 6 | `rate limits to 3 restarts per 30s window` | 4th restart within 30s is blocked |
| 7 | `shows crash loop message on rate limit hit` | `writeToTerminal` called with crash-loop message |
| 8 | `rate limit resets after 30s window` | After 30s, restarts are allowed again |
| 9 | `rate limits independently per taskId` | Home and detail terminals have separate rate counters |
| 10 | `calls home restart handler for home terminal` | `HOME_TERMINAL_TASK_ID` routes to `restartHomeTerminal` |
| 11 | `calls detail restart handler for detail terminal with extracted cardId` | `__detail_terminal__:<cardId>` extracts cardId and passes to `restartDetailTerminal(cardId)` |
| 12 | `cleans up pending timers on unmount` | Unmount before timer fires — restart handler never called |
| 13 | `writes restart message before restarting` | `writeToTerminal` called with restart message before handler |
| 28 | `setting change takes effect on next exit` | Toggling `shellAutoRestartEnabled` from true to false suppresses the next exit's auto-restart |
| 31 | `ignores exit for detail terminal with empty cardId` | `__detail_terminal__:` (empty cardId) is treated as malformed and ignored |

#### Test Details

##### 1. `does not restart on clean exit (exit code 0)`

**Setup**: Create hook with `shellAutoRestartEnabled: true`, mock restart handlers, `isSessionRunning: vi.fn().mockReturnValue(false)`.
**Action**: Call `handleShellExit("__home_terminal__", 0)`.
**Assertions**:
- `restartHomeTerminal` is NOT called
- `writeToTerminal` is NOT called with restart message
- After advancing timers by 2000ms, `restartHomeTerminal` is still NOT called

##### 2. `restarts on non-zero exit code`

**Setup**: Create hook with `shellAutoRestartEnabled: true`, mock restart handlers. Use `vi.useFakeTimers()`.
**Action**: Call `handleShellExit("__home_terminal__", 1)`.
**Assertions**:
- `writeToTerminal` called with `"__home_terminal__"` and message containing `"restarting"`
- Before 1000ms: `restartHomeTerminal` NOT called
- After advancing timers by 1000ms: `restartHomeTerminal` called exactly once

##### 3. `restarts on null exit code (signal kill)`

**Setup**: Same as #2.
**Action**: Call `handleShellExit("__home_terminal__", null)`.
**Assertions**:
- After advancing timers by 1000ms: `restartHomeTerminal` called exactly once

##### 4. `does not restart when setting is disabled`

**Setup**: Create hook with `shellAutoRestartEnabled: false`, mock restart handlers.
**Action**: Call `handleShellExit("__home_terminal__", 1)`.
**Assertions**:
- After advancing timers by 2000ms: `restartHomeTerminal` NOT called
- `writeToTerminal` NOT called

##### 5. `waits 1 second before restarting`

**Setup**: Create hook with `shellAutoRestartEnabled: true`. Use `vi.useFakeTimers()`.
**Action**: Call `handleShellExit("__home_terminal__", 1)`.
**Assertions**:
- At 0ms: `restartHomeTerminal` NOT called
- At 500ms: `restartHomeTerminal` NOT called
- At 999ms: `restartHomeTerminal` NOT called
- At 1000ms: `restartHomeTerminal` called once

##### 6. `rate limits to 3 restarts per 30s window`

**Setup**: Create hook with `shellAutoRestartEnabled: true`, `isSessionRunning: vi.fn().mockReturnValue(false)`. Use `vi.useFakeTimers()`.
**Action**: Call `handleShellExit("__home_terminal__", 1)` four times, advancing timers by 1100ms between each.
**Assertions**:
- After 1st: `restartHomeTerminal` called 1 time
- After 2nd: `restartHomeTerminal` called 2 times
- After 3rd: `restartHomeTerminal` called 3 times
- After 4th: `restartHomeTerminal` still called 3 times (blocked)
- `writeToTerminal` called with crash-loop message on 4th attempt

##### 7. `shows crash loop message on rate limit hit`

**Setup**: Same as #6 — exhaust rate limit.
**Action**: Call `handleShellExit("__home_terminal__", 1)` when rate limit is exhausted.
**Assertions**:
- `writeToTerminal` called with `"__home_terminal__"` and message containing `"could not be restarted automatically"`

##### 8. `rate limit resets after 30s window`

**Setup**: Create hook, exhaust rate limit (3 restarts with 1100ms advances between each to resolve their timers — total ~3300ms elapsed). Use `vi.useFakeTimers()`.
**Action**: Advance time by an additional 31 seconds (past the 30s window from the first restart's timestamp), then call `handleShellExit("__home_terminal__", 1)`.
**Assertions**:
- After advancing timers by 1000ms: `restartHomeTerminal` called (restart allowed again — the 3 previous timestamps are now older than 30s and pruned)

##### 9. `rate limits independently per taskId`

**Setup**: Create hook.
**Action**: Exhaust rate limit for `"__home_terminal__"` (3 restarts), then call for `"__detail_terminal__:card-1"`.
**Assertions**:
- `restartDetailTerminal` called (not blocked by home terminal's rate limit)
- `restartHomeTerminal` NOT called again (still blocked)

##### 10. `calls home restart handler for home terminal`

**Setup**: Create hook with both mock handlers.
**Action**: Call `handleShellExit("__home_terminal__", 1)`, advance timers.
**Assertions**:
- `restartHomeTerminal` called once
- `restartDetailTerminal` NOT called

##### 11. `calls detail restart handler for detail terminal with extracted cardId`

**Setup**: Create hook with both mock handlers. `restartDetailTerminal` is `vi.fn()`.
**Action**: Call `handleShellExit("__detail_terminal__:card-abc", 1)`, advance timers.
**Assertions**:
- `restartDetailTerminal` called once with `"card-abc"` as the argument
- `restartHomeTerminal` NOT called

##### 12. `cleans up pending timers on unmount`

**Setup**: Create hook. Use `vi.useFakeTimers()`.
**Action**: Call `handleShellExit("__home_terminal__", 1)`. Unmount the hook. Advance timers by 2000ms.
**Assertions**:
- `restartHomeTerminal` NOT called (timer was cleared on unmount)

##### 13. `writes restart message before restarting`

**Setup**: Create hook.
**Action**: Call `handleShellExit("__home_terminal__", 1)`.
**Assertions**:
- `writeToTerminal` called immediately (before timer fires)
- After timer fires: `restartHomeTerminal` called
- Call order: `writeToTerminal` before `restartHomeTerminal`

##### 28. `setting change takes effect on next exit`

**Setup**: Create hook with `shellAutoRestartEnabled: true`. Use `vi.useFakeTimers()`.
**Action**:
1. Call `handleShellExit("__home_terminal__", 1)`, advance timers — restart fires (baseline).
2. Re-render the hook with `shellAutoRestartEnabled: false`.
3. Call `handleShellExit("__home_terminal__", 1)` again.
**Assertions**:
- After step 1: `restartHomeTerminal` called once
- After step 3 + advancing timers: `restartHomeTerminal` still called only once (not called again)

---

### PersistentTerminal onExit Subscriber

**Test file**: `web-ui/src/terminal/use-persistent-terminal-session.test.tsx`
**Action**: Extend existing test file.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 14 | `onExit callback fires when exit control message is received` | Subscriber interface extension works |
| 15 | `onExit includes taskId and exit code` | Correct arguments passed to callback |
| 29 | `onExit is NOT called when latestSummary.agentId is non-null` | Agent filtering in `notifyExit` works |

#### Test Details

##### 14. `onExit callback fires when exit control message is received`

**Setup**: Use `usePersistentTerminalSession` hook with an `onExit` mock callback. The test works through the hook (not `PersistentTerminal` directly, which is not exported). Use the existing test pattern in `use-persistent-terminal-session.test.tsx` which mocks `ensurePersistentTerminal` to return a fake terminal object. The fake terminal's `subscribe` method captures the subscriber, then the test simulates an exit by calling the captured `onExit` callback (or by triggering the WebSocket control message handler if the mock is deep enough). The simplest approach: mock `ensurePersistentTerminal` to return an object whose `subscribe(subscriber)` stores the subscriber, then invoke `subscriber.onExit?.(taskId, 1)` to simulate the exit event.
**Action**: Mount the hook, then trigger the stored subscriber's `onExit` with `(taskId, 1)`.
**Assertions**:
- The `onExit` prop passed to the hook is called once with correct taskId and exit code 1

##### 15. `onExit includes taskId and exit code`

**Setup**: Same as #14 but trigger with `code: null`.
**Assertions**:
- The `onExit` prop called with `(taskId, null)`

##### 29. `onExit is NOT called when latestSummary.agentId is non-null`

**File**: `web-ui/src/terminal/use-persistent-terminal-session.test.tsx`
**Setup**: Mock `ensurePersistentTerminal` to return a fake terminal object. The fake terminal must implement a minimal version of `notifyExit` that mirrors the real logic: check `this.latestSummary?.agentId` and return early when non-null. Set `latestSummary` on the fake terminal to `{ agentId: "claude-agent-123", state: "running" }` (non-null `agentId`, indicating an agent session). The fake terminal's `subscribe` method captures the subscriber.
**Action**: Call the fake terminal's `notifyExit(1)` method (which checks `latestSummary.agentId`, finds it non-null, and returns without calling `subscriber.onExit`).
**Assertions**:
- The `onExit` mock is NOT called
- This verifies the centralized agent-filtering logic. Note: since `PersistentTerminal` is not exported, this test verifies the behavior through the fake terminal's reimplemented guard. The real `notifyExit` method is verified through manual behavioral testing (SDD Phase 1 success criteria).
**Alternative approach**: If the fake terminal pattern proves too coupled to internals, this test may be replaced with a behavioral integration test that mounts a real `PersistentTerminal` via `ensurePersistentTerminal` with a mocked WebSocket and verifies the end-to-end flow. This is acknowledged as manual verification if the unit test is impractical.

---

### Config: shellAutoRestartEnabled

**Test file**: `test/runtime/config/runtime-config.test.ts` (extend existing, or create if none exists)
**Pattern to follow**: Check existing config tests for normalization patterns.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 16 | `defaults to true when not in config file` | Normalization applies default |
| 17 | `persists false value to config file` | Write round-trip works |
| 18 | `persists true value to config file` | Write round-trip works |
| 19 | `appears in Zod response schema` | API contract includes the field |
| 20 | `save request accepts optional boolean` | API contract for save is correct |

---

## Edge Cases & Error Scenarios

These tests were identified during the viability assessment.

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 21 | `does not double-restart when manual restart is in progress` | User clicks restart button, which triggers stop (exit event) + start. Auto-restart timer fires but session is already running. | Auto-restart timer callback calls `isSessionRunning(taskId)` — returns true, restart is a no-op. | Viability assessment: `stopTaskSession` causes exit event that could trigger auto-restart |
| 22 | `handles restart handler throwing` | tRPC call in restart handler rejects. | Error is caught. Rate limiter already counted the attempt. No unhandled promise rejection. | Error handling table |
| 23 | `does not auto-restart agent terminal exits` | Agent terminal exits with non-zero code. | `handleShellExit` is never called for agent sessions (filtered by `agentId !== null` at call site). | Core requirement |
| 30 | `writeToTerminalBuffer is a silent no-op when terminal not found` | `writeToTerminalBuffer` called with a workspaceId/taskId that has no terminal in the map. | No throw, no error. | Robustness of module-level utility |
| 31 | `ignores exit for detail terminal with empty cardId` | `__detail_terminal__:` with empty cardId suffix. | Neither restart handler called, no restart message written. | Empty cardId guard (review finding #10) |

#### Test Details

##### 21. `does not double-restart when manual restart is in progress`

**Setup**: Create hook with `shellAutoRestartEnabled: true`, mock restart handlers, and `isSessionRunning: vi.fn()`. Use `vi.useFakeTimers()`.
**Action**:
1. Call `handleShellExit("__home_terminal__", 1)` — this schedules a restart timer.
2. Before the timer fires, call `cancelPendingRestart("__home_terminal__")` (simulating what the manual restart handler does), and set `isSessionRunning` mock to return `true` (simulating the manual restart completing).
3. Advance timers by 1000ms.
**Assertions**:
- `restartHomeTerminal` NOT called (the timer was cancelled by `cancelPendingRestart`)
- `writeToTerminal` WAS called with the restart message (the message is written immediately, before the timer)
- **Note**: The `isSessionRunning` guard is a fallback — `cancelPendingRestart` is the primary prevention mechanism. If the tRPC round-trip is slow and the timer fires before the manual restart completes, `isSessionRunning` returns `true` and prevents the double-restart. This is acknowledged as a timing-dependent fallback.

##### 22. `handles restart handler throwing`

**Setup**: Create hook with `shellAutoRestartEnabled: true`. Set `restartHomeTerminal` to `vi.fn(() => { throw new Error("tRPC failed"); })`. Use `vi.useFakeTimers()`.
**Action**: Call `handleShellExit("__home_terminal__", 1)`, advance timers by 1000ms.
**Assertions**:
- No unhandled promise rejection (the hook wraps the restart call in try/catch)
- `restartHomeTerminal` was called (attempted)
- Rate limiter counted the attempt (timestamp is recorded inside setTimeout before calling the restart handler, so even though the handler throws, the timestamp was already recorded): trigger `handleShellExit` two more times (with timer advances), then on the 4th call, `writeToTerminal` is called with crash-loop message

##### 23. `does not auto-restart agent terminal exits`

**Setup**: Create hook with `shellAutoRestartEnabled: true`, mock restart handlers. Use `vi.useFakeTimers()`.
**Action**: This test verifies the hook-level guard — if `handleShellExit` is called with a taskId that doesn't match `HOME_TERMINAL_TASK_ID` or `__detail_terminal__:*` pattern, neither restart handler is called. (The primary agent-filtering test is #29, which verifies `notifyExit` in `PersistentTerminal` never fires `onExit` for agent sessions.)
**Assertions**:
- Call `handleShellExit("some-agent-task-id", 1)`, advance timers — neither `restartHomeTerminal` nor `restartDetailTerminal` called

##### 31. `ignores exit for detail terminal with empty cardId`

**Setup**: Create hook with `shellAutoRestartEnabled: true`, mock restart handlers, `isSessionRunning: vi.fn().mockReturnValue(false)`. Use `vi.useFakeTimers()`.
**Action**: Call `handleShellExit("__detail_terminal__:", 1)`, advance timers by 2000ms.
**Assertions**:
- `restartDetailTerminal` NOT called (empty cardId is treated as malformed)
- `restartHomeTerminal` NOT called
- `writeToTerminal` NOT called with restart message (the empty cardId check happens at taskId routing time, before writing the message or scheduling the timer)

##### 30. `writeToTerminalBuffer is a silent no-op when terminal not found`

**File**: `web-ui/src/terminal/persistent-terminal-manager.test.ts` (extend existing, or create if none exists)
**Setup**: Import `writeToTerminalBuffer` directly from `persistent-terminal-manager.ts`. No mock setup is needed — the module-level `terminals` map starts empty in a fresh test environment (Vitest isolates modules per test file by default). If the test file imports other functions that populate the map, call the test before any `ensurePersistentTerminal` calls, or use a dedicated `describe` block to ensure isolation.
**Action**: Call `writeToTerminalBuffer("nonexistent-workspace", "nonexistent-task", "test message")`.
**Assertions**:
- No error is thrown
- Function returns `undefined` (no-op)

---

## Regression Tests

Tests that ensure existing behavior isn't broken by the new implementation.

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 24 | `manual restart button still works when auto-restart is enabled` | Clicking restart button restarts the terminal | `web-ui/src/hooks/use-terminal-panels.ts:404-413` |
| 25 | `manual restart button still works when auto-restart is disabled` | Same behavior regardless of setting | `web-ui/src/hooks/use-terminal-panels.ts:404-413` |
| 26 | `agent auto-restart behavior unchanged` | Backend agent auto-restart is not affected | `src/terminal/session-manager.ts:1077-1095` |
| 27 | `existing config settings preserved after adding new field` | Adding `shellAutoRestartEnabled` doesn't drop existing config values | `src/config/runtime-config.ts:282` |

#### Test Details

##### 24. `manual restart button still works when auto-restart is enabled`

**File**: `web-ui/src/hooks/use-terminal-panels.test.tsx`
**Setup**: Render `useTerminalPanels` with standard mocks. Mock tRPC `stopTaskSession` and session start to resolve. Ensure `shellAutoRestartEnabled` is `true` (the auto-restart hook is active).
**Action**: Call `handleRestartHomeTerminal()`.
**Assertions**:
- `stopTaskSession` is called with `{ taskId: "__home_terminal__" }`
- `startHomeTerminalSession` is called after stop completes
- The restart completes without interference from the auto-restart hook

##### 25. `manual restart button still works when auto-restart is disabled`

**File**: `web-ui/src/hooks/use-terminal-panels.test.tsx`
**Setup**: Same as #24 but with `shellAutoRestartEnabled: false`.
**Action**: Call `handleRestartHomeTerminal()`.
**Assertions**:
- Same assertions as #24 — the manual restart path is completely independent of the auto-restart setting

##### 26. `agent auto-restart behavior unchanged`

**File**: `test/runtime/terminal/session-manager-auto-restart.test.ts`
**Setup**: Existing test file — verify no tests are broken by the new feature.
**Action**: Run the existing test suite.
**Assertions**:
- All existing agent auto-restart tests pass unchanged

##### 27. `existing config settings preserved after adding new field`

**File**: `test/runtime/config/runtime-config.test.ts`
**Setup**: Create a config file with existing settings (e.g., `readyForReviewNotificationsEnabled: false`). Load, add `shellAutoRestartEnabled: false`, save.
**Action**: Re-load the config file.
**Assertions**:
- `readyForReviewNotificationsEnabled` is still `false` (not overwritten)
- `shellAutoRestartEnabled` is `false` (new value persisted)

**Note**: Settings dialog UI placement (toggle appears under "Terminal" section heading, positioned between "Notifications" and "Layout" sections) is verified by manual inspection only — no automated test is added for visual layout ordering.

---

## Test Execution Plan

Tests should be written BEFORE the implementation code they validate. This is a per-phase TDD sequence.

### Phase 1: onExit Subscriber

1. **Write tests** — #14, #15, #29
   - Run: `npm run web:test` — FAIL (onExit doesn't exist yet)
2. **Implement Phase 1** — add onExit to subscriber interface
   - Run: `npm run web:test` — pass

### Phase 2: Settings Toggle

1. **Write config tests** — #16, #17, #18, #19, #20
   - Run: `npm run test:fast` — FAIL
2. **Implement Phase 2** — add config + settings dialog
   - Run: `npm run test:fast` — pass
   - Run: `npm run web:test` — pass
3. **Write regression test** — #27
   - Run: `npm run test:fast` — pass

### Phase 3: Auto-Restart Logic

1. **Write regression tests** — #24, #25, #26
   - Run: `npm run web:test && npm run test:fast` — pass (baseline)
2. **Write hook tests** — #1 through #13, #28
   - Run: `npm run web:test` — FAIL (hook doesn't exist yet)
3. **Implement Phase 3** — create hook, wire up
   - Run: `npm run web:test` — pass
4. **Write edge case tests** — #21, #22, #23, #30, #31
   - Run: `npm run web:test` — pass (these test existing guard behavior)

### Commands

```bash
# Run all tests for this feature
npm run check

# Run web UI tests only (hook + component tests)
npm run web:test

# Run runtime tests only (config tests)
npm run test:fast

# Run a specific test file
npx vitest run web-ui/src/hooks/use-shell-auto-restart.test.ts

# Run with verbose output for debugging
npx vitest run --reporter=verbose web-ui/src/hooks/use-shell-auto-restart.test.ts
```

## Traceability Matrix

Every SDD requirement maps to at least one test.

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Phase 1: onExit subscriber callback | #14, #15, #29 | Unit |
| Phase 2: Config default value | #16 | Unit |
| Phase 2: Config persistence | #17, #18 | Unit |
| Phase 2: Zod schema | #19, #20 | Unit |
| Phase 2: Config doesn't break existing settings | #27 | Regression |
| Phase 3: No restart on exit code 0 | #1 | Unit |
| Phase 3: Restart on non-zero exit | #2 | Unit |
| Phase 3: Restart on null exit code (signal) | #3 | Unit |
| Phase 3: Setting disables auto-restart | #4 | Unit |
| Phase 3: 1-second delay before restart | #5 | Unit |
| Phase 3: Rate limit (3 per 30s) | #6, #8 | Unit |
| Phase 3: Crash loop message | #7 | Unit |
| Phase 3: Per-taskId rate limiting | #9 | Unit |
| Phase 3: Home terminal routing | #10 | Unit |
| Phase 3: Detail terminal routing + cardId extraction | #11 | Unit |
| Phase 3: Timer cleanup on unmount | #12 | Unit |
| Phase 3: Restart message shown | #13 | Unit |
| Phase 3: No double-restart with manual button (cancelPendingRestart + isSessionRunning) | #21 | Edge case |
| Phase 3: Restart handler error resilience | #22 | Edge case |
| Phase 3: Agent terminals unaffected | #23 | Edge case |
| Phase 3: Setting change takes effect dynamically | #28 | Unit |
| Regression: Manual restart still works | #24, #25 | Regression |
| Regression: Agent auto-restart unchanged | #26 | Regression |
| Phase 1: Agent filtering in notifyExit | #29 | Unit |
| Phase 3: writeToTerminalBuffer no-op safety | #30 | Unit |
| Phase 3: Empty cardId guard | #31 | Edge case |
