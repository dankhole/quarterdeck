# Agent State Tracking — Issues, Architecture, and Refactor Plan

**Status:** All three patches (A, B, C) implemented. Session manager decomposition complete (different module names than originally planned — see note below). Remaining open bugs are in the "Fix agent state tracking bugs" todo item.
**Date:** 2026-04-11 (patches landed 2026-04-12, decomposition shipped in 0.7.2)
**Related:** "Fix agent state tracking bugs" in todo.md (consolidated — non-hook operations, notification beeps)

---

## The Problem

Quarterdeck needs to know what each agent is doing so the UI shows the correct state. It currently gets this wrong in several scenarios — tasks show "running" when the agent is waiting for input, stay in "review" when the agent has resumed, or get permanently stuck with no recovery.

The root cause is architectural: Quarterdeck relies on a single channel for agent state — **fire-and-forget hooks** (spawned CLI processes making HTTP calls). This channel is lossy, unordered, and incomplete.

---

## How Agent State Tracking Works Today

### The Hook Delivery Pipeline

```
Agent process fires hook event (configured via settings.json)
  → spawns new OS process: quarterdeck hooks ingest --event <to_review|to_in_progress|activity>
    → [hooks:cli] stderr diagnostic line (always on)
    → tRPC HTTP POST to server (3s timeout, 1 retry after 1s)
      → hooks-api.ts ingest handler
        → canTransitionTaskForHookEvent() guard
        → store.transitionToReview() or store.transitionToRunning()
        → WebSocket broadcast to UI
```

Each hook is a **separate OS process**. There is no ordering guarantee, no persistent queue, no acknowledgment loop, and no heartbeat. The agent does not check whether its hooks were received.

### State Machine

File: `src/terminal/session-state-machine.ts` (97 lines, pure reducer)

Five states: `idle`, `running`, `awaiting_review`, `failed`, `interrupted`

| Current State | Event | New State | Review Reason |
|---|---|---|---|
| `running` | `hook.to_review` | `awaiting_review` | `hook` |
| `running` | `interrupt.recovery` | `awaiting_review` | `attention` |
| `running` | `process.exit` (code 0) | `awaiting_review` | `exit` |
| `running` | `process.exit` (code != 0) | `awaiting_review` | `error` |
| `running` | `process.exit` (interrupted) | `interrupted` | `interrupted` |
| `awaiting_review` | `hook.to_in_progress` | `running` | null |
| `awaiting_review` | `agent.prompt-ready` | `running` | null |
| `awaiting_review` | `process.exit` | `awaiting_review` (updated) | exit/error |

`canReturnToRunning(reviewReason)` gates `to_in_progress` transitions. Accepts: `attention`, `hook`, `error`, `exit`. Terminal states (`idle`, `failed`, `interrupted`) have no exit via hooks — require user restart.

### Claude Adapter Hook Mappings

File: `src/terminal/agent-session-adapters.ts:516-565`

| Claude Code Event | Quarterdeck Event | Notes |
|---|---|---|
| `Stop` | `to_review` | Agent completed a turn |
| `PermissionRequest` | `to_review` | Agent needs permission approval |
| `Notification` (`permission_prompt`) | `to_review` | Alternate permission signal |
| `Notification` (`*`) | `activity` | No state transition |
| `PostToolUse` | `to_in_progress` | Agent resumed after tool use |
| `PostToolUseFailure` | `to_in_progress` | Agent resumed after failed tool |
| `UserPromptSubmit` | `to_in_progress` | User sent input |
| `SubagentStop` | `activity` | No state transition |
| `PreToolUse` | `activity` | No state transition |

### Comparison: How Other Adapters Handle This

**Codex** has **dual-channel detection**:
1. A session log watcher (`codex-hook-events.ts`) polling every 200ms
2. A PTY output detector (`codexPromptDetector`) matching the `>` prompt character

If the session log watcher misses an event, the prompt detector catches it when the Codex TUI renders its prompt. This makes Codex significantly more reliable for state tracking.

**OpenCode** has **session-level busy/idle signals** via a plugin model (`session.busy`, `session.idle`, `session.error`). This gives explicit "I'm working" / "I'm done" transitions rather than inferring state from tool-level events.

**Claude** has only the hook channel. Output-based detection was tried (2026-04-08, `checkOutputAfterReview`) and removed same day — Claude Code produces constant incidental terminal output (spinners, status bars, ANSI redraws) even while idle. There is no unique prompt marker like Codex's `>`. AGENTS.md explicitly says: "Do not use `lastOutputAt` timestamps or output presence/volume as a heuristic for whether an agent has resumed working."

### Key Files

| File | Role |
|---|---|
| `src/terminal/session-state-machine.ts` | Pure state machine reducer (97 lines) |
| `src/terminal/session-manager.ts` | Side effects, PTY, auto-restart, reconciliation (~1,350 lines) |
| `src/terminal/session-summary-store.ts` | Session summary CRUD, state transitions, event subscriptions |
| `src/terminal/session-reconciliation.ts` | Periodic health checks (10s sweep) |
| `src/terminal/agent-session-adapters.ts` | Per-agent CLI args, hook config, output detectors |
| `src/commands/hooks.ts` | CLI `hooks ingest` — how agents report transitions |
| `src/trpc/hooks-api.ts` | Server-side hook processing, permission guard, checkpoint capture |
| `web-ui/src/utils/session-status.ts` | Frontend permission detection |
| `src/config/global-config-fields.ts` | Config fields (e.g., `showRunningTaskEmergencyActions`) |

---

## Known Bugs

### Bug 1: Permission Race Condition (todo #9) — HIGH severity

**Symptom**: Task shows "running" when agent is blocked on a permission prompt.

**Root cause (confirmed by architecture analysis)**: `PostToolUse` from a just-completed tool arrives at the server AFTER `PermissionRequest` for the next tool, bouncing state from `awaiting_review` back to `running`.

Each hook spawns as a separate OS process. The `PermissionRequest` process may be slower (transcript enrichment via `enrichClaudeStopMetadata`) while `PostToolUse` has no enrichment overhead. The arrival order at the server is non-deterministic.

**Why the existing permission guard doesn't help**: The guard at `hooks-api.ts:119-157` only fires on the **non-transition path** — when `canTransitionTaskForHookEvent()` returns `false`. But when `to_in_progress` arrives while in `awaiting_review` with `reviewReason: "hook"`, `canReturnToRunning("hook")` returns `true`, the transition **succeeds**, and the guard is never reached. The guard protects metadata from being clobbered; it doesn't protect the state transition itself.

**Concrete timeline**:
```
T0  Claude: Tool X completes      → fires PostToolUse (to_in_progress)
T1  Claude: Permission prompt     → fires PermissionRequest (to_review)
T2  Server: PermissionRequest     → running → awaiting_review (reviewReason: "hook") ✓
T3  Server: PostToolUse (STALE)   → canReturnToRunning("hook") = true
                                  → awaiting_review → running ← BUG
```

### Bug 2: Operations That Don't Fire Hooks — MEDIUM severity

**Symptom**: Task stuck in "running" during agent internal operations (auto-compact, plugin reload, `/resume`), or stuck in "review" after agent auto-resumes.

**Root cause**: Claude Code does not fire hook events for these operations. They are internal operations that don't map to `Stop`, `PermissionRequest`, `PostToolUse`, or any other configured hook event. The `Notification` wildcard catches some as `activity`, but `activity` events never trigger state transitions (`canTransitionTaskForHookEvent` returns `false` for `activity`).

**Known non-hook operations**:
- Auto-compact (context window compaction)
- Plugin reload
- `/resume` (resume previous conversation)
- Possibly some `Notification` types like `user_attention` (falls through to `*` wildcard → `activity`, not `to_review`)

### Bug 3: Hook Delivery Failures — LOW severity (mitigated)

**Symptom**: Any transient failure (server busy, timeout, process spawn failure) causes a permanently stuck task.

**Current mitigation**: Single retry after 1s (`hooks.ts:394-436`). Total wall time before giving up: 3s timeout + 1s delay + 3s retry = 7s max.

**Contributing factor**: Checkpoint capture (`hooks-api.ts:202`) is `await`ed before the tRPC response is sent. Git checkpoint operations routinely exceed the 3s timeout under load, causing the CLI to timeout even when the state transition succeeded.

---

## Existing Recovery Layers

Seven distinct mechanisms exist. Understanding which are genuine fixes vs. compensating for the architecture is critical before adding more.

| # | Mechanism | Location | Classification | What It Covers |
|---|-----------|----------|----------------|----------------|
| 1 | `canReturnToRunning("exit")` | `session-state-machine.ts:21` | **ROOT FIX** | Clean-exit tasks were permanently stuck (fixed in `4ad5f0ff`) |
| 2 | Hook delivery retry (1x after 1s) | `hooks.ts:394-436` | **BANDAID** | Transient delivery failures; 1 retry is insufficient for persistent slowness |
| 3 | Permission metadata guard | `hooks-api.ts:119-157` | **SAFETY NET** | Prevents non-permission hooks from clobbering "Waiting for approval" metadata; does NOT prevent the race condition in Bug 1 |
| 4 | Interrupt recovery timer (5s) | `session-manager.ts:1152-1173` | **CRUTCH** | No hook fires when agent catches SIGINT; 5s heuristic is the only detection path |
| 5a | Reconciliation: dead process | `session-reconciliation.ts:66-81` | **SAFETY NET** | PTY `onExit` callback missed; checks `kill(pid, 0)` every 10s |
| 5b | Reconciliation: processless session | `session-reconciliation.ts:120-147` | **CRUTCH** | Process exited while no browser tab was open; updates stale state |
| 5c | Reconciliation: stale hook activity | `session-reconciliation.ts:87-107` | **SAFETY NET** | Clears permission badges that no longer match the session state |
| 6 | Auto-restart on reconnect | `session-manager.ts:763-803` | **CRUTCH** | Viewer reconnects to a crashed task; schedules restart |
| 7 | Emergency restart/trash buttons | `board-card.tsx:515-549` | **BANDAID** | Manual escape hatch; disabled by default (`showRunningTaskEmergencyActions`) |

**Legend**: ROOT FIX = addresses why the problem occurs. SAFETY NET = catches rare edge cases. CRUTCH = system depends on this for normal operations. BANDAID = covers a known gap that should be fixed.

The crutches (4, 5b, 6) are significant — they handle **normal operations** (interrupting agents, closing browser tabs), not edge cases. Without them the system would be broken for interactive use.

---

## Targeted Patches (Before Refactor)

These can be applied to the current code structure. The refactor (below) makes them cleaner but is not a prerequisite.

### Patch A: Permission-Aware Transition Guard — ✅ Implemented

**Implemented**: 2026-04-12
**Fixes**: Bug 1 (permission race condition)

**Goal**: Prevent stale `to_in_progress` hooks from bouncing a permission-waiting task back to running.

**Approach**: When `to_in_progress` arrives and the task is `awaiting_review` with permission-related `latestHookActivity`, block the transition.

**Where**: `hooks-api.ts`, before the `store.transitionToRunning()` call. Guard inserted between `canTransitionTaskForHookEvent` (which allows the transition at the state machine level) and the actual `transitionToRunning` call.

**Risk — false positive blocking**: When the user legitimately approves a permission:
1. `PermissionRequest` → `to_review` → `awaiting_review` (activity = permission)
2. User types approval in terminal → `writeInput` detects CR/LF → `store.transitionToRunning()` → clears `latestHookActivity` (line 196-198 of `session-summary-store.ts`)
3. `PostToolUse` → `to_in_progress` → no-op (already running, activity already cleared)

This works because `writeInput` (`session-manager.ts:822-835`) fires synchronously on keypress, transitioning to running and clearing permission activity BEFORE any hook arrives. The legitimate `PostToolUse` from the now-approved tool arrives later as a no-op.

**Edge case**: If the user approves via a keystroke that doesn't include CR/LF (unlikely for Claude Code permissions, which require typed input + Enter). If this happens, `writeInput` doesn't transition, and the hook guard would block the legitimate `PostToolUse`. The `UserPromptSubmit` hook would also map to `to_in_progress` and be blocked. **Mitigation**: `UserPromptSubmit` implies the user actively sent input — if we see a `to_in_progress` with `hookEventName: "UserPromptSubmit"`, always allow it through the guard regardless of permission state.

**Actual change**: ~18 lines in `hooks-api.ts` + 3 new test cases in `hooks-api.test.ts`. Updated existing happy-path test to reflect the corrected flow (PostToolUse during permission is now blocked, normal approval goes through `writeInput`).

### Patch B: Decouple Checkpoint Capture from Hook Response — ✅ Implemented

**Implemented**: 2026-04-12
**Fixes**: Bug 3 (hook delivery timeouts)

**Goal**: Eliminate the primary cause of hook CLI timeouts.

**Approach**: Fire-and-forget the checkpoint capture via `void (async () => { ... })()` so the tRPC response returns immediately after the state transition and broadcast.

**Where**: `hooks-api.ts`. Moved `broadcastRuntimeWorkspaceStateUpdated` and `broadcastTaskReadyForReview` before the checkpoint section. Wrapped checkpoint capture in a fire-and-forget IIFE.

**Risk — UI checkpoint race**: The UI receives the `to_review` broadcast before checkpoint data is applied. If the user immediately clicks "Revert to previous turn," the checkpoint might not exist yet. Mitigation: this is a brief window (<1s typically) and the revert feature is not latency-sensitive.

**Risk — concurrent git operations**: Without the `await` serializing checkpoint captures, two `to_review` hooks for different tasks in the same workspace could run `git stash create` concurrently, hitting index lock contention. This was already a known problem (commit `8f6d8d9b` added `--no-optional-locks` to polling git commands). Making checkpoint fire-and-forget doesn't make it worse in theory — concurrent hooks from different tasks already execute in parallel at the HTTP handler level — but it removes the incidental serialization the `await` provided. Actually improves the situation: fewer timeout-triggered retries means fewer duplicate checkpoint operations.

**Note on beep timing**: The original hypothesis that checkpoint blocking delays `latestHookActivity` past the 500ms settle window is incorrect. `applyHookActivity` was already called before checkpoint capture. The beep timing is correct regardless of this patch. Patch B's value is strictly in preventing hook CLI timeouts.

**Actual change**: ~10 lines in `hooks-api.ts` (reordered broadcast before checkpoint, wrapped checkpoint in fire-and-forget IIFE).

### Patch C: Staleness Check in Reconciliation Sweep — ✅ Implemented

**Implemented**: 2026-04-12 (commit `9b482422`)
**Fixes**: Alive-but-stuck agents (compact, plugin reload, `/resume`, undetected permission prompts)

**What shipped**: Reconciliation sweep detects running sessions that haven't received a hook in over 60 seconds and marks them as "stalled". UI shows an orange "Stalled" badge with explanatory tooltip. Auto-clears when hooks resume. Implemented as a UI indicator rather than a forced state transition (avoids the false-positive risk of flipping cards to review while an agent is legitimately working).

---

## Structural Decomposition (Completed)

The session manager decomposition shipped in v0.7.2. The final module structure differs from the original plan (below) — it followed the natural seams in the code rather than the planned phase boundaries.

### What Shipped

`session-manager.ts` went from ~1,350 lines to ~788 lines. Eight focused modules were extracted:

| File | Lines | Responsibility |
|------|-------|----------------|
| `session-manager-types.ts` | 254 | Shared types and interfaces (`ActiveProcessState`, etc.) |
| `session-summary-store.ts` | 440 | Hook activity, summaries, checkpoints, notify/emit |
| `session-reconciliation.ts` | 206 | Periodic health checks (10s sweep) |
| `session-reconciliation-sweep.ts` | 180 | Sweep logic (dead process, processless, stale hooks) |
| `session-workspace-trust.ts` | 153 | Workspace trust auto-confirmation |
| `session-state-machine.ts` | 128 | Pure state machine reducer |
| `session-auto-restart.ts` | 105 | Auto-restart on crash/reconnect |
| `session-interrupt-recovery.ts` | 70 | Interrupt recovery timer |

### Original Plan (Historical)

The plan below was the design document. It was not followed exactly — the actual decomposition used different module names and boundaries. Preserved here for context on the design reasoning.

<details>
<summary>Original phased refactor plan</summary>

### Current Structure Problems (at time of planning)

- **`ActiveProcessState`** mixed PTY concerns, workspace trust, Codex-specific concerns, protocol filtering, output detection, and interrupt recovery in one interface.
- **`applySessionEventWithSideEffects`** was a wrapper coordinating side effects the reducer can't express.
- **`hooks-api.ts`** duplicated permission-guard logic from `session-reconciliation.ts`.
- **Both** the manager and reconciliation could trigger recovery paths for processless sessions.

### Target Architecture

```
TerminalSessionManager (coordinator, ~250-300 lines)
  |-- SessionStateMachine (enriched reducer + side-effect declarations)
  |-- PtyProcessManager (spawn, exit, data routing, workspace trust)
  |-- SessionSummaryManager (hook activity, summaries, checkpoints, notify/emit)
  |-- SessionTimerManager (interrupt recovery, auto-restart, rate limiting)
  |-- SessionReconciler (unchanged, already extracted)
```

Phases 1-6 covered: enriching the state machine, extracting PTY process management, summary management, timer management, coordinator refactor, and permission guard consolidation. Key risk areas included preserving `onData` synchronous ordering, the `transitionToReview` same-tick invariant, and test fixture coupling via the `entries` map.

</details>

---

## Diagnostic Logging (Already Landed)

Two layers of logging exist for debugging state tracking issues (added in `4ad5f0ff`):

### CLI-side (agent terminal, always on)

```
[hooks:cli] event=to_review hookEvent=Stop tool=- notifType=- activity=-
[hooks:cli] event=to_in_progress hookEvent=PostToolUse tool=Bash notifType=- activity=Completed Bash
[hooks:cli] event=to_review hookEvent=PermissionRequest tool=- notifType=- activity=Waiting for approval
```

### Server-side (enable "Debug logging" in UI Settings)

```
[hooks] Hook ingest received { taskId, event, hookEventName, ... }
[hooks] Hook blocked — can't transition { taskId, event, currentState, currentReviewReason, ... }
[hooks] Hook blocked — permission guard (...) { taskId, event, incomingHookEvent, currentPermissionActivity }
[hooks] Hook transitioning { taskId, event, fromState, fromReviewReason, toState, hookEventName }
```

### What to look for

- **Bug 1 (race)**: When permission prompt shows, does `event=to_review hookEvent=PermissionRequest` appear? Is it immediately followed by `event=to_in_progress hookEvent=PostToolUse`? If so, the race is confirmed.
- **Bug 2 (no hooks)**: During compact/resume/reload, do ANY `[hooks:cli]` lines appear? If not, the operation fires no hooks at all.
- **"Hook blocked" with `currentState: "running"` and `event: "to_in_progress"`**: Normal — hook arrived while already running (no-op).
- **"Hook transitioning" with `to_in_progress` immediately after `to_review`**: Race condition (Bug 1).

---

## What Was Tried and Failed

- **Output-based detection for Claude** (2026-04-08, `checkOutputAfterReview`): Removed same day. Claude Code produces constant incidental terminal output even while idle. Codex works because it has a unique `>` prompt marker; Claude has no equivalent.
- **`needs_input` project pill** (commit `be56e048`, reverted in `271efe00`): Tried to show a separate "NI" pill for permission-waiting tasks, but `"attention"` is the standard completion reason. Every finished review task showed NI instead of R.

---

## Long-Term Considerations

The fundamental weakness is that the hook channel is the **only** source of truth for agent state, and it is architecturally inadequate:

1. **Lossy** — spawned processes can fail to start, timeout, or crash (1 retry isn't enough for persistent slowness)
2. **Unordered** — concurrent hooks arrive in arbitrary order (causes Bug 1)
3. **Incomplete** — many agent operations don't fire hooks (causes Bug 2)
4. **Unidirectional** — Quarterdeck cannot query the agent's current state

Options that would fundamentally improve reliability (all require significant effort):

- **A second detection channel** for Claude: Something that doesn't depend on hooks. Not output-based (ruled out), but possibly a file-based signal, IPC pipe, or periodic status query.
- **Upstream Claude Code changes**: Additional hook events for compact, resume, plugin reload. Session-level busy/idle signals like OpenCode has.
- **Heartbeat mechanism**: Agent sends periodic `activity` hooks (e.g., every 5-10s while working). Absence of heartbeat = agent is stuck. Requires Claude Code hook config changes.
- **Process introspection**: Query the agent process directly for its state (e.g., read a status file the agent maintains). Requires agent-side support.

These are not on the immediate roadmap but inform the design direction — any short-term fix should avoid making these harder to adopt later.
