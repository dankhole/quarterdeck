# Terminal Unfocused Task Strategy

**Date**: 2026-04-13
**Status**: Design documented, not yet implemented

## Problem

The current parking root pattern keeps every agent terminal alive indefinitely. Each parked terminal maintains an xterm.js instance, a WebGL context, 2 WebSocket connections, and processes live bytes — all for terminals nobody is looking at. This has two costs:

1. **Resource scaling**: WebGL contexts cap at 8-16 per browser. WebSocket connections cap at 30-255. CPU spent parsing bytes into buffers nobody reads. All grow with task count, never shrink.

2. **Agent throttling**: Parked terminals process bytes slowly (browser deprioritizes offscreen work). The backpressure system tracks unacknowledged bytes — when a parked terminal hits 100KB unacked, `pty.pause()` fires and stops the kernel from reading the PTY master. The agent's stdout writes start blocking. **The current design actively slows down agents the user isn't watching.**

## Proposed design: visibility toggle + IO socket management

Two independent optimizations that can be shipped separately.

### Part 1: Visibility toggle (eliminates canvas repair on task switch)

**Current flow (every task switch):**
1. Unmount: move host element from visible container to parking root
2. Mount: move host element from parking root to visible container
3. DOM re-parent stales WebGL glyph texture cache
4. Canvas repair runs: dimension bounce (cols-1 hack) + clearTextureAtlas + refresh + forceResize

**Proposed flow:**
- **First view of a terminal**: DOM move from parking root into container (unavoidable — React container doesn't exist at terminal construction time). Canvas repair runs once.
- **Every subsequent hide/show**: Toggle `visibility: hidden` / `visibility: visible`. No DOM move, no stale textures, no canvas repair.

**Why this works:**
- `visibility: hidden` keeps the element in DOM layout with valid dimensions
- xterm.js explicitly handles zero-dimension measurements by retaining previous values — visibility toggle is even safer than `display: none`
- WebGL texture atlas stays valid because the canvas never moved
- Verified in xterm.js source: `CharSizeService.ts` line 63-69 retains measurements when element dimensions are zero

**Container management:**
- Multiple terminals stack in the same container with `position: absolute; inset: 0`
- Terminal tracks `this.mountedContainer` — if same container, just flip visibility; if different, do DOM move + canvas repair
- On unmount: flip to hidden, do NOT move to parking root

**What this eliminates:**
- Canvas repair on 90%+ of task switches
- The cols-1 dimension bounce hack on task switch
- The deferred RAF for canvas repair timing

**What this keeps:**
- Parking root for initial construction
- Canvas repair for first mount, DPR changes, and "Reset terminal rendering" button
- WebGL contexts (still counts toward browser limit)

### Part 2: IO socket management (eliminates agent throttling and wasted CPU)

**Current behavior:**
- Both IO and control WebSocket connections stay open for all parked terminals
- Parked terminals receive live bytes, parse them through xterm.js, buffer them
- Browser deprioritizes this work → ack delays → backpressure → `pty.pause()` → agent slowed down

**Proposed behavior:**
- **Unmount**: Close the IO socket. Control socket stays open (state badges and exit events still work).
- **Mount**: Open IO socket. Request restore via control socket to catch up on missed output.
- Agent runs at full speed while unfocused — server mirror absorbs all output, no backpressure possible because there's no viewer to fall behind.

**Restore on refocus:**
1. Terminal flips to `visibility: visible` — shows stale content from last view (instant)
2. IO socket opens, restore requested via control socket
3. Server sends snapshot from mirror → client writes it → sends `restore_complete`
4. Server flushes any pending output → live output flows
5. Terminal now shows current state

The stale-to-current snap is the only visual artifact. With agent scrollback being small (conversation flows through normal buffer, not alternate screen), the snapshot is fast.

**Rapid task switching:**
- If user switches away before restore completes, IO socket closes and server cleans up via `cleanupViewerStateIfUnused` — no orphaned state
- No pending output chunks accumulate because there was no IO socket listener during the unfocused period

**What this eliminates:**
- Agent throttling from offscreen backpressure
- CPU cost of xterm.js byte processing for hidden terminals
- Wasted WebSocket bandwidth for terminals nobody is watching

**What this keeps:**
- Control socket (state badges, exit events)
- Server mirror (processes all output, provides restore snapshots)

### Future optimization: hover prefetch

On mouseenter of a task card, preemptively call `ensurePersistentTerminal()` (or a lighter variant that just opens sockets and requests a restore). By the time the user clicks, the terminal is constructed, fonts ready, WebGL context acquired, and restore snapshot received. The IO socket opens on actual mount. Task switch feels instant.

Not for the initial implementation — add after the core visibility toggle and IO socket changes are proven.

## What this does NOT solve

- **WebGL context limits**: Hidden terminals still hold their WebGL context. Solving this requires dispose/recreate (destroy the terminal entirely on unmount, recreate from server mirror on next view). That's a separate step that depends on the restore path being reliable.
- **Scrollback deduplication**: See `terminal-scrollback-and-history.md`. The IO socket changes don't affect how scrollback accumulates.

## Prerequisites

1. The `force` SIGWINCH fix (commit `85193933`) should be on main — it ensures Claude redraws after task switch even when dimensions match
2. The restore path should be validated under real usage (epoch fix, canvas repair are merged but production validation is needed)
3. Part 1 (visibility toggle) and Part 2 (IO socket) are independent and can ship separately

## Implementation scope

**Part 1 (visibility toggle)** — changes in `persistent-terminal-manager.ts` only:
- Add `mountedContainer` tracking
- Change `mount()`: if same container, flip visibility instead of DOM move
- Change `unmount()`: flip to hidden instead of parking
- Remove canvas repair from the "same container" path
- CSS for absolute positioning of stacked terminals

**Part 2 (IO socket management)** — changes in `persistent-terminal-manager.ts`:
- `unmount()`: close IO socket
- `mount()`: open IO socket, request restore
- Remove error handling for IO socket close (it's intentional now, not an error)
- The `connectIo()` / IO socket close handlers already exist and work correctly

**Server side**: No changes needed. The IO socket open/close, restore protocol, and viewer state cleanup all work correctly today.

## Related docs

- `docs/terminal-visual-bugs.md` — rendering artifacts and the SIGWINCH fix
- `docs/terminal-scrollback-and-history.md` — scrollback duplication and dedup approaches
- `docs/terminal-architecture.md` — full system reference
