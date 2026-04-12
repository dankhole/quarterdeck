# Handoff: Fix stuck-in-running root causes (todo #9, #21)

## Current state (2026-04-11)

### What's landed

**Commit `4ad5f0ff`** — structural hardening + diagnostic logging:

1. **Dead state fix**: `canReturnToRunning()` now accepts `"exit"` reason. Tasks that exited cleanly (code 0) are no longer permanently stuck in `awaiting_review`. Note: `"interrupted"` was NOT added — it maps to `state: "interrupted"` (not `"awaiting_review"`), so it's a different code path entirely.

2. **Interrupt timer leak fix**: `applySessionEventWithSideEffects` clears the interrupt recovery timer when transitioning to `state: "running"`. Prevents stale Escape/Ctrl+C timers from bouncing resumed sessions.

3. **Hook delivery retry**: `ingestHookEvent` retries once after 1s on failure. tRPC client reused across attempts.

4. **Reconciliation through reducer**: `mark_processless_error` now routes through `applySessionEventWithSideEffects` instead of direct `store.update`.

5. **Diagnostic logging** — two layers:
   - **CLI-side** (always on): `[hooks:cli]` lines on stderr in the agent's PTY
   - **Server-side** (enable debug logging in UI): `[hooks]` tagged logs at 4 decision points

**Commit `d339a99a`** (prior) — emergency restart/trash workaround for stuck tasks.

### What's NOT landed — the root causes

Two bugs remain open. The hardening above reduces their blast radius but doesn't fix them. Diagnostic logging was added specifically to gather data for these:

## Bug 1: Permission prompts not detected (todo #9)

**Symptom**: Agent is alive but blocked on a permission prompt. UI shows "running" with no indication the agent needs input.

**What we now know**: The Claude adapter DOES configure `PermissionRequest` → `to_review` in the settings.json hooks (`agent-session-adapters.ts:526-530`). The `isPermissionActivity()` patterns match the expected metadata. So the hooks are configured — the question is whether they fire correctly in practice.

**Likely root cause candidates** (need diagnostic logs to confirm):
1. **Race condition**: `PostToolUse` → `to_in_progress` fires after `PermissionRequest` → `to_review`, bouncing state back to running. The permission guard in `hooks-api.ts:109-138` should prevent this IF the `to_review` arrives first and stores permission metadata — but under load the order isn't guaranteed.
2. **Hook doesn't fire**: Claude Code's `PermissionRequest` hook event may not fire for all permission scenarios (e.g., some permission types may use a different event name).
3. **Metadata mismatch**: The hook fires but metadata doesn't match `isPermissionActivity()` patterns.

**How to diagnose**: Trigger a permission prompt on a task, then:
- Check agent terminal for `[hooks:cli]` lines — did a `to_review` with `hookEvent=PermissionRequest` fire?
- Check debug logs for `[hooks]` entries — did the server receive it? Was it blocked? By what?
- If `to_review` fired but was immediately followed by `to_in_progress`, the race condition theory is confirmed.

## Bug 2: Compact doesn't transition to running (todo #21)

**Symptom**: When Claude Code auto-compacts, the task card stays in `awaiting_review` instead of transitioning back to running.

**What we now know**: The Claude adapter relies 100% on hooks for state transitions (no output detection — it was tried and removed as unreliable, see AGENTS.md). The relevant hooks are:
- `PostToolUse` → `to_in_progress` (fires after tool execution)
- `UserPromptSubmit` → `to_in_progress` (fires when user submits prompt)

**The question**: Does compact trigger `PostToolUse` or any other hook that maps to `to_in_progress`? If compact is an internal operation that doesn't trigger any of the configured hook events, no `to_in_progress` fires and the task stays in review.

**How to diagnose**: Start a task, let it go to review, then let it compact. Watch:
- Agent terminal for `[hooks:cli]` lines during/after compact — does ANY `to_in_progress` event appear?
- If no hooks fire during compact, the fix needs to be at the hook configuration layer (add a hook event that fires during/after compact) or at the system prompt layer.
- If hooks DO fire but the server blocks them, the debug logs will show why.

## Key architecture (quick reference)

### Hook delivery pipeline
```
Agent process fires hook event (based on settings.json config)
  → quarterdeck hooks ingest --event <to_review|to_in_progress|activity> (CLI process)
    → [hooks:cli] stderr line (diagnostic)
    → tRPC call to server (3s timeout, 1 retry after 1s)
      → hooks-api.ts ingest handler
        → [hooks] debug log: "Hook ingest received"
        → canTransitionTaskForHookEvent() guard
          → [hooks] debug log: "Hook blocked" or "Hook transitioning"
        → store.transitionToReview() or store.transitionToRunning()
        → WebSocket broadcast to UI
```

### State machine (session-state-machine.ts, 97 lines)
- States: `idle`, `running`, `awaiting_review`, `failed`, `interrupted`
- `hook.to_review`: running → awaiting_review (reason: "hook")
- `hook.to_in_progress` / `agent.prompt-ready`: awaiting_review → running (if `canReturnToRunning(reviewReason)` — accepts attention, hook, error, exit)
- `interrupt.recovery`: running → awaiting_review (reason: "attention") [5s after Ctrl+C/Escape]
- `process.exit`: any → awaiting_review (reason: exit/error) or interrupted

### Claude adapter hook mappings (agent-session-adapters.ts:516-558)
| Claude Code Event | Quarterdeck Event |
|---|---|
| `Stop` | `to_review` |
| `PermissionRequest` | `to_review` |
| `Notification` (permission_prompt) | `to_review` |
| `PostToolUse` | `to_in_progress` |
| `PostToolUseFailure` | `to_in_progress` |
| `UserPromptSubmit` | `to_in_progress` |
| `SubagentStop` | `activity` |
| `PreToolUse` | `activity` |

### Key files
| File | Role |
|---|---|
| `src/terminal/session-state-machine.ts` | Pure state machine (97 lines) |
| `src/terminal/session-manager.ts` | Side effects, PTY, auto-restart, reconciliation |
| `src/terminal/session-reconciliation.ts` | Periodic health checks (10s sweep) |
| `src/terminal/agent-session-adapters.ts` | Per-agent CLI args, hook config, output detectors |
| `src/commands/hooks.ts` | CLI `hooks ingest` — how agents report transitions |
| `src/trpc/hooks-api.ts` | Server-side hook processing + diagnostic logging |
| `web-ui/src/utils/session-status.ts` | Frontend permission detection |

## Reading the diagnostic logs

### CLI-side (agent terminal, always on)
```
[hooks:cli] event=to_review hookEvent=Stop tool=- notifType=- activity=-
[hooks:cli] event=to_in_progress hookEvent=PostToolUse tool=Bash notifType=- activity=Completed Bash
[hooks:cli] event=to_review hookEvent=PermissionRequest tool=- notifType=- activity=Waiting for approval
```

**What to look for**:
- For #21: After compact, do ANY `event=to_in_progress` lines appear?
- For #9: When permission prompt shows, does `event=to_review hookEvent=PermissionRequest` appear? Is it followed by `event=to_in_progress` (race)?

### Server-side (enable debug logging in UI Settings)
```
[hooks] Hook ingest received { taskId, event, hookEventName, ... }
[hooks] Hook blocked — can't transition { taskId, event, currentState, currentReviewReason, ... }
[hooks] Hook blocked — permission guard (...) { taskId, event, incomingHookEvent, currentPermissionActivity }
[hooks] Hook transitioning { taskId, event, fromState, fromReviewReason, toState, hookEventName }
```

**What to look for**:
- "Hook blocked" with `currentState: "running"` and `event: "to_in_progress"` → hook arrived while already running (no-op, normal)
- "Hook blocked" with `currentState: "awaiting_review"` and `event: "to_review"` → duplicate review hook (no-op, normal)
- "Hook blocked — permission guard" → non-permission hook tried to clobber permission state (guard working correctly)
- "Hook transitioning" with `event: "to_in_progress"` immediately after `event: "to_review"` → race condition (bug #9 candidate)

## What was tried and failed

**Output-based detection for Claude**: Tried on 2026-04-08 (`checkOutputAfterReview`), removed same day. Claude Code produces constant incidental terminal output (spinners, status bars, ANSI redraws) even while idle. AGENTS.md explicitly says: "Do not use `lastOutputAt` timestamps or output presence/volume as a heuristic for whether an agent has resumed working."

The Codex adapter has `codexPromptDetector` (matches the `›` prompt character) — this works because Codex has a unique, unmistakable prompt marker. Claude has no equivalent.
