---
project: session-lifecycle-refactor
date: 2026-04-12
status: research
---

# Research: Session Lifecycle Refactor

## Codebase Research Summary

### File Under Refactor

`src/terminal/session-manager.ts` — 1,186 lines, ~1,024 lines of meaningful code (excluding imports/whitespace).

### Responsibility Breakdown

| Responsibility | Lines (approx) | Most Intertwined With |
|---|---|---|
| PTY Process Management | ~530 | Everything (host closure for onData/onExit) |
| Workspace Trust | ~70 | PTY onData, Timer cleanup, Codex deferred input |
| Codex Quirks | ~55 | PTY onData, State machine, writeInput |
| State Machine Transitions | ~24 | Timer mgmt, Trust buffer, Codex flags |
| Timer Management | ~80 | PTY exit, State machine, writeInput, Reconciliation |
| Listener Management | ~35 | PTY onData/onExit, Reconciliation, Auto-restart |
| Reconciliation Dispatch | ~80 | PTY exit (duplicated logic), Timer cleanup |
| Hydration/Stale Recovery | ~50 | Auto-restart, Store |
| Types/Constants/Utilities | ~100 | N/A |

### onData Callback — Execution Order (lines 376-491)

The `onData` callback inside `startTaskSession` is the most complex code path and the primary extraction risk. Nine synchronous steps execute in strict order:

1. **Early-exit guard** (377-379) — checks `entry.active`
2. **Terminal protocol filtering** (381-387) — produces `filteredChunk`, may write OSC replies
3. **Terminal state mirror update** (388) — feeds filtered output to headless xterm
4. **Conditional UTF-8 decode** (390-397) — decodes only if trust buffer or transition detector needs it
5. **Workspace trust detection + auto-confirm scheduling** (398-454) — accumulates buffer, schedules setTimeout for confirm
6. **Update lastOutputAt** (455) — heartbeat timestamp
7. **Codex deferred startup input** (459-471) — sends deferred prompt when TUI renders
8. **Output-transition detection + state event** (473-487) — Codex prompt-ready detection, calls `applySessionEventWithSideEffects`
9. **Broadcast to listeners** (489-491) — sends filtered chunk to all attached listeners

**Load-bearing orderings:**
- Step 2 before Step 3: Mirror must receive filtered output
- Step 4 before Steps 5, 7, 8: All consume decoded `data` string
- Step 5 before Step 7: Trust buffer content used as fallback for Codex startup detection
- Step 8 before Step 9: Listeners must see post-transition state, not pre-transition

### onExit Callback — Execution Order (lines 493-540)

1. Log + fetch entry
2. Stop trust + interrupt timers (must happen before nulling `active`)
3. Apply `process.exit` event via state machine
4. Check auto-restart eligibility
5. Notify listeners (must see post-exit state)
6. Null `active`, resolve pending exit promises (must happen after listener notification)
7. Schedule auto-restart (must happen after `active = null`)
8. Run async cleanup function (fire-and-forget)

### writeInput — Execution Order (lines 817-862)

1. Guard (entry + active check)
2. Codex `awaitingCodexPromptAfterEnter` flag set (must happen before PTY write)
3. Immediate transition to running on CR/LF (must happen before PTY write)
4. Interrupt detection + suppress auto-restart (must happen before PTY write)
5. Write to PTY
6. Return current summary

**Critical invariant:** Steps 2-4 must all complete synchronously before Step 5. Any async boundary would break Codex prompt suppression and interrupt detection.

### External Consumers

| Consumer | Depends on | Needs from refactor |
|---|---|---|
| `ws-server.ts` | `TerminalSessionService` interface only | No changes |
| `workspace-registry.ts` | Class (instantiation) | Import path if class moves |
| `runtime-api.ts` | Class type (methods beyond interface) | Import path |
| `hooks-api.ts` | Class type (only `store`) | Could depend on `SessionSummaryStore` directly |
| `workspace-api.ts` | Class type (only `store`) | Could depend on `SessionSummaryStore` directly |
| `runtime-state-hub.ts` | Class type (only `store.onChange`) | Could depend on `SessionSummaryStore` directly |
| `shutdown-coordinator.ts` | Class type (lifecycle methods) | Import path |

### Test Coupling

| Test File | Internal Access | Risk Level |
|---|---|---|
| `session-manager.test.ts` | 4 tests inject into `entries` Map via cast | **Medium** — these break if entries moves |
| `session-manager-reconciliation.test.ts` | Public API only | **None** |
| `session-manager-interrupt-recovery.test.ts` | Public API only | **None** |
| `session-manager-auto-restart.test.ts` | Public API only | **None** |
| `session-reconciliation.test.ts` | Uses exported `ReconciliationEntry` interface | **None** |
| `hooks-api.test.ts` | Casts mock to `TerminalSessionManager` for `store` | **Low** |
| `shutdown-coordinator*.test.ts` | Stubs public methods | **Low** |

### Refactor Doc Claim Verification

| Claim | Verdict | Impact on Plan |
|---|---|---|
| "~1,350 lines" | Overstated (1,186 actual) | Minor — still warrants refactor |
| "hooks-api duplicates isPermissionActivity" | **Inaccurate** — hooks-api imports it | Phase 6 (permission guard consolidation) is less motivated |
| "canTransitionTaskForHookEvent re-implements reducer" | Guard-before-dispatch, not duplication | Moving it to state machine is less justified |
| "Both manager and reconciliation trigger processless recovery" | Complementary, not redundant | Don't merge them |
| "notify+emit pattern ~10 times" | 7 times | Still worth a helper |
| "SessionSummaryStore already extracted" | Accurate and complete | Phase 3 (summary manager) has less work than expected |

### Key Duplication: Exit Handler

`recover_dead_process` in reconciliation (lines 1119-1144) duplicates the PTY `onExit` handler (lines 499-539):
- Both: stop trust timers, clear interrupt timer, apply `process.exit` event, notify listeners, flush exit resolvers, run cleanup
- A shared `finalizeProcessExit()` helper would eliminate this duplication safely

### Design Decision

**Single approach — no competing options.** The research confirms the decomposition direction from the refactor doc is sound. The corrections above refine the plan but don't change the fundamental approach:
1. De-duplicate shared patterns (exit finalization, listener notification)
2. Extract self-contained concerns (timers, workspace trust)
3. Extract the PTY process pipeline
4. Reduce the coordinator

The original plan's Phases 1 and 6 (state machine enrichment, permission guard consolidation) are less justified than claimed and should be scoped down or removed.
