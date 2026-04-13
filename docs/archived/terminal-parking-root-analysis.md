> **ARCHIVED** — Superseded by `docs/terminal-unfocused-task-strategy.md`

# Terminal Parking Root Analysis

**Date**: 2026-04-13
**Context**: Architectural investigation into the parking root pattern — keeping all terminal instances alive in the DOM — and whether dispose/recreate from server mirror snapshots would be better.

## Current design

Every `PersistentTerminal` is created once and never destroyed. When a task is not being viewed, its terminal's host element is moved to a hidden "parking root" div (`position: fixed; left: -10000px; opacity: 0`). The xterm.js instance, WebGL context, canvas, buffer state, and both WebSocket connections all persist.

This means the number of live terminals grows monotonically with the number of tasks opened during a session. Nothing is ever reclaimed.

**Files**: `web-ui/src/terminal/persistent-terminal-manager.ts` (parking root pattern, mount/unmount), `web-ui/src/terminal/terminal-registry.ts` (global Map of all terminals)

## Cost of keeping terminals alive

Each parked agent terminal maintains:

- **xterm.js instance** — buffer, parser, event system. Processes live bytes from the IO WebSocket even when hidden. The rendering is skipped (no visible container), but byte parsing and buffer updates are not free.
- **WebGL context** (or canvas 2D) — with a glyph texture atlas. Browsers cap concurrent WebGL contexts at ~8-16. Beyond that, older contexts are silently lost (`onContextLoss` handler exists but falls back to canvas 2D).
- **2 WebSocket connections** (IO + control) — browsers cap these per domain (~30-255 depending on browser).
- **DOM nodes** — canvas elements exist in the parking root, just offscreen.

For 5 tasks this is fine. For 20+ concurrent tasks, WebGL context limits and WebSocket limits become real. The WebGL limit is the most visible — terminals lose their context and render blank or fall back to canvas 2D.

The CPU cost matters too. With 10 agents running simultaneously, all 10 write live bytes through the IO WebSocket into parked xterm.js instances that parse and buffer them — for terminals nobody is looking at. This is purely redundant with the server mirror, which processes the same bytes.

## Cost of dispose/recreate

Terminal creation involves:

1. **Synchronous (sub-ms)**: Create div, `new Terminal({...})`, load 4 addons, attach event handlers
2. **`terminal.open()`** (~5-20ms): Creates canvas, measures character dimensions, builds initial render
3. **WebGL context** (~5-10ms): GPU resource allocation, texture atlas creation
4. **Font readiness**: First terminal pays the font load cost; subsequent terminals get it free
5. **WebSocket connections** (~1-2ms each on localhost): Two TCP handshakes + HTTP upgrade
6. **Restore protocol**: Server serializes snapshot from mirror, client writes it — adds one round trip

**Total: ~30-50ms for a new terminal.** Imperceptible on a task switch. The restore snapshot for agent terminals is ~100 lines (scrollback was reduced to 100 on this branch), so serialization and transfer are fast.

## Why dispose/recreate is better for agent terminals

The tradeoff is backwards in the current design:

| | Parking root (current) | Dispose/recreate |
|---|---|---|
| Task switch cost | 0ms (DOM move + canvas repair) | ~30-50ms (imperceptible) |
| Ongoing cost per terminal | CPU (byte parsing), memory, WebGL context, 2 WebSockets | 0 (only active terminal exists) |
| Scaling | Grows with task count, never shrinks | Constant — one terminal at a time |
| WebGL context pressure | Hits browser limit at 8-16 terminals | Always 1 context |
| Restore dependency | Avoids restore (motivation for the pattern) | Depends on restore (now reliable) |

The parking root optimizes for a one-time cost (~30-50ms) that's already small, in exchange for an ongoing cost that scales with task count and never reclaims resources.

## Client-side monitoring is not a blocker

The only client-side output monitoring is `waitForLikelyPrompt` — regex matching against terminal output to detect shell prompts. This is:
- Used exclusively by the **shortcut system** (`useShortcutActions`)
- Only active during the few seconds a shortcut is executing
- Only for **shell terminals** (`__home_terminal__`, `__detail_terminal__`), not agent terminals
- Only triggered when a subscriber explicitly registers an `onOutputText` callback

Agent terminals have **zero** client-side monitoring. There is no functional dependency on keeping parked agent terminals alive. The buffer state they maintain is purely redundant with the server mirror.

## Why it was built this way

The parking root pattern came from the upstream kanban project and solves a real problem straightforwardly: keeping terminal state across React re-renders and task switches. "Never destroy anything" is the simplest implementation — no restore timing, no snapshot correctness concerns, no recreation logic.

The problems only emerge at scale (many tasks) or over time (long sessions). Early versions didn't have enough concurrent agents to notice. By the time terminal bugs started accumulating, the parking root was load-bearing — the restore path was fragile, so keeping everything alive was also a defense against restore bugs.

Now that the restore path is more solid (epoch fix, scrollback reduction, canvas repair extracted), the original justification is weaker.

## What `terminal.reset()` is for — and why it goes away

The current restore flow calls `terminal.reset()` before writing the snapshot to clear stale buffer content. This causes a visible flash. It only exists because the design **reuses** the same terminal instance.

With dispose/recreate, the new terminal starts empty. There's nothing to reset, no flash, no stale state. The snapshot writes into a clean terminal.

## Restore path reliability — honest assessment

The analysis above assumes the restore path is reliable. As of this branch, it's improved but **untested in production**. The fixes (epoch bug, canvas repair, scrollback reduction) are code changes that haven't been merged or validated under real usage.

Known remaining fragility in the restore path:
- **Snapshot mid-redraw**: If the mirror serializes while Claude is mid-TUI-redraw, the snapshot contains a partial frame. Inherent to serializing a live terminal — no fix.
- **Canvas repair after restore**: The 3-step repair (`repairRendererCanvas`) was just extracted in this session. It works in the mount path but hasn't been specifically tested in the restore-into-new-terminal path.
- **Restore protocol timing**: Between `restore` and `restore_complete`, live output is buffered server-side. The flush after `restore_complete` is correct in theory but the timing windows haven't been stress-tested.
- **Dimension mismatch**: The epoch fix prevents silently dropped resizes, but the interaction between restore dimensions and the client container's actual size on a freshly created terminal hasn't been validated.

Until these are proven, the parking root is the safer choice for the common case (task switch) because it avoids the restore path entirely. The recommendation below is the direction to move toward, not something to ship immediately.

## Recommendation

**Direction**: Move toward dispose/recreate for agent terminals, keep parking root for shell terminals.

For **agent terminals**: dispose on unmount, recreate from server mirror on next view. The server mirror exists precisely for this — providing restore snapshots for clients that don't have the bytes. Agent terminals have no client-side monitoring dependencies. The 30-50ms creation cost is invisible compared to the time Claude's TUI takes to redraw.

For **shell terminals**: keep the parking root pattern. Shell terminals have the prompt detection heuristic (`waitForLikelyPrompt`) used by the shortcut system, and users expect shell scrollback history to persist across task switches. The cost is bounded (at most 2-3 shell terminals per workspace).

A middle ground is an LRU cap — keep the N most recently viewed agent terminals alive (e.g. 4), dispose the rest. This bounds WebGL context usage well under browser limits while avoiding recreation cost for quick back-and-forth switching between a few tasks.

**Prerequisites before switching**: Validate the restore path under real usage — merge this branch, use it for a few days, confirm the epoch fix and canvas repair hold up. The parking root should remain the default until restore is proven reliable.

## Hybrid DOM strategy — visibility toggle with one-time DOM move

### The idea

Instead of moving the host element between the parking root and visible container on every task switch (current design), minimize DOM moves to a single one-time event per terminal, then use CSS visibility toggling for all subsequent show/hide cycles.

### Current flow (every task switch)

1. **Unmount**: Move host element from visible container → parking root
2. **Mount**: Move host element from parking root → visible container
3. Each mount triggers canvas repair (dimension bounce + clearTextureAtlas + refresh + forceResize) because DOM re-parenting stales the WebGL glyph texture cache and canvas pixel dimensions
4. Canvas repair requires the cols-1 dimension bounce hack because xterm.js `fitAddon.fit()` short-circuits when cols/rows haven't changed

### Proposed flow

**First view of a terminal (unavoidable DOM move):**
1. Terminal is created in the parking root (needed because the React container doesn't exist yet at construction time)
2. On first mount, `appendChild` moves the host element into the visible container
3. Canvas repair runs once
4. This is identical to the current flow — no change

**Every subsequent show/hide (visibility toggle, no DOM move):**
1. **Unmount**: Set `hostElement.style.visibility = "hidden"` — element stays in the container
2. **Mount**: Set `hostElement.style.visibility = "visible"`
3. No DOM move → no stale textures → no canvas repair needed → no cols-1 hack → no forceResize
4. Just `refresh(0, rows-1)` to repaint, and `requestResize()` to ensure dimensions are current

### Why this works

- `visibility: hidden` keeps the element in the DOM layout. The canvas stays at the same DOM position with valid pixel dimensions.
- xterm.js explicitly handles zero-dimension measurements (from `display: none`) by retaining previous values — `visibility: hidden` is even safer because it preserves layout entirely.
- The WebGL renderer's glyph texture atlas remains valid because the canvas was never moved. No `clearTextureAtlas()` needed, no dimension bounce needed.
- The ResizeObserver can stay attached (container dimensions don't change when visibility toggles).

### Container management

Multiple terminals in the same container need `position: absolute` with `inset: 0` so they stack. Only one has `visibility: visible` at a time. On first mount, each terminal's host element gets appended to the container. On subsequent mounts, just visibility flip.

The terminal class tracks whether it has been mounted to this specific container before:
- `this.mountedContainer` — the container it was appended to (null if still in parking root)
- On mount: if `this.mountedContainer === container`, just flip visibility. If different container (or null), do the DOM move + canvas repair.
- On unmount: flip to `visibility: hidden`. Do NOT move to parking root.

### IO socket management (separate optimization)

Independently of the visibility toggle, closing the IO socket for unfocused terminals prevents:
- Client-side byte processing for terminals nobody is looking at
- Backpressure from offscreen terminals throttling agents (the current design actively slows down agents because parked terminals process bytes slowly, hit the 100KB unacked threshold, and trigger `pty.pause()`)
- Wasted CPU on xterm.js parsing for hidden terminals

Flow:
- **Unmount**: Close IO socket. Control socket stays open (state badges, exit events still work).
- **Mount**: Open IO socket. Request restore via control socket to catch up on missed output. Server sends snapshot, client writes it, sends `restore_complete`, server flushes any pending output.
- Agent runs at full speed while unfocused — server mirror absorbs all output.

### What the user sees on task switch

1. Terminal flips to `visibility: visible` — shows the **stale** content from when they last viewed it (instant, no flash)
2. Restore snapshot arrives from server — terminal resets and writes current state (snap from stale to current)
3. Live output starts flowing

The stale → current snap is the only visual artifact. It's arguably better than the current situation where canvas repair can produce blurry text or wrong dimensions.

### Rapid task switching

If the user switches away before restore completes:
- IO socket gets closed, viewer state cleaned up by `cleanupViewerStateIfUnused` on the server
- No orphaned state — the server already handles this for the reconnect case

### What this eliminates

- Canvas repair on 90%+ of task switches (all except first view)
- The cols-1 dimension bounce hack on task switch
- The deferred RAF for canvas repair timing
- Agent throttling from offscreen backpressure
- CPU cost of xterm.js byte processing for hidden terminals

### What this keeps

- Parking root — still needed for initial construction before first mount
- Canvas repair — still needed for first mount, DPR changes, and the "Reset terminal rendering" button
- Server mirror — still needed for restore snapshots on IO socket reopen
- WebGL contexts — still held by hidden terminals (still counts toward browser limit). Solving this requires dispose/recreate, which is a separate step.

### Open question: scrollback behavior

During the investigation we discovered that `scrollOnEraseInDisplay: false` with `scrollback: 100` prevents mouse-wheel scrolling through conversation history in agent terminals. In a normal terminal emulator (e.g. Ghostty), users can mouse-wheel scroll through the full Claude Code conversation because `scrollOnEraseInDisplay` is true and scrollback is large.

The tradeoff: `scrollOnEraseInDisplay: true` enables scrollable conversation history but produces duplicate TUI frames in scrollback (each Claude redraw pushes a full copy of the current screen). Proper deduplication would require intercepting the byte stream and detecting repeated ED2 frames — complex and fragile.

Current recommendation: revert to `scrollOnEraseInDisplay: true` with default scrollback (10,000). Accept the duplication for now. The scrollback content is only visible to the user (via mouse-wheel scroll) and doesn't affect the restore snapshot size or agent performance. Deduplication can be investigated separately.

### Prerequisites

- Validate the restore path is reliable under real usage (epoch fix, canvas repair are on this branch but untested in production)
- The visibility toggle and IO socket changes are independent — can be shipped separately

## Related docs

- `docs/terminal-architecture.md` — full system reference
- `docs/terminal-architecture-explained.md` — plain-English walkthrough
- `docs/terminal-dimension-mismatch-investigation.md` — resize epoch bug and fix
- `docs/terminal-scrollback-investigation.md` — scrollback duplication root causes
