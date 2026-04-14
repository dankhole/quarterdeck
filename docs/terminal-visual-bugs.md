# Terminal Visual Bugs and Rendering

**Date**: 2026-04-13
**Status**: Off-by-1 root cause identified and fixed on branch, merged fixes for canvas repair and resize dedup

## The off-by-1 TUI rendering bug

### Symptoms

- Claude Code's status bar appears one row too high
- Input prompt is shifted
- Enter scrolls part of the status bar up
- Cursor in bottom-left corner after task switch (Claude didn't redraw)
- Almost always slightly off after task switch
- Manual window resize fixes it

### Root cause

The kernel only sends SIGWINCH to the agent when PTY dimensions actually change. On task switch, the client sends a resize with the current container size — which is often identical to the PTY's existing dimensions. No SIGWINCH, no redraw, Claude's TUI stays rendered for whatever dimensions it last drew at.

Verified empirically: `pty.resize(80, 24)` on a PTY already at 80x24 does NOT produce SIGWINCH. Only a different size triggers it.

### Fix (on branch `fix/terminal-reset-button-and-debug-logging`, commit `85193933`)

Added a `force` flag to the resize control message protocol. The client sets `force: true` only from `forceResize()` — called on task switch and state transitions. The server checks `force && dimensionsUnchanged` and sends SIGWINCH directly to the agent process via `process.kill(pid, 'SIGWINCH')`.

Normal ResizeObserver resizes don't set the flag, so no spurious SIGWINCHs.

Files changed:
- `src/core/api/streams.ts` — optional `force` field on resize schema
- `src/terminal/pty-session.ts` — `sendSignal()` method for delivering signals directly
- `src/terminal/session-manager.ts` — sends SIGWINCH when force is true and dimensions unchanged
- `src/terminal/terminal-session-service.ts` — `force` parameter on interface
- `src/terminal/ws-server.ts` — passes `message.force` through
- `web-ui/src/terminal/persistent-terminal-manager.ts` — `forceResize()` passes `force: true`, dedup check skipped when force is set

## Canvas repair (stale textures after DOM move)

### Problem

xterm.js caches rendered glyphs in a texture atlas (WebGL and canvas 2D). When the canvas is moved in the DOM (the parking root pattern moves it on every task switch), the cached textures and canvas pixel dimensions go stale. xterm.js has no "the canvas moved" event.

### The 3-step repair

Extracted into `repairRendererCanvas()` in `persistent-terminal-manager.ts`:

1. **Dimension bounce** — `resize(cols-1, rows)` forces `fitAddon.fit()` to call `terminal.resize()` instead of short-circuiting (xterm.js optimization skips resize when cols/rows haven't changed). This recalculates canvas pixel dimensions.
2. **`clearTextureAtlas()`** — discards cached glyph textures so the renderer rebuilds them at the current DPR. `_refreshCharAtlas()` inside xterm.js's `handleResize` won't help because `acquireTextureAtlas()` returns the same cached atlas when parameters haven't changed.
3. **`refresh(0, rows-1)`** — repaints every visible row using rebuilt textures.

All three steps must run together. Skipping any one produces a silent no-op.

### The cols-1 hack

This is a workaround for **xterm.js**, not our code. `fitAddon.fit()` (from `@xterm/addon-fit`) compares calculated cols/rows against current and returns early if they match. After a DOM move to a same-sized container, the logical dimensions haven't changed but the physical canvas needs recalculation. The dimension bounce is the only way to force `handleResize` to run.

This goes away entirely with the visibility toggle approach (no DOM move = no stale textures) or dispose/recreate (fresh terminal = no stale state).

### When canvas repair runs

- `mount()` — synchronous, immediately after DOM re-parent on task switch
- `resetRenderer()` — user-initiated "Reset terminal rendering" button
- `listenForDprChange()` handler — on monitor switch / zoom (DPR change)

## Resize epoch dedup fix

### Problem

`requestResize()` used to update dedup state (`lastSentCols`, `lastSentRows`, `lastSatisfiedResizeEpoch`) before attempting to send the resize message. `sendControlMessage()` silently returned if the socket wasn't open. The system believed it sent the resize but didn't. Future calls with the same dimensions were deduped, leaving the PTY at stale dimensions.

### Fix (on main, commit `b7b0f459`)

`sendControlMessage()` returns `boolean`. Dedup state only updates when the message actually reaches the socket. If the socket isn't open, state stays stale so the next call retries.

## WebGL vs canvas 2D text quality

WebGL renderer rasterizes glyphs into a texture atlas on an opaque canvas, producing heavier strokes than the browser's native subpixel antialiasing (Core Text on macOS). No amount of font weight tuning closes this gap — the rendering pipelines are fundamentally different.

A toggle exists in settings (`terminalWebGLRenderer`). Canvas 2D uses `fillText()` which may produce crisper text. Needs A/B comparison by the user.

## DPR change handling (fixed)

`listenForDprChange()` creates a `matchMedia` query for the current DPR. When it fires (monitor switch), it now calls `repairRendererCanvas("dprChange")` which clears the stale glyph textures and repaints at the new DPR, in addition to sending updated dimensions.

## Buffer restoration on task switch

### Problem

While a terminal is parked (not visible), the agent continues writing output — status bar redraws, tool results, cursor movements. The xterm.js buffer processes all of this correctly at the parked dimensions. On task switch, the canvas repair fixes rendering (textures, pixel dimensions) and sends a force SIGWINCH. But when the terminal dimensions haven't changed, TUI agents (Claude Code) treat the SIGWINCH as a lightweight refresh rather than a full redraw — they query `TIOCGWINSZ`, see the same size, and skip the expensive tear-down/rebuild. Accumulated artifacts (stale status bar rows, off-by-one cursor positioning) persist.

Manual resize works because the actual dimension change triggers the agent's full TUI redraw path. Re-sync works because it atomically replaces the buffer from the server's headless mirror.

### Fix

`mount()` now calls `requestRestore()` when the container changes. This requests a fresh buffer snapshot from the server, which pauses live output, serializes the headless mirror state, and sends it to the client. The client resets the terminal and writes the snapshot, producing a clean buffer that matches the server's authoritative state. No agent cooperation is needed — the buffer is replaced entirely on the client side.

## Files

| File | Role |
|------|------|
| `web-ui/src/terminal/persistent-terminal-manager.ts` | Canvas repair, resize epoch, DPR handling, forceResize |
| `src/terminal/pty-session.ts` | `sendSignal()` for direct SIGWINCH |
| `src/terminal/session-manager.ts` | Resize handling, force SIGWINCH logic |
| `src/core/api/streams.ts` | Resize message schema with `force` field |
| `web-ui/src/terminal/terminal-options.ts` | Terminal configuration defaults |
