# Terminal WebSocket Bridge Refactor Brief

Purpose: give a future agent enough context to plan and execute a refactor of `src/terminal/ws-server.ts` without needing prior conversation context.

This is a planning brief, not an implementation. The goal is to preserve the current terminal UX while making the websocket bridge read more like connection ownership and transport coordination, with buffering/backpressure/restore timing expressed as policy layers instead of the primary model.

Execution tracking note:

- `docs/todo.md` is the source of truth for when this refactor should be worked on.
- The matching active todo item lives under “Optimization-shaped architecture follow-ups.”

## Summary

`src/terminal/ws-server.ts` currently does an important job well:

- one backend PTY session can safely feed multiple browser viewers
- reconnecting viewers can restore from a server-side terminal snapshot
- slow viewers can backpressure the shared PTY instead of falling infinitely behind
- resize-before-restore reduces garbled prompt and status-bar rendering

The current weakness is not that these behaviors exist. The weakness is that they are all explained through one file and one state machine. The websocket bridge currently owns:

- transport upgrade and socket acceptance
- task-level stream attachment
- per-viewer socket replacement
- per-viewer restore lifecycle
- per-viewer output buffering
- shared PTY pause/resume coordination
- control message routing
- transport cleanup

That makes the bridge read like:

`terminal transport = connection routing + viewer lifecycle + restore choreography + backpressure engine`

Healthy target:

- the websocket bridge owns connection identity and transport wiring first
- backend session truth stays in the terminal session manager and mirror
- buffering/backpressure/restore timing remain intact, but live behind explicit policy/coordinator boundaries

If batching, backpressure thresholds, or deferred restore timing were temporarily simplified, the system should still be clearly correct. It may become less smooth, but not harder to reason about.

## Relevant Files Today

Primary backend files:

- `src/terminal/ws-server.ts`
- `src/terminal/session-manager.ts`
- `src/terminal/session-lifecycle.ts`
- `src/terminal/terminal-state-mirror.ts`
- `src/terminal/terminal-session-service.ts`

Relevant frontend files:

- `web-ui/src/terminal/slot-socket-manager.ts`
- `web-ui/src/terminal/slot-write-queue.ts`
- `web-ui/src/terminal/terminal-session-handle.ts`
- `web-ui/src/terminal/terminal-attachment-controller.ts`
- `web-ui/src/terminal/terminal-slot.ts`

Relevant tests today:

- `test/runtime/terminal/ws-server.test.ts`
- `test/runtime/terminal/session-manager.test.ts`
- `test/runtime/terminal/terminal-state-mirror.test.ts`

Related docs:

- `docs/terminal-architecture-refactor-brief.md`
- `docs/design-guardrails.md`
- `docs/optimization-shaped-architecture-followups.md`
- `docs/design-weaknesses-roadmap.md`

## What `ws-server.ts` Is Responsible For Today

Today the websocket bridge owns all of these concerns:

1. Websocket upgrade routing
   It identifies IO vs control websocket paths, validates `taskId` / `projectId`, resolves the `TerminalSessionService`, and hands the request to the right `WebSocketServer`.

2. Connection identity
   It keys task-scoped transport state by `projectId:taskId`, then keys viewer-scoped state by `clientId`.

3. Shared PTY fanout
   It attaches to PTY output once per task session and fans chunks out to every active viewer for that task.

4. Viewer lifecycle
   It replaces older IO/control sockets for the same `clientId`, tracks whether that viewer has completed restore, and removes viewer state when both sockets are gone.

5. Restore sequencing
   It defers initial restore until resize or timeout, pauses per-viewer live delivery during restore, buffers output during that gap, and resumes delivery on `restore_complete`.

6. Backpressure and batching
   It batches outgoing IO chunks, tracks websocket buffered bytes plus renderer ACK debt, pauses the shared PTY when any viewer exceeds thresholds, and only resumes once every slow viewer drains.

7. Control-plane forwarding
   It forwards resize, stop, output ACK, restore requests, and session state/exit messages between browser viewers and `TerminalSessionService`.

8. Cleanup
   It tears down per-viewer listeners, per-task output listeners, websocket servers, and transport sockets on disconnect or shutdown.

## Current Mental Model

There are really three separate concerns here, but `ws-server.ts` blends them tightly:

1. Backend terminal session truth
   `TerminalSessionManager` owns the real PTY session, input/output, resize, pause/resume, and the headless terminal mirror used for snapshots.

2. Viewer connection ownership
   The bridge owns which browser viewer sockets are attached to which backend task session.

3. Transport policy
   The bridge also owns when to batch, when to pause, when to resume, when to defer restore, and what to buffer.

The design smell is that the file is hard to explain without leading with restore timing and backpressure details. That is the hallmark of optimization-shaped architecture.

## Core Transport Responsibilities Vs Policy Responsibilities

### Core transport responsibilities

These are the responsibilities that should still define the bridge after refactoring:

- accept IO and control websocket connections
- resolve the target task/session
- maintain task-scoped and viewer-scoped connection identity
- attach one task output listener and fan output to active viewers
- route client messages to the session service
- route session state/exit/snapshot messages back to viewers
- clean up sockets and listeners deterministically

### Policy responsibilities

These are still useful, but they should read as policy or coordination layers:

- low-latency output batching thresholds
- output high-water and low-water marks
- ACK-based backpressure accounting
- shared pause/resume coordination across multiple viewers
- initial restore deferral until resize or timeout
- buffering output during the restore window
- whether disconnected viewers should buffer anything at all

The healthy distinction is:

- transport says who is connected to what and where messages go
- policy says how aggressively to batch, pause, defer, and buffer

## Current Invariants That Must Not Regress

The refactor must preserve these behaviors:

- one backend PTY session may have multiple browser viewers at the same time
- viewers with different `clientId`s must not evict each other
- a newer IO or control socket for the same `clientId` should replace the older one cleanly
- PTY output should be attached once per task, not once per websocket
- restore snapshots come from the backend headless mirror, not from client-side guesswork
- initial restore should happen after the server has had a chance to apply the viewer’s real dimensions
- live output should not race ahead of a viewer while it is applying a restore snapshot
- disconnected viewers should not accumulate unbounded output buffers
- if any active viewer is backpressured badly enough, the shared PTY should pause
- the PTY should resume only after the last backpressured viewer catches up or disconnects
- websocket disconnect/reconnect should not reset backend session truth
- `recoverStaleSession(taskId)` should still happen on viewer connect

## Multi-Viewer Behavior Today

The current multi-viewer model is task-scoped first, viewer-scoped second:

- one `TerminalStreamState` exists per `projectId:taskId`
- one PTY output listener is attached per `TerminalStreamState`
- each `clientId` gets its own `TerminalViewerState`
- each viewer has independent IO socket, control socket, restore flag, and pending output buffer
- backpressure is tracked per viewer, but pause/resume is coordinated at the shared task stream

This is a good product invariant and should remain the architectural center for the bridge.

The main improvement needed is structural: make “shared task stream plus independent viewers” easier to see without reading the batching and restore details at the same time.

## Buffering And Backpressure Behavior Today

There are two distinct buffering behaviors in the current bridge:

### 1. Outbound batching per IO socket

Each viewer’s IO socket has an `IoOutputState` that:

- sends small chunks immediately in a low-latency window
- otherwise batches chunks for a short timer
- tracks websocket `bufferedAmount`
- tracks unacknowledged renderer bytes via `output_ack`

### 2. Restore-gap buffering per viewer

While a viewer has an IO socket but has not yet completed restore:

- live PTY output is buffered into `pendingOutputChunks`
- those chunks flush after `restore_complete`

Important nuance:

- when a viewer’s IO socket is fully disconnected, the bridge intentionally does not keep buffering live output for that viewer
- the reconnect path relies on the restore snapshot being authoritative, which avoids unbounded memory growth

Backpressure pause/resume behavior:

- if any viewer crosses a high watermark, the bridge pauses the shared PTY through `terminalManager.pauseOutput(taskId)`
- the bridge tracks all slow viewers in `backpressuredViewerIds`
- the PTY resumes only when that set becomes empty

This behavior is useful and should remain, but it should become a named policy layer rather than hidden inline in the bridge.

## Restore And Snapshot Timing Behavior Today

Current restore flow:

1. Control socket connects.
2. Viewer state resets `restoreComplete = false` and clears pending output.
3. The bridge starts a deferred snapshot timer.
4. The client immediately sends a resize from `SlotSocketManager` on control socket open.
5. If resize arrives before timeout, the bridge applies it via `terminalManager.resize(...)` and then requests the snapshot.
6. If no resize arrives, timeout fallback still requests the snapshot.
7. The server sends a `restore` message containing serialized mirror state plus dimensions.
8. The client applies the restore snapshot and replies with `restore_complete`.
9. Only then does the bridge flush that viewer’s pending live output.

Why this exists:

- if the snapshot is serialized before the mirror sees the viewer’s real dimensions, cursor-positioned content can render incorrectly
- if live output is sent while the client is replacing its full terminal buffer, output can be lost, duplicated, or visually interleaved

This is good behavior. The refactor goal is not to remove it. The goal is to make it read as restore coordination policy rather than as the core transport model.

## Ownership Boundaries

### Backend session truth

Owned by:

- `TerminalSessionManager`
- `session-lifecycle.ts`
- `terminal-state-mirror.ts`

Responsibilities:

- PTY process lifecycle
- PTY input/output
- authoritative resize
- pause/resume
- headless mirror state and restore snapshots
- session summary / exit events

### Viewer connections

Should remain owned by the websocket bridge:

- which viewers exist for a given task
- which sockets are currently active for each viewer
- which viewer listeners must be attached or detached

### Transport policy

Should become explicit collaborators rather than inline bridge logic:

- restore timing
- live-output buffering during restore
- batching thresholds
- backpressure thresholds
- shared pause/resume coordination

### Important non-goal

The bridge should not become the owner of terminal truth. It should coordinate access to terminal truth that lives elsewhere.

## Proposed Target Architecture

The backend bridge should read as:

1. connection registry owns task/viewer/socket identity
2. output fanout owns one-task-to-many-viewers distribution
3. restore coordinator owns snapshot timing and restore-gap buffering
4. backpressure policy owns pause/resume thresholds and ACK accounting
5. websocket bridge orchestrator wires those pieces together

### Proposed module split

The exact filenames can vary, but the target shape should look roughly like:

- `src/terminal/terminal-ws-bridge.ts`
  Thin orchestration entry point. Owns upgrade routing and wires the collaborators together.

- `src/terminal/terminal-ws-connection-registry.ts`
  Owns `projectId:taskId` stream records, `clientId` viewer records, socket replacement, and cleanup.

- `src/terminal/terminal-ws-output-fanout.ts`
  Attaches one PTY output listener per task stream and distributes chunks to viewers.

- `src/terminal/terminal-ws-restore-coordinator.ts`
  Owns initial deferred restore, resize-before-snapshot sequencing, restore request/complete flow, and per-viewer buffering during restore.

- `src/terminal/terminal-ws-backpressure-policy.ts`
  Owns outgoing socket batching, ACK accounting, watermark checks, and task-level pause/resume coordination.

- `src/terminal/terminal-ws-protocol.ts`
  Optional helper for parsing/sending control payloads and keeping protocol-specific helpers out of the bridge shell.

### Target responsibility boundaries

#### `terminal-ws-bridge`

Should own:

- upgrade path routing
- resolving `TerminalSessionService`
- delegating connection events to the registry/coordinators

Should not own:

- watermark math
- restore timers
- per-viewer batching logic

#### `connection-registry`

Should own:

- stream identity
- viewer identity
- socket replacement
- detach/cleanup rules

Should not own:

- pause/resume thresholds
- snapshot timing policy

#### `restore-coordinator`

Should own:

- initial control-connect restore flow
- resize-before-restore sequencing
- fallback timeout
- `request_restore` / `restore_complete`
- buffering while restore is incomplete

Should not own:

- websocket upgrade routing
- shared PTY pause/resume decisions

#### `backpressure-policy`

Should own:

- per-viewer unacknowledged byte accounting
- websocket buffered-byte checks
- batching and flush timers
- task-level pause/resume coordination

Should not own:

- viewer lifecycle identity
- restore semantics

## Rollout Strategy

Prefer an incremental refactor with behavior preserved at each step.

### Phase 1. Extract protocol and constants

Goal:

- remove parsing/sending helpers and magic thresholds from the orchestration shell

Success condition:

- `ws-server.ts` gets smaller without changing behavior

### Phase 2. Extract connection registry

Goal:

- move task/viewer/socket identity and cleanup into a dedicated registry

Success condition:

- the main bridge no longer directly manipulates nested `Map` cleanup rules inline

### Phase 3. Extract output fanout

Goal:

- isolate “attach once per task, distribute to viewers” from websocket lifecycle code

Success condition:

- multi-viewer semantics are visible in one place without batching code noise

### Phase 4. Extract restore coordinator

Goal:

- make restore handshake and output buffering during restore explicit

Success condition:

- the resize/deferred-snapshot/restore-complete flow is explainable without reading the whole bridge

### Phase 5. Extract backpressure policy

Goal:

- isolate batching and ACK/watermark-driven pause/resume behavior

Success condition:

- the bridge can be explained without leading with backpressure math

### Phase 6. Rename the bridge shell if helpful

Goal:

- leave a small orchestration module whose name matches its real job

Possible direction:

- keep `ws-server.ts` as a thin compatibility entry point that delegates to `terminal-ws-bridge.ts`

Success condition:

- the top-level file reads like assembly, not policy

## Test Plan

### Existing coverage to preserve

- `test/runtime/terminal/ws-server.test.ts`
  Current coverage includes multi-viewer broadcast and shared pause/resume across backpressured viewers.

- `test/runtime/terminal/session-manager.test.ts`
  Confirms restore snapshots come from the terminal state mirror.

- `test/runtime/terminal/terminal-state-mirror.test.ts`
  Confirms snapshot contents, alternate-screen preservation, resize-before-snapshot ordering, and terminal-query responses.

### Coverage that should be added during the refactor

- initial restore is sent after the first resize when resize arrives promptly
- initial restore still happens after timeout when no resize arrives
- live output emitted during restore is buffered and flushed after `restore_complete`
- live output is not buffered indefinitely for viewers with no IO socket
- replacing IO socket for the same `clientId` closes the older socket but keeps viewer identity
- replacing control socket for the same `clientId` closes the older socket but keeps viewer identity
- PTY output listener remains attached once per task stream even with multiple viewers and reconnects
- PTY resumes when the last backpressured viewer disconnects before sending an ACK
- invalid control payload still returns an error message without destabilizing sibling viewers
- cleanup removes task-scoped stream state once the last viewer detaches

### Suggested testing shape

- keep top-level behavior tests at the bridge boundary
- add focused unit tests for extracted collaborators, especially restore and backpressure policy
- avoid rewriting the whole suite into implementation-detail tests

## Acceptance Criteria

The refactor is successful when:

- `ws-server.ts` no longer reads as the only place where transport, restore, and backpressure behavior are defined at once
- another engineer can explain the bridge starting from connection ownership rather than from restore timers or watermark thresholds
- multi-viewer semantics are preserved
- restore correctness is preserved
- batching and backpressure behavior are preserved or intentionally re-tuned with explicit reasoning
- task/session truth still clearly lives in `TerminalSessionManager` and `TerminalStateMirror`
- disabling or simplifying a policy layer would degrade smoothness, not correctness

## Gotchas And Likely Migration Risks

Highest-risk areas:

1. Same-`clientId` socket replacement
   It is easy to accidentally regress “replace just one side” behavior and either leak old listeners or evict the wrong viewer state.

2. Restore-gap output handling
   Clearing or flushing `pendingOutputChunks` at the wrong time can cause missing output, duplicate output, or stale output after reconnect.

3. Shared pause/resume across viewers
   The pause/resume behavior depends on task-scoped coordination, not just per-socket thresholds. A refactor can easily resume too early if it loses the shared set semantics.

4. Resize-before-snapshot timing
   This is subtle but user-visible. If the refactor regresses ordering, prompts and status bars can look corrupted even though the connection technically works.

5. Interaction with `recoverStaleSession`
   Viewer connect currently nudges stale task sessions back into a recoverable state. That trigger should not get lost while moving connection logic around.

6. Cleanup ordering
   Detaching control listeners, disposing IO state, and removing stream state must happen in a stable order or leaked listeners and orphaned pause state can accumulate.

## Short Planning Heuristic

If a future refactor still requires someone to understand ACK thresholds and restore timers before they can answer “how does a browser viewer attach to a terminal session?”, the bridge is still too optimization-shaped.

The healthy explanation should be:

1. a viewer connects to a task-scoped terminal stream
2. the bridge attaches that viewer’s IO and control sockets
3. the viewer restores from backend mirror state
4. live output is fanned out to attached viewers
5. buffering and backpressure policies make that flow safe and smooth
