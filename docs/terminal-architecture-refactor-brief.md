# Terminal Architecture Refactor Brief

Purpose: give a future agent enough context to plan and execute a terminal-architecture refactor without needing prior conversation context.

This brief does not argue that the current terminal UX is wrong. The goal is to preserve the good product behavior while simplifying the architecture so correctness and optimization are not tightly coupled.

Execution tracking note:

- `docs/todo.md` is the source of truth for when this refactor should be worked on.
- The matching active todo item lives under “Optimization-shaped architecture follow-ups.”

## Summary

Quarterdeck's terminal UX has real requirements that must stay intact:

- live sync with backend agent output
- restore/reconnect behavior after remount, visibility changes, or socket loss
- fast task-to-task switching
- quick switch-back to a recently viewed task
- support for dedicated terminals outside the shared task-terminal flow
- optional prewarming for likely-next task terminals

The current weakness is not "the terminal is too optimized." The weakness is that optimization policy is too central to the design. Shared-pool slot roles, warmup policy, previous-slot retention, socket reconnect, restore behavior, and viewport lifecycle are all entangled closely enough that the optimization policy feels like the core model.

Healthy target:

- backend session truth stays authoritative
- frontend viewport stays mostly presentation-focused
- session attachment is explicit
- reuse/prewarm logic becomes a thin, replaceable policy layer

If prewarming were disabled temporarily, the terminal system should still work correctly. It may become slower, but it should not become confusing or wrong.

## Relevant Files Today

Frontend:

- `web-ui/src/terminal/use-persistent-terminal-session.ts`
- `web-ui/src/terminal/terminal-slot.ts`
- `web-ui/src/terminal/terminal-pool.ts`
- `web-ui/src/terminal/terminal-dedicated-registry.ts`
- `web-ui/src/terminal/slot-dom-host.ts`
- `web-ui/src/terminal/slot-renderer.ts`
- `web-ui/src/terminal/slot-resize-manager.ts`
- `web-ui/src/terminal/slot-socket-manager.ts`
- `web-ui/src/terminal/slot-visibility-lifecycle.ts`
- `web-ui/src/terminal/slot-write-queue.ts`

Backend:

- `src/terminal/ws-server.ts`
- `src/terminal/session-manager.ts`
- `src/terminal/session-lifecycle.ts`
- `src/terminal/terminal-state-mirror.ts`

Related docs:

- `docs/architecture.md`
- `docs/plan-design-investigation.md`
- `docs/implementation-log.md`

## Current Mental Model

There are really three concerns in play, but the current code blends them together:

1. Backend session truth
   There is one real PTY-backed agent session per task, owned by the runtime.

2. Frontend terminal viewer
   The browser owns an xterm instance, DOM mounting, visibility transitions, restore application, and websocket attachment.

3. Optimization policy
   The frontend shared pool owns slot reuse, PREVIOUS retention, PRELOADING/READY warmup behavior, eviction, and free-slot rotation.

In the current design, these concerns are mixed enough that "how the terminal system works" is hard to explain without talking about pool policy.

### Current user-flow model

Rough flow for a normal task terminal:

1. `usePersistentTerminalSession()` decides whether the task is handled by the shared pool or the dedicated-terminal path.
2. `terminal-pool.ts` either reuses or allocates a `TerminalSlot`.
3. `TerminalSlot` owns xterm creation, socket connection, restore application, write buffering, resizing, visibility-driven reconnect, and output rendering.
4. `ws-server.ts` bridges browser viewers to the backend `TerminalSessionManager`.
5. Backend runtime streams terminal output from the real PTY session.

### Current design smell

The system currently reads like:

`terminal behavior = session sync + viewport lifecycle + pool role state machine`

That means the optimization policy is part of the main architecture, not an implementation detail.

## What Must Not Be Lost

The refactor should not regress these behaviors:

- multiple browser viewers can observe the same backend PTY session safely
- buffered terminal restore works when a viewer reconnects
- hidden/unhidden terminals recover from dead sockets
- task switching stays fast
- quick switch-back remains fast
- dedicated terminals remain supported
- prewarming remains possible if measurement shows it is valuable

The desired tradeoff is:

- preserve product behavior
- preserve most or all worthwhile performance characteristics
- simplify reasoning about ownership and correctness

## Target Mental Model

The cleaner model is:

1. There is one backend terminal session per task.
2. A frontend terminal viewport is just a screen.
3. A frontend attachment layer connects a viewport to a backend session.
4. Reuse and prewarming are optional optimization policies on top.

That lets the system be explained simply:

- backend session = the real thing
- viewport = the screen
- attachment = connect the screen to the real thing
- reuse/prewarm = optional speed improvements

## Proposed Architecture

### 1. `TerminalSessionHandle`

Frontend object representing an attachment-capable connection to a backend task session.

Responsibilities:

- connect IO/control sockets for a given `taskId` and `projectId`
- request restore snapshots
- expose connection status
- stream output and state events
- send input
- send resize/control messages
- reconnect cleanly when needed

What it should not own:

- xterm instance lifecycle
- DOM attachment
- pooling roles
- prewarm/eviction policy

Likely source material today:

- socket and restore logic in `web-ui/src/terminal/terminal-slot.ts`
- socket/viewer behavior in `src/terminal/ws-server.ts`

### 2. `TerminalViewport`

Frontend object wrapping xterm and DOM/rendering concerns only.

Responsibilities:

- create xterm
- manage theme/appearance
- mount/unmount to visible containers
- park/unpark when hidden
- render terminal text
- fit/focus/clear

What it should not own:

- task identity
- project identity
- websocket lifecycle
- restore request timing policy
- pool slot roles

Likely source material today:

- xterm creation and rendering responsibilities in `web-ui/src/terminal/terminal-slot.ts`
- `slot-dom-host.ts`
- `slot-renderer.ts`
- `slot-resize-manager.ts`

### 3. `TerminalAttachmentController`

Small coordination layer that attaches a viewport to a session handle.

Responsibilities:

- bind one `TerminalViewport` to one `TerminalSessionHandle`
- request and apply restore snapshot
- route live output into the viewport
- detach safely
- preserve reconnect behavior across visibility changes or remounts

This is the key layer that should make "attach this screen to that session" explicit.

### 4. `TerminalReuseManager`

Thin optimization layer for viewport reuse.

Responsibilities:

- reuse existing `TerminalViewport` instances
- optionally hold one recently used viewport hot
- optionally hand out a prewarmed viewport
- release and dispose viewports according to a bounded policy

This layer should not own correctness. If removed or disabled, the terminal system should still work.

### 5. `TerminalPrewarmPolicy`

Optional policy layer for predicting and preparing likely-next terminals.

Responsibilities:

- decide whether prewarming is worth doing
- decide which task to prewarm
- request prewarm/cancel-prewarm from the reuse manager or session layer

This can remain clever, but it must remain optional.

## Concrete Design Principle

Separate the system into:

- core correctness layer
- attachment/rendering layer
- optimization policy layer

The optimization layer may remain sophisticated. The important boundary is that a broken optimization should degrade speed, not correctness.

Smell test:

If prewarming is disabled, should the terminal still sync, restore, and switch correctly?

Desired answer: yes.

## Proposed File-Level Direction

This does not need to happen all at once, but the target shape could look roughly like this:

- `web-ui/src/terminal/terminal-session-handle.ts`
- `web-ui/src/terminal/terminal-viewport.ts`
- `web-ui/src/terminal/terminal-attachment-controller.ts`
- `web-ui/src/terminal/terminal-reuse-manager.ts`
- `web-ui/src/terminal/terminal-prewarm-policy.ts`

Possible existing files to preserve mostly as collaborators:

- `slot-dom-host.ts`
- `slot-renderer.ts`
- `slot-resize-manager.ts`
- `slot-write-queue.ts`

Possible existing files to slim down or replace:

- `terminal-slot.ts`
- `terminal-pool.ts`
- `use-persistent-terminal-session.ts`

## Migration Strategy

Prefer an incremental migration that preserves behavior and test coverage at each step.

### Phase 1. Extract the session-side frontend logic

Goal: carve socket/restore/connection logic away from `TerminalSlot`.

Steps:

1. Introduce `TerminalSessionHandle` as a wrapper over the current socket/control/restore behavior.
2. Move task/project identity and websocket ownership from `TerminalSlot` into the new handle.
3. Keep `TerminalSlot` delegating to the handle so behavior does not change yet.

Success condition:

- `TerminalSlot` no longer needs to directly own task/project identity or raw socket lifecycle.

### Phase 2. Extract the pure viewport

Goal: make the xterm screen a distinct object.

Steps:

1. Introduce `TerminalViewport` to own xterm creation, rendering, mount/park/focus/fit behavior.
2. Move viewport-only methods out of `TerminalSlot`.
3. Keep a compatibility wrapper if needed so current callers still work during the migration.

Success condition:

- A viewport can exist without knowing what task it is showing.

### Phase 3. Make attachment explicit

Goal: create a small controller that binds session handle to viewport.

Steps:

1. Introduce `TerminalAttachmentController`.
2. Move restore sequencing and output-routing logic there.
3. Update `usePersistentTerminalSession()` to think in terms of:
   - get session handle
   - get viewport
   - attach viewport to handle

Success condition:

- The main mental model becomes "attach viewer to session" rather than "acquire slot."

### Phase 4. Put the current pool behind a narrower interface

Goal: preserve optimization while shrinking its visible surface.

Steps:

1. Wrap the current shared-pool logic in `TerminalReuseManager`.
2. Make the rest of the app depend on reuse-manager operations, not slot roles.
3. Stop exposing `FREE/PRELOADING/READY/ACTIVE/PREVIOUS` as the main public model.

Success condition:

- Pool roles become internal implementation details rather than the design vocabulary.

### Phase 5. Reassess prewarming as a policy

Goal: keep the useful optimization without coupling it to correctness.

Steps:

1. Move warmup/cancel-warmup behavior under a prewarm policy interface.
2. Re-measure whether warmup meaningfully improves perceived switching latency.
3. Keep only the policy that earns its complexity.

Success condition:

- prewarming is optional and measurable
- disabling it does not break correctness

## Suggested Validation Questions

Any planning or implementation agent should answer these explicitly:

1. What is the authoritative identity of a frontend viewer attachment?
2. What state must survive temporary viewer disappearance?
3. What logic is required for correctness versus only for performance?
4. Which current `TerminalSlot` methods are really viewport methods?
5. Which current `TerminalSlot` methods are really session-handle methods?
6. Which `terminal-pool.ts` behaviors should remain public API, if any?
7. Can the system still work correctly with prewarming off?

## Suggested Verification Strategy

Keep or expand coverage around these scenarios:

- switching from one task terminal to another
- switching back quickly to the previous task terminal
- dedicated terminal behavior
- restore after remount
- restore after socket reconnect
- behavior after sleep/wake style socket loss
- multiple viewers on the same backend PTY
- prewarm reuse if the policy is kept

Existing terminal tests worth preserving and adapting:

- `web-ui/src/terminal/terminal-pool-acquire.test.ts`
- `web-ui/src/terminal/terminal-pool-lifecycle.test.ts`
- `web-ui/src/terminal/use-persistent-terminal-session.test.tsx`
- terminal slot collaborator tests under `web-ui/src/terminal/`

## Non-Goals

This refactor brief does not assume:

- removing prewarming entirely
- removing dedicated terminals
- replacing backend websocket/session architecture
- changing the product's current terminal UX goals

The intent is cleaner ownership, not a simpler product.

## Short Planning Heuristic

If a future refactor still requires a new engineer to learn slot-role transitions before they can answer "what happens when I click a different task?", the design is still too optimization-shaped.

The healthy explanation should be:

1. the viewer detaches from one session
2. the viewer attaches to another session
3. optional reuse/prewarm logic makes that fast
