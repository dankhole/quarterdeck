# Terminal Scrollback Investigation

**Date**: 2026-04-11 → 2026-04-12
**Status**: Partially fixed — ED2 duplication resolved, alternate screen transition duplication remains

## #1 Hard Behavioral Constraint

The user must be able to scroll up through **one single copy** of the full agent conversation history. That's the only acceptable end state. Any fix must preserve this — no duplicates, no missing history, no broken scrolling. Specifically:

- Scrolling up shows one continuous conversation (prompts, responses, tool calls) in chronological order
- No duplicate copies of the conversation at any width
- Scroll works normally (mouse wheel / trackpad scrolls the terminal, not intercepted by other UI)
- History is not truncated or lost

Every proposed fix must be validated against this constraint.

## Root Causes (two distinct mechanisms)

### 1. ED2 duplication (FIXED — `scrollOnEraseInDisplay: false`)

Claude Code is a full-screen TUI that redraws constantly. Each redraw sends ED2 (erase-in-display) to clear the screen. With `scrollOnEraseInDisplay: true` (inherited from upstream kanban, commit `5b61cd99`), xterm.js pushed the viewport into scrollback instead of erasing. After hundreds of redraws, 10,000 lines of duplicate frames.

**Fix**: Set `scrollOnEraseInDisplay: false` for agent terminals on both browser and server. ED2 now clears in place without touching scrollback.

### 2. Alternate screen transition duplication (OPEN — the remaining problem)

Claude Code uses the alternate screen buffer (`\e[?1049h`). When it exits and re-enters alternate screen — which happens on **resize**, **state transitions**, and **TUI redraws** — content leaks into the primary buffer's scrollback:

1. Resize fires → agent gets SIGWINCH
2. Agent exits alternate screen (`\e[?1049l`) → primary buffer becomes active
3. Agent dumps full TUI redraw to primary buffer (normal output, NOT ED2)
4. Output overflows viewport → goes into primary buffer scrollback as duplicate frames
5. Agent re-enters alternate screen (`\e[?1049h`)

`scrollOnEraseInDisplay: false` does NOT help here — this is plain output overflow on the primary buffer, not ED2. This is the mechanism that still produces duplicate copies in the scrollback.

### Why scrollback behavior is intermittent at runtime

The user sees different behavior depending on which buffer is active:

- **Alternate screen active** (agent TUI running): No scrollback — alternate buffer is hard-capped to viewport size. Mouse wheel events may be forwarded to the TUI app instead of scrolling xterm. You can only scroll "a little" or not at all.
- **Primary buffer active** (between TUI redraws, after agent exit): Full scrollback visible — you can suddenly scroll through the whole conversation. But it includes duplicate frames from alternate screen transitions.
- **After resize**: Alternate screen toggle dumps TUI content to primary buffer, briefly making history visible but also adding dupes.

This is normal terminal behavior — not a bug in Quarterdeck. The intermittent appearance/disappearance of scrollback is the alternate screen buffer toggling.

## Current State of Fixes

### What's in place and working

| Fix | Commit | What it does |
|-----|--------|-------------|
| `scrollOnEraseInDisplay: false` (browser) | `2a6b9cc2` | Prevents ED2 from pushing viewport to scrollback |
| `scrollOnEraseInDisplay: false` (server mirror) | `2a6b9cc2` | Same fix on server-side headless terminal |
| Epoch-based resize dedup | `2a6b9cc2` | Prevents redundant resize messages |
| Minimum scrollback headroom | `be74a9c8` | Prevents xterm.js 6.x lineFeed crash if scrollback is ever set near 0 |

### What was removed: `scrollback: 0` on server mirror

`scrollback: 0` on the server mirror (commit `5bafce54`) was added as belt-and-suspenders after `scrollOnEraseInDisplay: false`. It killed ALL scrollback in restore snapshots, which meant:

- **Tab refresh** → browser gets viewport-only snapshot → all conversation history lost
- **WebSocket reconnection** → `applyRestore()` calls `terminal.reset()` (wipes browser scrollback) then writes server snapshot (viewport only) → history gone

With `scrollOnEraseInDisplay: false` still in place, the mirror only accumulates real conversation overflow — not duplicate TUI frames from ED2. Removing `scrollback: 0` restores history preservation in snapshots.

**Trade-off**: Alternate screen transition dupes will appear in restore snapshots too. This is acceptable — dupes with history is better than no dupes with no history.

### What was tried and reverted: browser-side `scrollback: 0`

Attempted on branch `fix/agent-terminal-scrollback-zero` (commit `24ed06cb`). Set `scrollback: 0` on the browser `PersistentTerminal` for agent sessions. **Completely broke scrolling** — mouse wheel events weren't consumed by xterm and bubbled to other UI elements. Reverted.

## Future Fix: Alternate Screen Transition Interception

The correct long-term fix is to intercept alternate screen transitions (`\e[?1049h` / `\e[?1049l`) and prevent TUI redraw output from landing in primary buffer scrollback. Approaches to explore:

1. **Buffer snapshot/restore around transitions**: When the agent exits alternate screen, snapshot the primary buffer state. When redraw completes and agent re-enters alternate screen, restore the snapshot. TUI output during the transition never persists in scrollback.

2. **Output filtering during transitions**: Detect the exit-alternate-screen sequence in the output stream and suppress output until the re-enter sequence arrives. Risk: if the agent doesn't re-enter, output is lost.

3. **Separate scrollback management**: Maintain a separate clean conversation log (parsed from structured agent output) and render it as the scroll history instead of relying on xterm's raw scrollback buffer.

None of these are trivial. For now, normal scrollback with dupes is the better trade-off over no scrollback at all.

## Terminal Architecture Notes

### Key types

- **`PersistentTerminal`** (`web-ui/src/terminal/persistent-terminal-manager.ts`): Singleton per `(workspaceId, taskId)`. Cached in module-level `Map`. Survives mount/unmount via parking root.
- **`TerminalStateMirror`** (`src/terminal/terminal-state-mirror.ts`): Server-side headless xterm. Processes same PTY output. Serializes via `@xterm/addon-serialize` for restore snapshots. Minimum scrollback of 100 enforced to prevent xterm.js 6.x circular-buffer crash.
- **`usePersistentTerminalSession`** (`web-ui/src/terminal/use-persistent-terminal-session.ts`): React hook that mounts/unmounts a `PersistentTerminal`.

### Terminal types

| Type | Task ID | `scrollOnEraseInDisplay` |
|------|---------|--------------------------|
| Agent task | `card.id` (UUID) | `false` |
| Home shell | `__home_terminal__` | `true` |
| Detail shell | `__detail_terminal__:{cardId}` | `true` |

### Restore flow (the history-wiping path)

1. Control WebSocket connects/reconnects
2. Server sends `restore` message with snapshot from `TerminalStateMirror`
3. Browser `applyRestore()` calls `terminal.reset()` — **wipes all browser scrollback**
4. Writes snapshot into terminal
5. Snapshot now includes scrollback (10,000 lines), so history survives restore

### xterm.js buffer mechanics

- **Primary buffer**: `scrollback` option controls max lines (default 10,000). Lines that overflow viewport go to scrollback. ED2 with `scrollOnEraseInDisplay: true` also pushes.
- **Alternate buffer**: Hard-capped to viewport size (`Buffer._hasScrollback = false`, `BufferSet.ts` line 42-44). No scrollback possible. Per xterm spec.
- **`scrollback` is runtime-changeable**: xterm.js listens for option changes and triggers buffer resize.
- **`scrollback: 0` breaks scroll interaction**: Mouse wheel events not consumed by xterm, bubble to other UI. Terminal unscrollable.

## Debugging

The debug log panel (Cmd+Shift+D) has a **Dump terminal state** button (monitor icon) that logs buffer state for all active terminals via the `[terminal]` tag. For each terminal it shows:

- Active buffer type (ALTERNATE vs NORMAL)
- Normal buffer length, baseY, scrollback line count
- Alternate buffer length
- `scrollback` option value
- `scrollOnEraseInDisplay` value
- Session state

### How to interpret

- **`buffer: ALTERNATE`** + can't scroll much → normal, TUI is active on alternate screen
- **`buffer: NORMAL`** + can scroll → TUI exited alternate screen, primary buffer visible
- **scrollback lines growing** → content accumulating (could be legit history or dupes from transitions)
- **`scrollback option: 0`** → scrollback disabled, mouse wheel won't work
- **`scrollOnEraseInDisplay: false`** → ED2 duplication prevented (correct for agent terminals)
