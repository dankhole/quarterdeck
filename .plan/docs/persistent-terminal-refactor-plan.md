# Persistent Terminal Refactor Plan

## Goal

Adopt one terminal lifecycle model across the web app:

- terminals are long lived objects
- views attach to existing terminal objects
- prewarming is a separate policy, used only where late attach is harmful

This replaces the mixed model where some terminal surfaces use persistent xterm instances and others still use disposable xterm views.

## Why we are doing this

The recent Codex and OpenCode debugging made the core issue much clearer.

What matters most is not whether a terminal is in the bottom pane or the detail view.
What matters is whether the terminal emulator instance stays alive while the CLI session is alive.

A disposable terminal view causes problems for TUI-like CLIs because:

- the process keeps running while the emulator disappears
- reopening the view later requires reconstructing state from PTY output history
- raw PTY replay is not equivalent to preserving xterm emulator state
- prompt state, scrollback, alternate screen state, and screen repaints can look wrong or incomplete

The bottom terminal feels better today mostly because it is usually opened once and kept open, not because the disposable model is actually better.

Keeping two lifecycle systems in the codebase also has a cost:

- duplicate connection and resize logic
- two sets of cleanup rules
- harder reasoning about bugs and ownership
- inconsistent behavior across terminal surfaces

## Desired architecture

We want to separate two concerns that were previously blurred together:

1. persistence
2. prewarming

### Persistence

Persistence should be the default terminal model everywhere.
A terminal object should:

- own the xterm instance
- own the terminal websocket connections
- survive view close and reopen
- be attached to a visible container when needed
- be parked offscreen when not visible
- be disposed only when its owner no longer matters

### Prewarming

Prewarming should be selective.
Only terminal surfaces that are likely to emit important TUI state before the user opens them should be created ahead of time.

That means:

- active agent task terminals should be prewarmed
- home shell terminal should be created lazily on first open
- task detail shell terminal should be created lazily on first open

This gives us one lifecycle model without forcing every possible terminal to exist up front.

## Ownership model

Each persistent terminal should have a clear owner and disposal rule.

### Active agent task terminal

Owner:
- active task session

Creation:
- prewarm when an agent task session is non-idle

Disposal:
- when that task session is no longer considered active for prewarm purposes, or when the workspace changes

### Home terminal

Owner:
- current workspace

Creation:
- lazy, on first open

Disposal:
- on workspace change or app teardown

### Task detail shell terminal

Owner:
- selected task shell session id

Creation:
- lazy, on first open

Disposal:
- when the owning task shell terminal is no longer relevant, or on workspace change/app teardown

## Implementation plan

1. keep one generic persistent terminal manager for all terminal surfaces
2. keep one React hook that attaches a persistent terminal object to a view container
3. keep a separate prewarm hook for active agent task terminals only
4. update `AgentTerminalPanel` to always use the persistent hook
5. remove the disposable terminal hook and related branching from the panel layer
6. keep all existing terminal surfaces using the same persistent lifecycle, even if some are created lazily

## Expected benefits

- one mental model for every terminal surface
- consistent terminal behavior across home, detail shell, and task agent panels
- less duplicated lifecycle logic
- fewer reconnection and replay edge cases
- easier future improvements to terminal transport, flow control, and shell integration

## Important design choices

### Why not prewarm everything

Because persistence is the main architectural rule, but prewarming is an optimization for specific UX failures.

Prewarming every terminal would create unnecessary xterm instances and websocket connections for terminals the user may never open.
That cost is justified for active agent sessions, but not for every possible shell terminal.

### Why not keep the disposable path as a fallback

Keeping both systems makes the architecture harder to understand and easier to regress.
If the persistent manager is good enough for the hardest case, it should become the common path.

## Risks to watch

- hidden terminals still need sane initial rows and cols before first visible resize
- lazy persistent terminals must reconnect cleanly if sockets were closed while hidden
- disposal rules must stay explicit so persistent does not become leaked forever
- task state changes like in progress to review must not accidentally dispose a still-relevant terminal

## Validation plan

After the refactor, verify:

1. opening a task detail agent terminal late still shows the current Codex session state
2. closing and reopening a task detail agent terminal does not reset the terminal view
3. opening and reopening the home terminal keeps its shell state
4. opening and reopening the task detail shell terminal keeps its shell state
5. workspace changes dispose old persistent terminals cleanly
6. tests and production build continue to pass
