# Handoff: Session Resume & Interrupted Session Handling

**Branch:** `fix/startup-session-resume-trashing`  
**Date:** 2026-04-13  
**Status:** Typecheck + lint + 717 tests passing. Reviewed via /refine.

---

## Problem

On startup, all interrupted sessions were being auto-trashed by the UI before crash recovery could resume them. Additionally, the UI's auto-trash for interrupted sessions during normal operation was racing with the server's auto-restart system, and auto-restart was starting agents fresh instead of resuming their conversation.

## Root cause

Three independent issues compounding:

1. **Startup trashing:** `use-session-column-sync.ts` had two effects — column sync and crash recovery. On startup, `previousSessionsRef` is empty, so `previous?.state !== "interrupted"` evaluated to `true` for every session (JS truthiness: `undefined !== "interrupted"` is `true`). Effect 1 trashed all interrupted sessions before Effect 2 could resume them.

2. **Auto-trash racing auto-restart:** During normal operation, when an agent crashed, the server's `scheduleAutoRestart` fires async. The UI saw the intermediate "interrupted" state and auto-trashed the card before the restart completed.

3. **Auto-restart lost context:** `session-auto-restart.ts` explicitly set `resumeConversation = false`, starting agents fresh with no memory of their task.

## What changed (9 files)

### Committed (`23a1e5bf`)
- **`workspace-registry.ts`** — Removed server-side task count adjustment that counted interrupted sessions as trash

### Uncommitted (working tree)
All changes below are on top of the committed fix.

#### UI layer (2 files)

- **`use-session-column-sync.ts`** — Major simplification:
  - Merged two effects (column sync + crash recovery) into one
  - Removed the entire `interrupted → trash` branch (33 lines deleted)
  - Removed `blockedInterruptedTaskIds`, `setSelectedTaskId`, `getNextDetailTaskIdAfterTrashMove`
  - Added `isFirstSync` computation (ref empty + sessions arrived)
  - Startup resume now gates on `isFirstSync` instead of being a separate effect
  - Column sync only handles `awaiting_review ↔ in_progress` moves now — server owns the interrupted → review transition
  
- **`use-board-interactions.ts`** — Removed `setSelectedTaskId` from `useSessionColumnSync` call site, updated comment

#### Server layer (4 files)

- **`session-auto-restart.ts`** — Auto-restart now tries `--continue` first, falls back to fresh:
  ```
  try --continue → catch → try fresh → catch → error handler
  ```
  Emits `autorestart.continue_failed` event on fallback.

- **`session-state-machine.ts`** — New event type `autorestart.denied`:
  - Transitions `interrupted → awaiting_review` with reviewReason `"interrupted"`
  - No-op for any other state

- **`session-manager.ts`** — In the `onExit` handler, when `shouldAutoRestart` returns false and the session is interrupted, immediately fires `autorestart.denied` to transition to review.

- **`session-reconciliation.ts`** — New `checkInterruptedNoRestart` check:
  - Catches interrupted sessions with no `pendingAutoRestart` (failed auto-restart, missed onExit transition)
  - Returns `move_interrupted_to_review` action
  - Added to `reconciliationChecks` array (priority: after processless, before stale hook)

- **`session-reconciliation-sweep.ts`** — Handles new action type, expanded filter to include "interrupted" sessions

#### Tests (1 file)

- **`session-reconciliation.test.ts`** — Added:
  - 4 tests for `checkInterruptedNoRestart`
  - 2 tests for `autorestart.denied` state machine event
  - Updated ordering test for 5 checks

---

## Scenario matrix (current behavior)

| # | Scenario | Server behavior | UI behavior | Card outcome |
|---|----------|----------------|-------------|-------------|
| 1 | **Normal work cycle** | running → hook → awaiting_review | Column sync: in_progress → review | Review column |
| 2 | **Agent crash, auto-restart + --continue succeeds** | interrupted → scheduleAutoRestart(--continue) → running | Brief "interrupted" flicker, then running | Stays in in_progress |
| 3 | **Agent crash, --continue fails, fresh succeeds** | interrupted → --continue fails → fresh start → running | Same flicker | Stays in in_progress (lost context) |
| 4 | **Agent crash, both restart attempts fail** | interrupted → error handler → warningMessage set → reconciliation sweep → autorestart.denied → awaiting_review | Column sync: in_progress → review | Review column (within 10s) |
| 5 | **Agent crashes 3x in 5s (rate limit)** | interrupted → shouldAutoRestart=false → autorestart.denied → awaiting_review | Column sync: in_progress → review | Review column (immediate) |
| 6 | **Agent crash, no UI connected** | shouldAutoRestart=false (no listeners) → autorestart.denied → awaiting_review | When UI connects: sees awaiting_review | Review column |
| 7 | **User explicitly stops agent** | suppressAutoRestartOnExit → exit code 0 → awaiting_review/exit | Column sync: in_progress → review | Review column |
| 8 | **Graceful shutdown (Ctrl+C)** | persistInterruptedSessions → cards stay in columns | — | Persisted in work columns |
| 9 | **Server crash (SIGKILL)** | Hydration marks running → interrupted | — | Persisted in work columns |
| 10 | **Startup with interrupted sessions** | Sessions loaded as interrupted | isFirstSync → "Resuming N sessions..." toast → stopTaskSession + startTaskSession(--continue) | Stays in work column if resume works; review if it fails (via reconciliation) |
| 11 | **Project switch** | — | Reset effect clears ref → next render isFirstSync=true → resume fires | Same as #10 |
| 12 | **Agent stalls (no hooks 3+ min)** | Reconciliation: checkStalledSession → awaiting_review/stalled | Column sync: in_progress → review | Review column |

---

## Known gaps / future work

1. **Auto-restart is invisible to the UI** — The server silently restarts agents. There's no "auto-restarted" signal the UI could use to show the user what happened. The card flickers but there's no toast or indicator.

2. **Startup resume failure leaves card in work column until reconciliation** — If the UI's `startTaskSession(--continue)` fails, the card stays in the work column as "interrupted". The reconciliation sweep catches it within 10s and moves to review. Could be faster with an immediate transition in the UI's catch block.

3. **canReturnToRunning includes "interrupted" reviewReason** — After `autorestart.denied` produces `awaiting_review` with `reviewReason: "interrupted"`, the `canReturnToRunning` function doesn't include "interrupted" in its allowed list. This means a hook.to_in_progress event won't transition it back to running. This is actually correct for now (an interrupted session shouldn't silently resume via hooks), but worth noting if the reviewReason semantics change.

4. **150ms broadcast batching** — The UI might miss intermediate states (interrupted→running) or see them as separate events. Not a problem with current logic since the UI doesn't react to "interrupted" anymore, but relevant if that changes.

---

## What to do next

1. **Run `/refine --auto`** to get a code review pass on the uncommitted changes
2. **Test manually**: restart quarterdeck with running agents, verify toast + resume behavior
3. **Commit** the uncommitted changes (probably as a second commit on the branch, or squash with the first)
4. **Update release docs** per AGENTS.md conventions: `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`

---

## Files changed summary

```
src/server/workspace-registry.ts              # Comment update only (committed)
src/terminal/session-auto-restart.ts           # --continue with fresh fallback
src/terminal/session-manager.ts                # autorestart.denied on exit
src/terminal/session-reconciliation-sweep.ts   # Handle interrupted state + new action
src/terminal/session-reconciliation.ts         # checkInterruptedNoRestart
src/terminal/session-state-machine.ts          # autorestart.denied event
test/runtime/terminal/session-reconciliation.test.ts  # New tests
web-ui/src/hooks/use-board-interactions.ts     # Removed setSelectedTaskId
web-ui/src/hooks/use-session-column-sync.ts    # Merged effects, removed auto-trash
```
