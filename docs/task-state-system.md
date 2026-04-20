# Task State System

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

For hook-triggered transitions specifically, there's also a `task_ready_for_review` message sent alongside `task_sessions_updated` — this is used for notification sounds and auto-review scheduling, not column moves.

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

**Setup:** Before spawning Claude, Quarterdeck generates a hooks settings JSON file at `~/.quarterdeck/hooks/claude/settings.json` and passes it via the `--settings` CLI flag. The file maps Claude events to `quarterdeck hooks ingest` commands:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_review --source claude" }]
    }],
    "PermissionRequest": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_review --source claude" }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_in_progress --source claude" }]
    }],
    "Notification": [{
      "matcher": "permission_prompt",
      "hooks": [{ "type": "command", "command": "quarterdeck hooks ingest --event to_review --source claude" }]
    }]
  }
}
```

The full mapping:

| Claude Event | Hook Event | Why |
|---|---|---|
| `Stop` | `to_review` | Claude finished its turn, waiting for user |
| `PermissionRequest` | `to_review` | Claude needs permission to use a tool |
| `Notification` (permission_prompt) | `to_review` | Permission prompt surfaced |
| `Notification` (*) | `activity` | General notification (progress info) |
| `PostToolUse` | `to_in_progress` | Tool completed, Claude is working again |
| `PostToolUseFailure` | `to_in_progress` | Tool failed, Claude is working again |
| `UserPromptSubmit` | `to_in_progress` | User provided input, Claude resumes |
| `PreToolUse` | `activity` | About to call a tool (informational) |
| `SubagentStop` | `activity` | A sub-agent finished (informational) |

**Execution model:** Synchronous and blocking. When Claude fires a hook event, it executes the `quarterdeck hooks ingest` command and waits for it to finish before continuing. The ingest command has a 3-second timeout per attempt and does a single retry after 1 second if the first attempt fails. This means in the worst case, a hook call blocks Claude for ~7 seconds. In practice, it's near-instant.

**Metadata extraction:** When Claude stops (`to_review` from the `Stop` event), the hook payload includes a `transcript_path` pointing to Claude's JSONL conversation transcript. The ingest command reads this file, finds the last assistant message (skipping short preambles like "I'll read that file"), caps it at 500 characters, and includes it as `conversationSummaryText` in the hook metadata. This is how the UI shows a summary of what the agent last said.

### Codex hooks: external observation layer

Codex has no native hook system. There's no equivalent of Claude's `--settings` flag or lifecycle event callbacks. Quarterdeck can't ask Codex to call a command when it stops or starts — it has to figure that out from the outside.

The solution is a **wrapper + log watcher** architecture with three layers:

**Layer 1: The wrapper.** Instead of launching Codex directly, Quarterdeck launches `quarterdeck hooks codex-wrapper --real-binary codex -- [codex args]`. This wrapper process:

1. Sets environment variables that tell Codex to record its session: `CODEX_TUI_RECORD_SESSION=1` and `CODEX_TUI_SESSION_LOG_PATH=/tmp/quarterdeck-codex-session-{pid}_{timestamp}.jsonl`
2. Starts a log watcher (see layer 2)
3. Spawns the real Codex binary with `stdio: "inherit"` (terminal output goes straight through)
4. Forwards signals (SIGINT, SIGTERM) to the child process
5. On exit, stops the watcher (flushing any partial lines), waits up to 3 seconds for cleanup, then exits with Codex's exit code

**Layer 2: The session log watcher.** Runs concurrently with Codex inside the wrapper process. Every 200ms, it:

1. Stats the JSONL session log file to check if the size changed
2. If new bytes exist, reads only the new portion (tracks byte offset)
3. Splits into lines, keeping any incomplete line in a remainder buffer
4. Parses each line as JSON and maps it to a Quarterdeck hook event
5. Calls the notification callback for each mapped event

If the session log doesn't exist yet (Codex hasn't started writing), the watcher falls back to scanning Codex's rollout activity log at `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-*.jsonl`, polled every 1 second. This is a secondary signal source.

The JSONL log contains structured events. Example lines:

```json
{"dir":"to_tui","kind":"codex_event","msg":{"type":"task_started","command":"Fix the parser bug"}}
{"dir":"to_tui","kind":"codex_event","msg":{"type":"task_complete","last_agent_message":"Fixed the bug"}}
{"dir":"from_tui","kind":"op","payload":{"type":"exec_command_begin","call_id":"call_123","command":["bash","-c","npm test"]}}
```

The event mapping:

| Codex Log Event | Hook Event | Metadata |
|---|---|---|
| `task_started`, `turn_started` | `to_in_progress` | "Working on task: {command}" |
| `user_turn` | `to_in_progress` | "Resumed after user input" |
| `task_complete` | `to_review` | "Final: {lastAgentMessage}" |
| `approval_request`, `permission_request` | `to_review` | "Waiting for approval" |
| `exec_command_begin` | `activity` | "Running command: {command}" |
| `exec_command_end` | `activity` | "Command finished/failed: {command}" |
| `raw_response_item` (function_call) | `activity` | "Calling {name}: {command}" |
| `agent_message` | `activity` | "Agent: {message}" |

The watcher has deduplication logic — it tracks fingerprints (`lastTurnId`, `lastApprovalId`, `lastExecCallId`) to avoid emitting duplicate events when Codex logs the same action multiple times. It also filters out events from descendant/subagent sessions by detecting `session_meta` entries with `source.subagent.thread_spawn`.

**Layer 3: Detached notification.** When the watcher maps a log event to a hook event, it doesn't call `quarterdeck hooks ingest` synchronously (that would block the poll loop). Instead, it spawns a fully detached process:

```
quarterdeck hooks notify --event to_review --source codex
```

`notify` is a best-effort variant of `ingest`. It has the same internal logic (parse metadata, POST to tRPC, single retry) but wraps everything in a try/catch that swallows all errors silently. The spawned process is detached (`detached: true`, `stdio: "ignore"`, `child.unref()`) so it runs independently of the wrapper — if the wrapper exits, in-flight notifications still complete.

**Fallback mechanism.** As a safety net, the wrapper also injects a Codex config flag (`-c notify=[quarterdeck hooks notify --event to_review --source codex]`) into Codex's arguments. This uses Codex's own legacy `notify` config, which fires a command when the task completes. If the log watcher misses the completion event (file I/O failure, unexpected log format), this fallback ensures at least one `to_review` event reaches the server.

### Claude vs Codex: comparison

| Aspect | Claude | Codex |
|---|---|---|
| Integration type | Native hook system | External log observation |
| How hooks are configured | `--settings` JSON file | Wrapper + JSONL watcher |
| Execution model | Synchronous (Claude waits) | Asynchronous (detached processes) |
| Latency | Near-instant (<100ms typical) | ~200ms poll interval + spawn overhead |
| Failure handling | 3s timeout, 1 retry, blocks on failure | Best-effort, silent failure, never blocks |
| Metadata source | Transcript file (parsed on `to_review`) | JSONL session log (parsed continuously) |
| Fallback | None needed (native) | Legacy `-c notify` config |
| Subagent filtering | N/A (hooks only fire on main agent) | Tracks `session_meta` to ignore descendant sessions |

### Server-side ingestion (both agents)

Regardless of which agent sent the event, the server processes it the same way:

```
Hook CLI command (ingest or notify)
    │
    ▼
1. Read QUARTERDECK_HOOK_TASK_ID and QUARTERDECK_HOOK_WORKSPACE_ID from env
2. Parse metadata from flags / base64 payload / stdin / positional arg
3. Agent-specific enrichment:
   - Claude: read transcript file for last assistant message
   - Codex: read rollout file for final message
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
11. If to_review: broadcast task_ready_for_review (for UI notifications)
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
2. Sets `resumeConversation = true` (passes `--continue` flag to the agent so it picks up where it left off)
3. Sets `awaitReview = true` (new session starts in `awaiting_review` state)
4. Calls `startTaskSession()` to spawn a new process
5. If `--continue` fails, retries without it (fresh start)

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
| `web-ui/src/hooks/board/use-review-auto-actions.ts` | Auto-trash/auto-commit scheduling |
| `web-ui/src/utils/session-status.ts` | Session state → display label/badge style mapping |
| `web-ui/src/stores/workspace-metadata-store.ts` | Git state, workspace paths (external store) |
