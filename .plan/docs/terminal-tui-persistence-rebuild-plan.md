# Terminal TUI Persistence Rebuild Plan

Date: March 28, 2026

## Goal

Make Kanban terminal reconnects and page refreshes preserve real terminal emulator state for all supported TUIs, not just line oriented CLIs.

## Problem summary

Today Kanban restores terminal sessions by replaying raw PTY output history into a fresh browser xterm instance. That is not equivalent to restoring terminal state. TUIs depend on cursor moves, clears, scroll regions, mode changes, and buffer state, so page refresh can drop transcript content or redraw an incomplete screen.

## Architecture direction

1. Keep a server side terminal mirror that survives browser refresh.
2. Feed PTY output into that mirror as the authoritative emulator state.
3. Restore browser xterm instances from serialized terminal snapshots, not raw PTY history.
4. Replace attach style fire-and-forget writes with a commit aware xterm write pipeline.
5. Backpressure live PTY output based on browser xterm write completion.

## Planned work

- [x] Add a server side terminal state mirror based on xterm headless plus serializer support
- [x] Replace raw history replay with serialized snapshot restore
- [x] Add reconnect protocol messages for restore snapshots and output acknowledgements
- [x] Replace frontend attach addon transport with an explicit write queue
- [x] Gate live output until restore completes
- [x] Add tests for refresh and reconnect behavior
- [x] Run lint, typecheck, tests, and build validation

## Progress log

### 2026-03-28

- Investigated Codex and VS Code terminal behavior.
- Confirmed the current reconnect path replays raw PTY bytes instead of restoring terminal state.
- Added a server side terminal mirror built on `@xterm/headless` and `@xterm/addon-serialize`.
- Changed reconnect restore to ship serialized terminal snapshots instead of PTY output history.
- Replaced frontend attach transport with explicit xterm writes that acknowledge committed output back to the server.
- Gated live IO attachment until restore completes so reconnect ordering is deterministic.
- Added terminal persistence tests and reran lint, typecheck, root tests, web tests, and web build validation.
