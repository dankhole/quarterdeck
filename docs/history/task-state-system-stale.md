# Historical Task State System

> Historical context only. This document is known to be stale in places; verify behavior against current code before using it as implementation guidance.

How task state works in Quarterdeck, end to end — from state definitions through persistence, propagation, hooks, restart mechanics, and UI rendering.

---

## The State Model

A task has two orthogonal concepts that together define "where it is":

1. **Board column** — which column the card sits in: `backlog`, `in_progress`, `review`, or `trash`. This is the user-facing position. It's stored as part of the board JSON (which column's `cards[]` array contains the card).

2. **Session state** — the runtime lifecycle of the agent process: `idle`, `running`, `awaiting_review`, `failed`, or `interrupted`. This is the server-owned operational state.

The **session state drives automatic column moves**. When the session transitions to `awaiting_review`, the frontend auto-moves the card from `in_progress` → `review`. When it transitions to `running`, it moves from `review` → `in_progress`. But the user can also manually drag cards around.

### Session sub-state: review reason

When a session is in `awaiting_review`, a `reviewReason` field tells you *why*:

- `hook` — the agent explicitly said "I'm done / I need review" via the hook system
- `exit` — the agent process exited cleanly (exit code 0)
- `error` — the agent process exited with a non-zero exit code
- `attention` — the user pressed Escape or a recovery timeout fired
- `stalled` — no hook activity for 3+ minutes
- `interrupted` — the process was killed/interrupted

This matters because the review reason determines what the UI badge says ("Completed", "Error", "Stalled", etc.) and whether the session is allowed to return to `running`.

---

## Where State Is Stored

### Server-side persistence (disk)

Three JSON files per project, in `.quarterdeck/projects/<id>/`:

| File | Contents |
|------|----------|
| `board.json` | The 4 columns, each containing an array of card objects (id, title, prompt, config flags) |
| `sessions.json` | Map of taskId → `RuntimeTaskSessionSummary` (state, reviewReason, pid, timestamps, etc.) |
| `meta.json` | A `revision` counter + `lastUpdated` timestamp for optimistic concurrency |

Writes are protected by a file-system lock and atomic file operations. The revision counter prevents concurrent writers from clobbering each other — the UI sends `expectedRevision` with every board save, and the server rejects if it doesn't match.

### Server-side in-memory (runtime)

`InMemorySessionSummaryStore` (`src/terminal/session-summary-store.ts`) holds a `Map<taskId, RuntimeTaskSessionSummary>`. All state machine transitions happen here first, then get persisted. It has a listener system — anything that mutates a summary notifies all registered listeners, which triggers WebSocket broadcasts to connected clients. Public browser saves do not send sessions back; when the server persists project state on behalf of the browser, it snapshots sessions from this store.

### Frontend state

Two separate stores:

1. **Board state** — a custom Immer-based reducer in `web-ui/src/state/board-state.ts`. This holds the column structure and card positions. It's the "single writer" of board.json — the UI is the only thing that persists board changes (the server never writes board.json directly to avoid revision conflicts).

2. **Session summaries** — received via WebSocket and read in the browser. Live `task_sessions_updated` deltas merge incrementally, but authoritative project snapshots/refreshes replace the browser's session keyset by task ID (while still preferring a newer overlapping summary if a stale snapshot replays older data). The frontend never authors session truth.

### The ownership join point

The main split-brain seam is where those two frontend stores meet:

- **Persisted board state remains browser-owned** as the durable layout that gets written back to `board.json`.
- **Runtime session state remains server-owned** as the authoritative source for whether a live task is currently running or waiting for review.
- The public/browser `project.saveState` contract is therefore **board-only** (`board` + `expectedRevision`). Session persistence comes from server-owned runtime state, not from browser payloads.
- The browser intentionally **projects runtime truth onto the board only for the work-column boundary**:
  - `in_progress` → `review` when session state is `awaiting_review`
  - `review` → `in_progress` when session state is `running`
- That projection happens both on live session deltas and when authoritative project state is hydrated after reconnect/project switch, so the UI does not depend on a later repair effect to land cards in the right work column.
- When authoritative project state is applied, the browser now computes **one atomic apply result** from:
  - the latest queued local board+sessions state
  - the incoming authoritative project snapshot/refresh
  - the current revision/cache-confirmation context
- In code, that browser-side entry point lives at `web-ui/src/hooks/project/project-sync.ts` as `applyAuthoritativeProjectState(...)`.
- That single apply result drives session reconciliation, board projection, hydration skip-persist policy, revision confirmation, and board-cache updates together. The browser should not reconcile sessions from one snapshot and then project/cache/revise from another.
- If the projection changes the hydrated board, that projected board should still persist through the normal UI save path. Otherwise the browser would display the runtime-correct column while `board.json` stays behind.
- Cached board/session restore is subordinate to authoritative project state. Once the server sends authoritative project state after reconnect/project switch/restart, the browser adopts that exact authoritative session keyset (dropping tasks the server no longer reports) and then reapplies the work-column projection.

That means the answer to “what is authoritative for this task right now?” is:

- **Session lifecycle / running-vs-review truth:** server
- **Durable board layout:** browser
- **Displayed column between `in_progress` and `review` for live tasks:** browser-owned projection of server-owned runtime truth

---

## The State Machine

Defined in `src/terminal/session-state-machine.ts`. Valid transitions:

```
idle ──[startSession]──► running

running ──[hook.to_review]──► awaiting_review (reason: hook)
running ──[process.exit, code=0]──► awaiting_review (reason: exit)
running ──[process.exit, code≠0]──► awaiting_review (reason: error)
running ──[process.exit, interrupted]──► interrupted (reason: interrupted)
running ──[interrupt.recovery]──► awaiting_review (reason: attention)
running ──[reconciliation.stalled]──► awaiting_review (reason: stalled)

awaiting_review ──[hook.to_in_progress]──► running
awaiting_review ──[agent.prompt-ready]──► running
awaiting_review ──[process.exit]──► awaiting_review (preserves reason, clears pid)

interrupted ──[autorestart.denied]──► awaiting_review (reason: interrupted)
interrupted ──[startSession]──► running (manual restart)
```

A guard function `canReturnToRunning(reviewReason)` controls whether `awaiting_review` → `running` is allowed. All reasons except `interrupted` allow return to running.

---

## How State Changes Propagate to the Frontend

```
Agent process does something (exits, calls hook, goes idle)
    │
    ▼
Server applies state machine transition
    │  (InMemorySessionSummaryStore.applySessionEvent)
    │
    ▼
Listener fires → RuntimeStateHub batches update (~100ms)
    │
    ▼
WebSocket sends task_sessions_updated message
    │  (contains updated RuntimeTaskSessionSummary[])
    │
    ▼
Frontend receives in useRuntimeStateStream()
    │  (WebSocket connection with auto-reconnect)
    │
    ▼
runtime-stream-dispatch.ts routes to handler
    │  (applies authoritative snapshots vs delta merges explicitly)
    │
    ▼
useSessionColumnSync() detects state change
    │  if (state === "awaiting_review" && card in "in_progress")
    │      → moveTaskToColumn("review")
    │  if (state === "running" && card in "review")
    │      → moveTaskToColumn("in_progress")
    │
    ▼
Board re-renders with card in new column
    │
    ▼
BoardCard renders status badge via describeSessionState()
    "Running" / "Completed" / "Error" / "Stalled" / etc.
```

For hook-triggered transitions specifically, there's also a `task_ready_for_review` message sent alongside `task_sessions_updated` — this is used for notification sounds, not column moves.

---

## The Hook System (How Agents Trigger State Changes)

Agents don't directly mutate state. They need to tell Quarterdeck "I stopped working" or "I started working again" so the state machine can transition. The mechanism for this is the **hook system**: a set of CLI commands (`quarterdeck hooks ingest` / `quarterdeck hooks notify`) that agents call to post events to the Quarterdeck runtime server.

There are exactly three hook events:

| Event | Meaning | State Transition |
|-------|---------|-----------------|
| `to_review` | Agent stopped / completed / needs permission | `running` → `awaiting_review` |
| `to_in_progress` | Agent resumed working | `awaiting_review` → `running` |
| `activity` | Informational (progress metadata, tool usage) | No state change |

Every hook call carries two environment variables that identify the task: `QUARTERDECK_HOOK_TASK_ID` and `QUARTERDECK_HOOK_PROJECT_ID`. These are injected into the agent's process environment when Quarterdeck spawns it.

The challenge is that different agents have completely different extensibility models, so the plumbing that connects an agent to these hook commands is agent-specific. Claude and Codex take very different approaches.

### Claude hooks: native integration

Claude Code has a built-in hook system. You can give it a JSON settings file that maps Claude lifecycle events to shell commands, and Claude will execute those commands at the right moments. Quarterdeck takes advantage of this.

Quarterdeck requires Claude Code 2.1.198 or newer for Claude task launches because the native hook mapping uses the documented `agent_needs_input` notification type.

**Setup:** Before spawning Claude, Quarterdeck generates a hooks settings JSON file at `~/.quarterdeck/hooks/claude/settings.json` and passes it via the `--settings` CLI flag. The file maps state-changing Claude events to reliable `quarterdeck hooks ingest` commands and maps activity-only events to best-effort `quarterdeck hooks notify` commands:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact|fork",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event activity --source claude" }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_review --source claude" }]
    }],
    "StopFailure": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_review --source claude" }]
    }],
    "PermissionRequest": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_review --source claude" }]
    }],
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks notify --event activity --source claude" }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_in_progress --source claude" }]
    }],
    "Notification": [{
      "matcher": "permission_prompt|agent_needs_input",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_review --source claude" }]
    }]
  }
}
```

The full mapping:

| Claude Event | Hook Event | Why |
|---|---|---|
| `SessionStart` | `activity` | Capture session id metadata without changing task state |
| `Stop` | `to_review` | Claude finished its turn, waiting for user |
| `StopFailure` | `to_review` with review reason `error` | Claude turn failed before a normal stop |
| `PermissionRequest` | `to_review` | Claude needs permission to use a tool |
| `Notification` (`permission_prompt` / `agent_needs_input`) | `to_review` | Permission or attention prompt surfaced |
| `Notification` (*) | `activity` | General notification (progress info) |
| `PostToolUse` | `to_in_progress` | Tool completed, Claude is working again |
| `PostToolUseFailure` | `to_in_progress` | Tool failed, Claude is working again |
| `PermissionDenied` | `activity` | Permission request resolved without granting access |
| `UserPromptSubmit` | `to_in_progress` | User provided input, Claude resumes |
| `PreToolUse` | `activity` | About to call a tool (informational) |
| `SubagentStart` | `activity` | A sub-agent started (informational) |
| `SubagentStop` | `activity` | A sub-agent finished (informational) |
| `PreCompact` / `PostCompact` | `activity` | Context compaction started or finished |

**Execution model:** Synchronous and blocking from Claude's perspective. State-changing hooks and Claude `SessionStart` use reliable ingest: a 3-second timeout per attempt and a single retry after 1 second if the first attempt fails. Activity-only hooks use best-effort notify with a short timeout and no retry so incidental tool/subagent/compact events do not block the TUI for long.

**Metadata extraction:** Claude hook stdin includes `session_id` on lifecycle events and `last_assistant_message` on `Stop`. Quarterdeck stores the session id as `resumeSessionId` and promotes the main-agent `Stop` message to `conversationSummaryText`. `transcript_path` is retained as metadata for diagnostics, but Quarterdeck no longer reads or parses the JSONL transcript because Claude documents that the transcript file can lag the hook payload.

### Codex hooks: native hook configuration via launch-scoped inline config

Codex now has a native hook system, so Quarterdeck no longer wraps the CLI or scrapes internal logs. Instead, the Codex adapter injects its hook configuration inline on the `codex` command line using `-c hooks.<Event>=...` overrides, injects the same `QUARTERDECK_HOOK_TASK_ID` / `QUARTERDECK_HOOK_PROJECT_ID` environment variables used by Claude, forces `--enable hooks` (the feature flag was renamed from `codex_hooks` in the 0.14x line), and then launches `codex` directly. This keeps Quarterdeck's Codex hooks scoped to Quarterdeck-launched sessions instead of leaking into standalone Codex app/GUI usage through `~/.codex/hooks.json`.

The generated inline Codex hook config maps native events into Quarterdeck's three internal hook events:

| Codex Hook Event | Matcher | Quarterdeck Event | Purpose |
|---|---|---|---|
| `SessionStart` | `startup\|resume` (excludes `clear`) | `activity` | Capture session metadata without changing task state |
| `UserPromptSubmit` | — | `to_in_progress` | Mark resumed work after user input |
| `PreToolUse` | `*` | `activity` | Informational tool activity |
| `PermissionRequest` | `*` | `to_review` | Enter review with approval-needed metadata |
| `PostToolUse` | `*` | `to_in_progress` | Store tool-completion metadata and return review cards to running |
| `Stop` | — | `to_review` | Enter review when the turn ends |

> ⚠️ **`SessionStart` is metadata-only.** Codex emits `SessionStart` for launch/resume and can also reinitialize session state around maintenance flows. Quarterdeck deliberately records it as `activity`, not `to_in_progress`, because `UserPromptSubmit`, `PreToolUse`/`PostToolUse`, and `Stop` are the reliable turn-state boundaries. Tests assert the matcher excludes `clear` and the event maps to `activity` — see `test/runtime/codex-hooks.test.ts`.

Because Codex includes `session_id` in each hook payload, Quarterdeck also persists that identifier as `resumeSessionId` on the runtime task session summary. When a task resumes later, the Codex adapter prefers `codex resume <session_id>` and only falls back to `codex resume --last` if no session id has been captured yet.

### Claude vs Codex: comparison

| Aspect | Claude | Codex |
|---|---|---|
| Integration type | Native hook system | Native hook system |
| How hooks are configured | `--settings` JSON file | Inline `-c hooks...` launch overrides |
| Minimum checked version | 2.1.198+ | 0.142.5+ with native `hooks` feature |
| Execution model | Synchronous (Claude waits) | Synchronous (Codex waits) |
| Latency | Near-instant (<100ms typical) | Near-instant (<100ms typical) |
| Failure handling | 3s timeout, 1 retry, blocks on failure | 3s timeout, 1 retry, blocks on failure |
| Metadata source | Native hook stdin payload | Native hook stdin payload |
| Resume target | Stored `session_id` via `claude --resume <id>`; `--continue` only when no id exists | Stored `session_id` via `codex resume <id>`; `--last` only when no id exists |
| Fallback | None for supported hook boundaries | None for supported hook boundaries; slash-command lifecycle is a known gap |
| Subagent filtering | Dedicated `SubagentStop` event maps to `activity` | Known limitation: current Codex payloads do not identify root-agent vs subagent `Stop`, so subagent-heavy sessions can prematurely transition to review |

> Known Codex parity gap: Quarterdeck currently maps Codex `Stop` to `to_review` so main-agent turn completion works. Until Codex exposes a reliable root-agent/subagent discriminator in hook payloads, a Codex subagent `Stop` can look identical to main-agent completion. This is tracked in `docs/todo.md` and should be revisited before claiming full Claude parity for subagent-heavy Codex workflows.

> Known Codex slash-command gap: `/compact`, `/resume`, plugin reloads, and other TUI-local maintenance commands do not currently expose stable start/finish hooks. Quarterdeck therefore should not move a review-ready card to `running` from Codex prompt redraws or `SessionStart` maintenance events, but it also cannot show a precise progress lifecycle for those operations until Codex exposes dedicated compact/slash-command hooks.

### Server-side ingestion (both agents)

Regardless of which agent sent the event, the server processes it the same way:

```
Hook CLI command (ingest or notify)
    │
    ▼
1. Read `QUARTERDECK_HOOK_TASK_ID` and `QUARTERDECK_HOOK_PROJECT_ID` from env
2. Parse metadata from flags / base64 payload / stdin / positional arg
3. Agent-specific normalization from native hook payload fields:
   - Claude: `session_id`, `hook_event_name`, `tool_name`, `notification_type`, `last_assistant_message`
   - Codex: `session_id`, `type`, `tool_name`, `tool_input`, and related native fields
4. POST to tRPC hooks.ingest endpoint (3s timeout, 1 retry)
    │
    ▼
Server hooks-api.ts:
5. Validate workspace + task exist
6. Check canTransitionTaskForHookEvent():
   - activity → never transitions state
   - to_review → only if current state === "running"
   - to_in_progress → only if current state === "awaiting_review" && canReturnToRunning()
7. Permission guard: block non-permission hooks from overwriting permission metadata
8. Apply state machine transition
9. Update hook activity metadata on the session summary
10. Broadcast state change to all connected WebSocket clients
11. If to_review with normal hook review: broadcast task_ready_for_review (error reviews skip the normal review-ready notification)
12. Capture turn checkpoint in background (git stash create)
13. Return immediately (checkpoint runs async)
```

The permission guard (step 7) prevents a race condition: if an agent is in `awaiting_review` because of a permission request, a stale `to_in_progress` hook from an earlier tool completion shouldn't override the permission state. The server checks `latestHookActivity` and blocks the transition if the current activity is a permission prompt and the incoming hook is not.

---

## Restart and Auto-Restart

### When auto-restart triggers

When an agent process exits, `session-lifecycle.ts` checks `shouldAutoRestart()`. The key decision is based on **pre-exit state** (what the state was BEFORE the state machine processed the exit):

- Pre-exit state was `running` → **yes, auto-restart** (agent was actively working when it crashed)
- Pre-exit state was `awaiting_review` → **no** (agent had already handed off to the user)
- Pre-exit state was `interrupted` → **no** (user intentionally stopped it)

### Rate limiting

`session-auto-restart.ts` enforces max **3 restarts per 5-second window** to prevent crash loops. If the limit is exceeded, auto-restart is denied and the state transitions `interrupted` → `awaiting_review` via the `autorestart.denied` event.

### What auto-restart does

1. Clones the original start request
2. Sets `resumeConversation = true` (uses the stored session id when available, otherwise the agent's best-effort continuation flag)
3. Sets `awaitReview = true` (new session starts in `awaiting_review` state)
4. Calls `startTaskSession()` to spawn a new process
5. If resume fails before the process stays interactive, retries without resume (fresh start)

### Manual restart

The user can restart a stopped task from the UI. This calls `startTaskSession()` directly with similar parameters. The difference from auto-restart is that it's user-initiated and doesn't require the rate limit check.

---

## Session Reconciliation (Health Sweep)

Every 10 seconds, `session-reconciliation-sweep.ts` runs 5 checks across all sessions:

| Check | Detects | Action |
|-------|---------|--------|
| `checkDeadProcess` | PID exists in summary but `kill(pid, 0)` fails | Treats as process exit → may auto-restart |
| `checkProcesslessActiveSession` | State is `running` but no active process entry | Marks as error |
| `checkInterruptedNoRestart` | State is `interrupted` with no pending auto-restart | Moves to `awaiting_review` |
| `checkStaleHookActivity` | Permission metadata on a session that's no longer in the right state | Clears the stale metadata |
| `checkStalledSession` | State is `running` but no hook activity for 3+ minutes | Marks as `awaiting_review` with reason `stalled` |

---

## Server Restart Recovery (Hydration)

When the Quarterdeck server restarts, `hydrateSessionEntries()` reconciles persisted sessions.json with reality (all agent processes are gone):

- Sessions that were `running` → marked `interrupted` (they crashed with the server)
- Sessions that were `awaiting_review` with a **terminal** review reason (`hook`, `exit`, `error`, `attention`, `stalled`) → **preserved as-is** (they were already done before the crash)
- Sessions that were `awaiting_review` with a non-terminal reason → marked `interrupted`

Once hydrated, the reconciliation sweep kicks in after 10 seconds and handles anything that needs auto-restart or further cleanup.

---

## UI Status Display

The `describeSessionState()` function maps session state + review reason to display labels:

| State | Review Reason | Badge Label | Badge Style |
|-------|--------------|-------------|-------------|
| `running` | — | "Running" | green/running |
| `awaiting_review` | `exit` | "Completed" | blue/review |
| `awaiting_review` | `hook` (permission) | "Waiting for approval" | yellow/needs_input |
| `awaiting_review` | `hook` (not permission) | "Ready for review" | blue/review |
| `awaiting_review` | `attention` | "Waiting for input" | yellow/needs_input |
| `awaiting_review` | `error` | "Error" | red/error |
| `awaiting_review` | `stalled` | "Stalled" | blue/review |
| `interrupted` | — | — | red/error |
| `idle` | — | "Idle" | neutral |

Badges only display on cards in `in_progress` and `review` columns (not backlog or trash).

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/core/api/task-session.ts` | Session state enum, review reasons, full summary schema |
| `src/core/api/shared.ts` | Board column ID enum (`backlog`, `in_progress`, `review`, `trash`) |
| `src/core/api/board.ts` | Board card and column schemas |
| `src/core/api/streams.ts` | WebSocket stream message types |
| `src/terminal/session-state-machine.ts` | State transition logic and guards |
| `src/terminal/session-summary-store.ts` | In-memory session state with listener system |
| `src/terminal/session-lifecycle.ts` | Spawn, exit handling, hydration, stale recovery |
| `src/terminal/session-auto-restart.ts` | Auto-restart decision logic and rate limiting |
| `src/terminal/session-reconciliation.ts` | Health check definitions (dead process, stalled, etc.) |
| `src/terminal/session-reconciliation-sweep.ts` | 10-second sweep orchestration |
| `src/terminal/agent-session-adapters.ts` | Hook injection for Claude and Codex |
| `src/commands/hooks.ts` | `quarterdeck hooks ingest` CLI command |
| `src/trpc/hooks-api.ts` | Server-side hook ingestion and transition logic |
| `src/state/workspace-state.ts` | Disk persistence (board.json, sessions.json, meta.json) |
| `src/server/runtime-state-hub.ts` | WebSocket broadcast to connected clients |
| `web-ui/src/state/board-state.ts` | Frontend board reducer (column moves, card mutations) |
| `web-ui/src/runtime/use-runtime-state-stream.ts` | WebSocket connection and message handling |
| `web-ui/src/runtime/runtime-stream-dispatch.ts` | Message type → handler routing |
| `web-ui/src/hooks/board/use-session-column-sync.ts` | Auto-moves cards between columns based on session state |
| `web-ui/src/utils/session-status.ts` | Session state → display label/badge style mapping |
| `web-ui/src/stores/workspace-metadata-store.ts` | Git state, workspace paths (external store) |
