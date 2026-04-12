# Terminal Scrollback Investigation

**Date**: 2026-04-11
**Status**: Fixed

## Problem

Scrolling up in an agent terminal shows the same conversation repeated many times. Some copies are the correct width, others are half-screen or mismatched widths. The HTML chat view also showed duplicates before a separate viewport-only fix.

## Root Cause

`scrollOnEraseInDisplay: true` in xterm.js. This setting was inherited from upstream kanban (commit `5b61cd99` by Saoud Rizwan, 2026-03-11) as part of a terminal infrastructure refactor for full-screen TUI support. Before that commit, the setting wasn't set — xterm.js default is `false`.

### How it causes duplicates

Claude Code is a full-screen TUI. It redraws its entire screen constantly — status bar updates, tool call transitions, prompt redraws, response chunks. Each redraw sends an ED2 (erase-in-display) escape sequence to clear the screen before repainting.

With `scrollOnEraseInDisplay: true`, xterm.js doesn't actually erase — it pushes the current viewport into the scrollback buffer, then gives the TUI a fresh screen. After hundreds of redraws, the 10,000-line scrollback buffer is full of copies of the conversation at various points in time.

### Why different widths

The terminal has multiple resize trigger paths (mount, ResizeObserver, DPR change, state transition, restore). Each resize sends SIGWINCH to the PTY, causing Claude Code to redraw at the new column width. That redraw's ED2 pushes the old (different-width) content into scrollback.

### Why the problem exists on both browser and server

There are **two xterm.js terminals** per session:
1. **Browser** (`PersistentTerminal` in `persistent-terminal-manager.ts`) — renders to canvas, user scrolls through its buffer
2. **Server** (`TerminalStateMirror` in `terminal-state-mirror.ts`) — headless, builds restore snapshots for new/reconnecting browser tabs

Both were using `scrollOnEraseInDisplay: true`. Fixing only the browser side was insufficient — the server mirror accumulated duplicate scrollback and serialized it into restore snapshots. On connect/reconnect, the browser received a snapshot full of junk that was written into the terminal buffer.

## How Real Terminals Handle This

Ghostty, iTerm2, Kitty, etc. use the **alternate screen buffer** (DECSET 1049). When a full-screen TUI starts, the terminal saves the current scrollback and gives the app a blank canvas. ED2 clears on the alternate buffer don't touch scrollback. When the app exits, the terminal restores the original buffer.

xterm.js supports alternate screen buffers too, but `scrollOnEraseInDisplay: true` overrides the behavior — it pushes content to scrollback even on the alternate buffer. Setting it to `false` lets xterm.js handle alternate screen buffers the way real terminals do.

## Fix Applied

### 1. Per-terminal `scrollOnEraseInDisplay`

Made the setting configurable per-terminal. Threaded as an optional boolean (default `true`) through:

```
createQuarterdeckTerminalOptions → PersistentTerminal constructor →
ensurePersistentTerminal → usePersistentTerminalSession → AgentTerminalPanel
```

- **Agent terminals** (task detail + home sidebar agent) pass `false`
- **Shell terminals** (home shell + detail shell) omit it, getting default `true`

Shell terminals keep `true` because the `clear` command uses ED2 and users expect it to preserve output in scrollback (same as Ghostty/iTerm2).

### 2. Server-side mirror + epoch resize dedup

- Added `scrollOnEraseInDisplay` option to `TerminalStateMirror`, set to `false` for agent sessions in `session-manager.ts`
- Replaced 3 manual resize dedup resets (`lastSentCols = 0; lastSentRows = 0`) with epoch-based invalidation:
  - `resizeEpoch` counter bumped by `invalidateResize()` on lifecycle events
  - `requestResize()` sends unconditionally when epoch is unsatisfied
  - Added `invalidateResize()` at IO socket open (gap: reconnected socket lost server dimensions)

### 3. Mirror scrollback elimination + cache hardening

`scrollOnEraseInDisplay: false` prevented ED2-triggered scrollback pushes, but the mirror's headless terminal could still accumulate scrollback through normal scrolling (output overflow during startup, content between session restarts). The `@xterm/addon-serialize` default serializes ALL scrollback — so each browser reconnection received a snapshot bloated with accumulated content.

Fixes:
- Set `scrollback: 0` on `TerminalStateMirror` for agent sessions (prevents mirror accumulation at the source)
- Pass `scrollback: 0` to `serializeAddon.serialize()` (belt-and-suspenders — snapshots never include stale scrollback)
- Added `setScrollOnEraseInDisplay()` method on `PersistentTerminal` — applied on every `ensurePersistentTerminal` cache hit, not just at construction. Previously, if `useChatOutput` created the terminal first without passing the option, the cached instance kept the default `true` forever.
- Threaded `scrollOnEraseInDisplay` through `useChatOutput` → `ensurePersistentTerminal` so both hooks pass the same value

## Prior Band-Aid Fixes (still in place, no longer load-bearing)

| Commit | What it did | Still needed? |
|--------|------------|---------------|
| `c06983c0` | Resize dedup: `lastSentCols`/`lastSentRows` tracking, synchronous fit on mount | Superseded by epoch-based dedup. Dimension tracking kept as within-epoch dedup. |
| `044d3e1f` | Switched chat view from ANSI parsing to xterm buffer reads | Yes — correct approach regardless of scrollback behavior |
| `0f368f54` | `readBufferLines()` reads only viewport, not full scrollback | Still works, no longer load-bearing. With `false`, scrollback doesn't accumulate junk anyway. |

## Terminal Architecture Notes

### Key types to know

- **`PersistentTerminal`** (`web-ui/src/terminal/persistent-terminal-manager.ts`): Singleton per `(workspaceId, taskId)`. Cached in a module-level `Map`. Survives mount/unmount cycles via a parking root (off-screen hidden div). One `visibleContainer` at a time.
- **`TerminalStateMirror`** (`src/terminal/terminal-state-mirror.ts`): Server-side headless xterm that processes the same PTY output. Serializes via `@xterm/addon-serialize` for restore snapshots.
- **`usePersistentTerminalSession`** (`web-ui/src/terminal/use-persistent-terminal-session.ts`): React hook that mounts/unmounts a `PersistentTerminal` to a container div.
- **`useChatOutput`** (`web-ui/src/hooks/use-chat-output.ts`): Reads `readBufferLines()` every 100ms for the HTML chat view. Gets the same cached terminal instance — never creates its own.

### Terminal types (by task ID pattern)

| Type | Task ID | `scrollOnEraseInDisplay` |
|------|---------|--------------------------|
| Agent task | `card.id` (UUID) | `false` |
| Home sidebar agent | `__home_agent__:{workspaceId}:{agentId}` | `false` |
| Home shell | `__home_terminal__` | `true` |
| Detail shell | `__detail_terminal__:{cardId}` | `true` |

### Resize trigger paths (6)

1. **`mount()`** — `requestResize()` when visible
2. **ResizeObserver** — debounced 50ms on container
3. **DPR media query** — device pixel ratio change
4. **State transition** — session → running/awaiting_review
5. **IO socket open** — reconnection
6. **`applyRestore()`** — fresh connection after snapshot

### The `readBufferLines()` viewport-only design

`readBufferLines()` reads only `baseY` to `baseY + rows` (the viewport), not the full scrollback. This was originally to hide duplicates from the chat view. With `scrollOnEraseInDisplay: false`, the viewport is still the correct read target — TUI agents manage their own display within it. Scrollback would just be empty rather than full of junk.

## If the Problem Returns

1. **Check restore snapshots first.** The server mirror is the most likely source of stale duplicate content. Verify `scrollOnEraseInDisplay: false` AND `scrollback: 0` are being passed at the `new TerminalStateMirror()` call site for agent sessions.
2. **Check for new resize trigger paths.** If a new lifecycle event needs to send dimensions, it should call `invalidateResize()` (or `forceResize()`), not manually zero the tracking fields.
3. **Check cached terminals.** `ensurePersistentTerminal` now applies `scrollOnEraseInDisplay` on every call (not just creation). But any new `ensurePersistentTerminal` caller for agent terminals must pass `scrollOnEraseInDisplay: false` explicitly — the default is `true`.
4. **Check the IO/restore ordering.** The server gates live output delivery until the browser acknowledges `restore_complete`. If a new code path bypasses this gate, the browser could receive overlapping snapshot + live data. The browser-side IO handler deliberately does NOT gate on `restoreCompleted` — see the comment in `connectIo()`.
5. **Full pipeline audit completed.** Alt screen handling, output filtering, session reconciliation, multiple viewers, home sidebar agents, and auto-restart mirror lifecycle were all verified clean. If duplication returns, it's likely a new code path rather than a missed existing one.
