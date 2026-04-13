# Terminal Scrollback and History

**Date**: 2026-04-13
**Status**: Partially understood — key question about Claude's output model needs verification

## Goal

The user must be able to mouse-wheel scroll through a clean, single copy of the full agent conversation history. No duplicates, no missing history, no broken scrolling.

## How Claude Code actually outputs conversation

**This needs verification by capturing a real byte stream, but based on observed behavior in Ghostty:**

Claude Code appears to write conversation content as **normal stdout to the normal buffer**, not exclusively through the alternate screen TUI. The observed behavior when resuming a conversation in Ghostty:

1. **Resume**: Claude writes the full conversation history as plain text (normal buffer)
2. **During conversation**: Claude writes responses as they stream (appears to be normal buffer output)
3. **TUI chrome**: Status bar, input prompt, tool use indicators use the alternate screen buffer
4. **Exit**: Normal exit — conversation history is just there in terminal scrollback, clean and scrollable

If this is correct, it means:
- The actual conversation flows through as normal terminal output that accumulates in scrollback naturally
- The alternate screen / ED2 redraws are only for TUI chrome, not conversation content
- `scrollOnEraseInDisplay: false` is actually correct — the ED2 redraws are TUI chrome we don't want in scrollback
- The duplication we were seeing was TUI chrome being pushed into scrollback, interleaved with actual conversation

**This model needs to be verified** by capturing the actual byte stream from a Claude session and identifying what goes through the alternate screen vs normal buffer.

## Two duplication mechanisms

### Mechanism A: ED2 duplication (fixed)

Claude Code's TUI redraws constantly. Each redraw sends ED2 (`\e[2J`) to clear the screen. With `scrollOnEraseInDisplay: true` (the old default), xterm.js pushed the current viewport into scrollback before erasing. Hundreds of redraws produced thousands of duplicate viewport frames in scrollback.

**Fix**: `scrollOnEraseInDisplay: false` for agent terminals. ED2 clears in-place without touching scrollback. This is on main.

### Mechanism B: Alternate screen transitions (open)

When Claude exits and re-enters the alternate screen (`\e[?1049l` / `\e[?1049h`) — which can happen on resize, state transitions — content leaks into the normal buffer's scrollback:

1. Resize fires, agent gets SIGWINCH
2. Agent exits alternate screen — normal buffer becomes active
3. Agent dumps TUI redraw to normal buffer (plain output, not ED2)
4. Output overflows viewport into scrollback
5. Agent re-enters alternate screen

`scrollOnEraseInDisplay: false` doesn't help here — this is plain output overflow on the normal buffer.

## Current state on main

- `scrollOnEraseInDisplay: true` with scrollback 10,000 (reverted from the `false` + 100 experiment because it killed mouse-wheel scrolling)
- ED2 duplication is active again (the revert re-enabled it)
- Alternate screen transition duplication remains open

The revert happened because the `false` + 100 combination prevented all mouse-wheel scrolling — users couldn't scroll through conversation history at all.

## Deduplication approaches explored

### Approach 1: Row-by-row erase (bypasses scrollOnEraseInDisplay)

xterm.js's `scrollOnEraseInDisplay` only triggers on ED2 (`\e[2J`). The per-line erase EL2 (`\e[2K`) does not push to scrollback.

The protocol filter could intercept ED2 + cursor home in the byte stream and replace it with cursor home + row-by-row erase:

```
\e[H          (cursor home)
\e[2K          (erase line 1)
\e[2H\e[2K     (move to line 2, erase)
...for all rows
```

Cost: ~240 bytes instead of 4 bytes for a 40-row terminal. Trivial.

This eliminates ED2 duplication while keeping `scrollOnEraseInDisplay: true` for any non-ED2 scrollback accumulation. But it doesn't address mechanism B.

### Approach 2: Clear scrollback before each frame

Send `\e[3J` (ED3 — clear scrollback) before forwarding the frame. Combined with row-by-row erase instead of ED2, this ensures only the latest frame's content is in scrollback.

**Problem**: If Claude only writes the visible viewport (40 lines) per frame, clearing scrollback destroys all history beyond the viewport. Only viable if Claude writes the full conversation per frame, which appears NOT to be the case based on how TUIs work.

### Approach 3: Content-aware deduplication

Compare the new frame's content against what was last pushed to scrollback. If substantially the same, suppress the ED2 (so it doesn't push). If genuinely new content, allow the push.

Complex, requires string comparison on every redraw, and fragile if the comparison threshold is wrong.

### Approach 4: Understand Claude's actual output model first

Before implementing any deduplication, verify how Claude Code actually outputs conversation content vs TUI chrome. If the conversation is normal stdout (as Ghostty behavior suggests), then `scrollOnEraseInDisplay: false` is the right setting and the only duplication is from mechanism B (alternate screen transitions), which is a much narrower problem.

**This is the recommended next step.**

## xterm.js buffer mechanics

- **Normal buffer**: `scrollback` option controls max lines (default 10,000). Lines that overflow the viewport go to scrollback. ED2 with `scrollOnEraseInDisplay: true` also pushes viewport to scrollback before erasing.
- **Alternate buffer**: Hard-capped to viewport size, no scrollback possible (per xterm spec).
- **`scrollback: 0` breaks scroll interaction**: Mouse wheel events aren't consumed by xterm and bubble to other UI. Terminal becomes unscrollable. Minimum 100 lines required to avoid an xterm.js 6.x circular buffer crash.
- **EL2 (`\e[2K`)**: Erase-in-line does NOT trigger `scrollOnEraseInDisplay`. Only ED2 does.
- **ED3 (`\e[3J`)**: Clears the entire scrollback buffer.

## Files

| File | Role |
|------|------|
| `src/terminal/terminal-state-mirror.ts` | Server-side headless xterm — scrollback and scrollOnEraseInDisplay configured here |
| `src/terminal/terminal-protocol-filter.ts` | Byte stream interceptor — where ED2 replacement would be implemented |
| `web-ui/src/terminal/persistent-terminal-manager.ts` | Client terminal — scrollback and scrollOnEraseInDisplay configured via terminal-options.ts |
| `web-ui/src/terminal/terminal-options.ts` | Client terminal defaults (scrollback: 10,000) |
| `web-ui/src/components/card-detail-view.tsx` | Where scrollOnEraseInDisplay and scrollback are passed to agent terminals |
