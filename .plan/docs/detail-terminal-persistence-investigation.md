# Detail Terminal Persistence Investigation

## Problem summary

The Codex CLI behaves reliably in the persistent bottom terminal pane, but behaves poorly in the detail view terminal.
Symptoms include:

- old content appearing to disappear
- opening the detail view late in a session not showing prior messages
- Codex input UI or prompt state appearing only when the terminal was already open before the session output arrived
- jank around task state changes such as moving from in progress to review

## Key insight

The important difference is not just xterm version or Codex behavior.
The bottom terminal effectively behaves like a long-lived terminal object, while the detail terminal behaves like a disposable view that reconnects to an already-running session.

That difference is enough to explain the observed behavior.

## What the bottom terminal gets right

The bottom terminal stays mounted and attached for the duration of the session.
That means:

- xterm processes output live as it happens
- xterm keeps its own internal buffer state
- scrollback is owned by the active emulator instance
- the current screen state is preserved without needing reconstruction
- TUIs like Codex keep their prompt/input state because the emulator never has to be rebuilt mid-session

## What the detail terminal does today

The detail terminal does not preserve a live emulator instance.

Current flow:

1. the task session starts on the backend
2. the detail terminal UI may not exist yet
3. when the user opens the task detail view, we create a new xterm instance
4. we call `terminal.reset()` on mount for the task/workspace pair
5. we attach to the live session after it has already emitted output
6. we replay only backend PTY output history, not terminal state

Relevant code:

- `web-ui/src/terminal/use-persistent-terminal-session.ts`
- `web-ui/src/terminal/persistent-terminal-manager.ts`
- `src/terminal/session-manager.ts`
- `src/terminal/pty-session.ts`

## Why this breaks Codex

Codex behaves like a TUI and does screen repainting/clearing, not just append-only line output.
That means late reconstruction from raw PTY bytes is fundamentally lossy.

We are currently trying to rebuild a live terminal screen from:

- a capped PTY byte history buffer
- no serialized terminal state
- no preserved xterm instance
- no preserved alt-screen or cursor state

That is not equivalent to a terminal that stayed attached the whole time.

## Important backend limitation

The backend PTY history is not enough to recover the real terminal state.

`PtySession` stores only raw output bytes, capped to 1 MB.
The attach path replays those bytes to new listeners.

Worse, once the process exits, replay is effectively gone for new attaches because replay currently reads from `entry.active?.session.getOutputHistory()`.
If `entry.active` is already `null`, a fresh detail terminal cannot reconstruct prior output from the backend.

This makes a persistent frontend terminal instance even more valuable.

## Upstream xterm context

The upstream xterm issue `xtermjs/xterm.js#5745` is useful context, but it does not by itself solve our problem.
The maintainer response points out that Codex explicitly uses erase-display behavior and that xterm's handling is intentional.

Takeaway:

- xterm alone will not reconstruct Codex history for us
- a host app must preserve terminal/emulator state if it wants a native-feeling experience for reconnecting views

VS Code also enables `scrollOnEraseInDisplay: true`, which we already do in our terminal options, but that is only one piece.
The larger difference is lifecycle and terminal capabilities around xterm.

## Why VS Code feels better

The VS Code reference suggests a different mental model:

- terminals are long-lived objects
- views attach to terminal objects, rather than creating a new emulator every time
- terminal capabilities and shell integration are layered on top of xterm
- the host owns more state than just a raw websocket-to-pty bridge

The key lesson for us is not "copy one xterm option from VS Code".
The key lesson is "stop treating the detail terminal as disposable UI".

## Root cause statement

The detail terminal problems are primarily caused by lifecycle mismatch:

- the backend session is long-lived
- the Codex TUI assumes a long-lived terminal emulator
- our detail terminal emulator is short-lived and reconnects late

That mismatch causes lost scrollback, missing prompt state, and late-open inconsistencies.

## Proposed fix direction

Treat task terminals as long-lived objects, not disposable views.

Concretely:

1. create and keep a persistent xterm instance for each active agent task
2. prewarm that terminal when the task session becomes active, before the detail view opens
3. keep the terminal websocket connections alive even when the detail card is closed
4. park the terminal host offscreen when not visible instead of disposing it
5. when the detail view opens, reattach the existing terminal host to the visible container instead of creating a new xterm instance
6. keep terminal state alive across in-progress to review transitions
7. keep the buffer visible even after process exit until the task/session is actually discarded

## Initial rollout architecture

The first implementation should stay focused on the detail agent terminal that is showing the problem most clearly.

Initial architecture:

1. add a persistent task terminal manager in the web UI
2. create one xterm instance per active agent task
3. keep that xterm instance and its websocket connections alive even when the card UI is closed
4. park the terminal host in an offscreen container when not visible
5. move that same host into the detail view container when the user opens the card
6. prewarm terminals from app level session state so they exist before the detail view opens
7. keep the existing ephemeral terminal flow for other terminal surfaces until this model proves itself

This gives us the persistent lifecycle benefits without having to rewrite every terminal surface at once.

## Why this approach first

This is the smallest change that directly addresses the lifecycle mismatch.

It avoids betting on:

- backend byte replay becoming good enough for TUIs
- xterm magically reconstructing state from old PTY output
- a more complex terminal serialization system before we have proven the lifecycle fix

It also matches the strongest behavioral clue we have:
the persistent bottom terminal already behaves much more like the desired experience.

## What we are not relying on

This change is intentionally not based on:

- increasing PTY history size
- trying to parse Codex output heuristically
- rebuilding the screen from raw bytes after the fact
- assuming a single xterm option will make Codex behave natively

Those may still be useful supporting improvements later, but they do not address the core mismatch.

## Scope decisions

This persistence work should apply to active task agent terminals.
Backlog and trash cards do not need prewarmed terminals because there is no running agent TUI there.

The bottom terminal already behaves much closer to the desired model and is useful as the behavioral reference.

## Expected user-facing outcome

After this change, the detail terminal should:

- show prior Codex content even if opened mid-session
- preserve the active prompt/input state more reliably
- avoid screen reconstruction jank when reopening the card
- feel more like the persistent bottom terminal
- survive in-progress to review moves without looking like a brand new terminal

## Follow-up opportunities

After persistence lands, we should consider:

- preserving terminal state after backend process exit more explicitly
- reducing dependence on backend byte-history replay
- evaluating xterm serialize/state capture for reconnect or reload scenarios
- continuing to study VS Code shell integration and capability layering

## Risks and watchouts

The persistence model is the right direction, but it comes with some implementation details to watch carefully:

- a prewarmed hidden terminal still needs a sane initial rows and cols estimate, or TUIs can start on the wrong grid before first visible resize
- reconnect behavior matters because a long-lived terminal that silently loses its sockets feels worse than a disposable one
- keeping one terminal per active task increases browser memory and websocket usage, which is acceptable for active tasks but should stay scoped away from backlog and trash
- moving a task between in progress and review must not dispose the persistent terminal object if the task session is still considered active

## Success criteria

We should consider this approach successful when:

- opening a task detail terminal late still shows the existing Codex conversation
- the Codex input area and prompt state survive reopening the card
- in progress to review transitions do not make the detail terminal look brand new
- the detail terminal feels materially closer to the persistent bottom terminal
