# Session Lifecycle Observability Plan

**Date**: 2026-04-12
**Purpose**: Before attempting the structural refactor, instrument the session lifecycle with enough telemetry to understand actual failure modes from real usage. The remaining bugs are all about missing signals — we need data, not code restructuring.

## Problem Statement

Every open state-tracking bug is a variant of "the agent did something, no hook fired, the card is stuck." We're guessing at failure modes. The current debug logger (`createTaggedLogger`) has some coverage but it's opt-in, ephemeral (200-entry ring buffer), and doesn't capture the key lifecycle events in a structured, analyzable way.

## Known Stuck-State Scenarios

| Scenario | What happens | Why it's stuck | What signal we need |
|---|---|---|---|
| API error (cert, auth, rate limit) | Agent prints error, sits at prompt | Process alive, no hook, no exit | Time since last hook vs. time since last output |
| Auto-compact | Agent compacts conversation mid-task | No hook event for compaction | Output pattern + no state change for N seconds |
| Plugin reload | Agent reloads MCP plugins | No hook event | Same as above |
| `/resume` after review | User types /resume, agent resumes | No `to_in_progress` hook fires | writeInput with CR/LF but no subsequent hook |
| Agent idle after tool use | Agent finishes tool, sits thinking | Long gap between PostToolUse and next hook | Time between last hook and current time |
| Orphaned permission prompt | Permission guard blocks stale PostToolUse | Fixed — but do we see it in the wild? | Permission guard activation frequency |

## What We Already Track

**On the summary (persisted):**
- `state` — current state machine state
- `lastOutputAt` — last PTY output timestamp
- `lastHookAt` — last hook ingestion timestamp
- `latestHookActivity` — most recent hook metadata (hookEventName, source, etc.)
- `pid` — process ID (null when exited)
- `startedAt` — session start time
- `updatedAt` — last summary mutation time

**In debug logs (ephemeral, 200-entry ring buffer):**
- Hook ingest received/blocked/transitioning (hooks-api.ts)
- Session spawn/exit (session-manager.ts)
- Trust prompt detection (session-manager.ts)

**Not tracked at all:**
- State machine transition events (what event, from what state, to what state)
- writeInput events (what kind of input, did it trigger a transition)
- Reconciliation sweep actions (what was found, what action was taken)
- Auto-restart events (why, success/failure)
- Time-in-state (how long has a session been in "running" without a hook)
- Output volume/cadence (is the agent producing output or silent)

## Plan

### Phase 1: Session Event Log

Add a dedicated structured event log for session lifecycle events. Not the debug logger — a purpose-built JSONL event stream that captures every state-affecting event with timestamps.

**New file: `src/terminal/session-event-log.ts`**

```typescript
interface SessionEvent {
  timestamp: number;
  taskId: string;
  event: string;        // e.g. "hook.received", "state.transition", "writeInput", "reconciliation.action"
  data: Record<string, unknown>;
}
```

Events to capture:

| Event | Source | Data |
|---|---|---|
| `session.started` | startTaskSession | agentId, binary, cwd, pid |
| `session.started.shell` | startShellSession | binary, cwd, pid |
| `session.exited` | onExit callback | exitCode, wasInterrupted, timeInState, timeSinceLastHook |
| `session.spawn_failed` | catch in startTaskSession | agentId, binary, error |
| `state.transition` | applySessionEventWithSideEffects | event.type, fromState, toState, fromReason, toReason |
| `state.transition.optimistic` | writeInput CR/LF path | fromState, toState (the immediate writeInput transition) |
| `state.transition.noop` | applySessionEvent (changed=false) | event.type, currentState, currentReason (why it was rejected) |
| `hook.received` | hooks-api ingest | event, hookEventName, source, canTransition |
| `hook.blocked.cant_transition` | hooks-api | event, currentState, currentReason |
| `hook.blocked.permission_guard` | hooks-api | incomingHookEvent, currentPermissionActivity |
| `hook.blocked.transition_guard` | hooks-api | event, currentState, latestHookActivity |
| `hook.transitioned` | hooks-api | event, fromState, toState |
| `writeInput.interrupt` | writeInput | isCtrlC, isBareEscape, currentState |
| `writeInput.codex_flag` | writeInput | awaitingCodexPromptAfterEnter set |
| `reconciliation.action` | reconcileSessionStates | action.type, taskId, currentState, pid |
| `reconciliation.sweep` | reconcileSessionStates | sessionsChecked, actionsApplied |
| `autorestart.triggered` | scheduleAutoRestart | taskId, restartCount |
| `autorestart.rate_limited` | shouldAutoRestart | taskId, timestamps |
| `autorestart.failed` | scheduleAutoRestart catch | taskId, error |
| `trust.detected` | onData trust path | taskId, isClaudePrompt, isCodexPrompt, confirmCount |
| `trust.confirmed` | timer callback | taskId, confirmCount |
| `trust.cap_reached` | timer callback | taskId, confirmCount |
| `interrupt_recovery.scheduled` | scheduleInterruptRecovery | taskId |
| `interrupt_recovery.fired` | timer callback | taskId, currentState |

### Phase 2: Periodic Health Snapshot

Every reconciliation sweep (10s), emit a summary snapshot for each active session:

```typescript
{
  event: "health.snapshot",
  taskId: string,
  state: string,
  reviewReason: string | null,
  pid: number | null,
  processAlive: boolean,
  msSinceStart: number,
  msSinceLastOutput: number | null,
  msSinceLastHook: number | null,
  msSinceLastStateChange: number,
  hookCount: number,          // total hooks received this session
  listenerCount: number,      // attached viewers
  autoRestartCount: number,
}
```

This is the key data for diagnosing stuck sessions. After dogfooding, we can grep for sessions where `msSinceLastHook` is high but `state === "running"` and `processAlive === true` — those are the stuck ones.

### Phase 3: Log Sink

The event log needs to go somewhere analyzable, not just the ring buffer.

**Option A: JSONL file** — Write to `~/.quarterdeck/logs/session-events.jsonl`. Simple, greppable, can be rotated. Add a max file size (e.g. 10MB) with rotation.

**Option B: Extend the existing debug logger** — Add a new log level or tag that always emits (not gated by `debugLoggingEnabled`). Events go into the ring buffer AND to a file sink.

**Recommendation: Option A.** Keep it separate from the debug logger. The debug logger is for dev-time debugging. The event log is for production observability. Different lifecycles, different retention needs.

### Phase 4: Dogfood and Analyze

Run with the instrumentation for 1-2 weeks of real usage across multiple concurrent agents. Then analyze:

1. **Stuck session forensics**: Find all sessions that stayed in "running" for >60s with no hooks. What was the last hook? What was the last output? Did the process exit?

2. **Hook gap analysis**: For each session, plot hook timestamps. Where are the long gaps? Do they correlate with known agent behaviors (compaction, plugin reload, thinking)?

3. **Reconciliation effectiveness**: How often does the sweep catch real problems vs. false positives? Are the existing checks sufficient?

4. **Permission guard frequency**: How often does the new permission guard fire in practice? Is it preventing real races or just blocking benign no-ops?

5. **Auto-restart patterns**: How often do agents crash and restart? What's the typical restart count per session?

### What This Tells Us Before the Refactor

After Phase 4, we'll know:
- Whether reconciliation-based stuck-session detection is viable (and what thresholds to use)
- Whether there are failure modes we haven't seen yet
- Whether the remaining bugs (non-hook operations, beep timing) are actually common enough to prioritize
- Whether the structural refactor is needed for the fixes, or if targeted patches at the right layer are sufficient

## Implementation Order

1. `session-event-log.ts` — event type, emit function, JSONL file sink (~100 lines)
2. Instrument `hooks-api.ts` — replace/augment debug logs with structured events (~15 call sites)
3. Instrument `session-manager.ts` — add events at transition points, writeInput, reconciliation (~20 call sites)
4. Add health snapshot to reconciliation sweep (~30 lines)
5. Add log rotation / cleanup (~20 lines)
6. Wire up in `cli.ts` startup (initialize log path)

**Estimated scope**: ~200 lines of new code, ~40 lines of modifications to existing files. No behavioral changes. No test changes needed (logging is side-effect-only).
