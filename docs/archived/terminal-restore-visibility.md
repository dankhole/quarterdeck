# Terminal Restore Visibility — Investigation Notes

> Context dump from the fix/terminal-restore-scroll-flash branch.
> `ensureVisible()` has been reverted to a bare visibility toggle (matches main). The next step is pre-mounting pool slots to eliminate DOM reparent entirely — see plan below.

## The original bug

Switching to a stale task (evicted pool slot) caused the entire chat history to visibly scroll past. The sequence was:

1. `acquireForTask()` → `connectToTask()` opens fresh WebSockets
2. `mount()` sets `visibility = "visible"` immediately
3. Server sends the full restore snapshot asynchronously
4. xterm renders the snapshot incrementally across animation frames — while visible
5. User sees the entire history scroll past before `scrollToBottom()` fires

## Fix applied (already on main)

`mount()` now checks `restoreCompleted` before revealing. When `false`, the host element stays hidden. The restore handler in `connectControl`'s `onmessage` reveals the terminal after `scrollToBottom()`.

Socket error/close handlers call `ensureVisible()` as a safety net so the terminal never stays permanently hidden if the restore message fails to arrive.

**Also on main:**
- Warmup timeout moved from mouseEnter to mouseLeave (slot stays warm while hovered)
- Sidebar cards now pass `onTerminalWarmup`/`onTerminalCancelWarmup` (was missing)

## The 6 refresh mechanisms (lightest → heaviest)

### 1. `terminal.refresh(0, rows - 1)` — Viewport repaint
Tells xterm "repaint every row." Re-composites existing buffer content using whatever glyph textures are already cached. No network, no server involvement.
- **Fixes**: rendering artifacts where buffer content is correct but screen wasn't redrawn
- **Doesn't fix**: blurry or corrupt glyphs (re-composites the same stale textures)

### 2. `terminal.clearTextureAtlas()` — Glyph cache wipe
Throws away cached glyph texture bitmaps. Next draw re-rasterizes at current DPR. Useless alone — needs a `refresh()` after to actually redraw.
- **Fixes**: blurry text from DPR change, corrupt glyph textures
- **Used**: only inside `repairRendererCanvas()`

### 3. `repairRendererCanvas(trigger)` — Full client-side repair
Steps (all synchronous, single event loop turn):
1. **Dimension bounce** — `resize(cols-1, rows)` locally. Forces xterm to recalculate canvas pixel dimensions. No network message.
2. **`clearTextureAtlas()`** — wipes glyph cache
3. **`refresh(0, rows-1)`** — repaints viewport with fresh textures
4. **`forceResize()`** → `fitAddon.fit()` (restores real dimensions from container) → sends resize message to server with `force: true` → server sends SIGWINCH to agent → agent redraws TUI → fresh output flows back through PTY → headless mirror → client

Used in:
- `mount()` slow path — after DOM reparent during task switch
- `dpr-change` handler — monitor move or browser zoom
- `resetRenderer()` — user clicks "Reset terminal rendering"

### 4. `resetRenderer()` — Destroy and recreate WebGL addon
Disposes the WebGL addon entirely, creates a new one, then runs `repairRendererCanvas()`. Nuclear option for the rendering pipeline.
- **Used**: "Reset terminal rendering" debug button

### 5. `requestRestore()` — Re-fetch server buffer
Sends `request_restore` to server. Server serializes headless mirror buffer via `SerializeAddon` and sends it back. Client resets its xterm buffer and writes the fresh snapshot. Purely a data fix — doesn't touch rendering.
- **Used**: not called in normal flow, available for manual repair

### 6. `reset()` — Wipe the client buffer
Calls `terminal.reset()` — clears entire xterm buffer. Used as a preparatory step before writing fresh content.
- **Used**: `applyRestore()` before writing snapshot, session restart detection

## Server-side architecture

### Headless mirror (`src/terminal/terminal-state-mirror.ts`)
- Uses `@xterm/headless` Terminal + `SerializeAddon`
- PTY output → `filterTerminalProtocolOutput()` → `applyOutput()` → `terminal.write()` with completion callback
- All operations serialized through an `operationQueue` Promise chain
- 3,000 line scrollback matching client
- Known xterm 6.x circular-buffer bug (lines 11-22) but only affects scrollback:0

### Restore snapshot generation (`getSnapshot()`)
- Awaits `operationQueue` drain (all pending writes complete)
- Returns `serializeAddon.serialize({ scrollback })` + cols/rows
- This is what the client receives in the `"restore"` control message

### Resize flow on server (`session-manager.ts`)
1. PTY.resize() — sends ioctl, kernel auto-sends SIGWINCH if dimensions changed
2. If `force: true` AND dimensions unchanged → explicit SIGWINCH sent
3. Headless mirror resized to match
4. Tracked dimensions updated

### SIGWINCH → Agent redraw
When SIGWINCH reaches a TUI agent (Claude Code):
- Agent catches signal, queries new terminal dimensions
- Performs full screen redraw
- Fresh output flows back through PTY → headless mirror (overwrites buffer) → streams to client as normal IO data

## Problems found and resolved

### ensureVisible was running full canvas repair (FIXED — reverted to main)
The branch previously added `repairRendererCanvas("restore-reveal")` inside `ensureVisible()`. This caused:
1. **Double repair** on cold task switch — mount repair + restore-reveal repair, but restore overwrites the buffer anyway
2. **Flash resize** — dimension bounce (cols-1) happened while visible
3. **Unnecessary SIGWINCH** — agent interrupted mid-think for a redundant TUI redraw
4. **Scroll position lost** — the dimension bounce after `scrollToBottom()` undid the scroll

`ensureVisible()` is now a bare visibility toggle (matches main). `repairRendererCanvas` only runs for DPR change and user-initiated reset.

### Resolved: DOM reparent eliminated via pre-mount architecture

The mount slow path problem (unnecessary `repairRendererCanvas("mount")` + SIGWINCH on cold task switch) has been resolved by eliminating DOM reparent entirely.

**What changed:**
- All 4 pool slots are pre-mounted in a shared container via `attachPoolContainer()` / `attachToStageContainer()`. No DOM reparent on task switch.
- `mount()` → `show()`: pure visibility toggle + `terminal.refresh()` + ResizeObserver setup. No `repairRendererCanvas` on show.
- `unmount()` → `hide()`: pure visibility toggle + ResizeObserver teardown. No container parameter.
- `visibleContainer` split: `stageContainer` (physical DOM parent, set by pool) + `visibleContainer` (set by show/hide, used for "is user looking at this?").
- `requestResize` guard loosened to allow resize when staged but not visible (warmup sends correct dims).
- `document.visibilitychange` listener added for tab-return refresh.
- Dedicated terminals call `attachToStageContainer` + `show`/`hide` directly.

## Pre-mount container lifecycle

- Pool calls `attachPoolContainer(container)` when the React terminal panel mounts. This calls `attachToStageContainer(container)` on all 4 pool slots, moving them from the parking root into the real container.
- Pool calls `detachPoolContainer()` when the React terminal panel unmounts. Slots remain in the (now detached) DOM — harmless. They'll be re-staged on the next `attachPoolContainer` call.
- All 4 pool slots live in the container permanently (visibility toggled per slot).
- Dedicated terminals manage their own containers independently via `attachToStageContainer` + `show`/`hide`.
- Rotation timer: new replacement slot gets `attachToStageContainer` if container exists.

---

## Cheat sheet — operation quick reference

| Operation | Owner | What it does | Network? | SIGWINCH? | Async? | When to use |
|-----------|-------|-------------|----------|-----------|--------|-------------|
| `terminal.refresh(0, rows-1)` | xterm.js | Repaints every visible row from the existing buffer using cached glyph textures. Pure compositor pass. | No | No | No | Rendering artifacts where buffer content is correct but screen wasn't redrawn. Won't fix blurry text (same stale textures). |
| `terminal.clearTextureAtlas()` | xterm.js | Throws away cached glyph texture bitmaps. Next draw re-rasterizes at current DPR. Useless alone — needs a `refresh()` after to actually redraw. | No | No | No | Only inside `repairRendererCanvas()`. Fixes blurry text from DPR change or corrupt glyph textures. |
| `terminal.reset()` | xterm.js | Wipes the entire xterm buffer (normal + alternate), resets cursor, clears scrollback. Destructive. | No | No | No | Before writing a fresh restore snapshot (`applyRestore`), or on session restart detection to clear stale output. |
| `terminal.resize(cols, rows)` | xterm.js | Changes the local xterm grid dimensions. Recalculates canvas pixel sizes, reflows wrapped lines. Does NOT send anything to the server. | No | No | No | After restore when server snapshot has different dimensions. Also used for the dimension bounce trick in `repairRendererCanvas`. |
| `terminal.scrollToBottom()` | xterm.js | Scrolls the viewport to the bottom of the buffer. | No | No | No | After restore snapshot is written, before revealing the terminal. |
| `fitAddon.fit()` | @xterm/addon-fit | Measures the host container via `getBoundingClientRect()`, calculates cols/rows from pixel dimensions and cell size, calls `terminal.resize()` if dimensions changed. Short-circuits if cols/rows haven't changed. | No | No | No (sync reflow) | After staging, container resize, or any time the container size may have changed. |
| `requestResize(force?)` | ours (TerminalSlot) | Calls `fitAddon.fit()`, then sends a `resize` message to the server with current cols/rows/pixelWidth/pixelHeight. Deduplicates via epoch + last-sent tracking. If `force: true`, server sends SIGWINCH even if dimensions match. Guard uses `visibleContainer ?? stageContainer` so warmup can send dims while hidden. | **Yes** — resize msg | Only if `force` + unchanged dims | No | After any event where the server may not know our dimensions (container resize, socket reconnect, restore complete). |
| `forceResize()` | ours (TerminalSlot) | Bumps the resize epoch (invalidates dedup) then calls `requestResize(true)`. Guarantees the resize message reaches the server and triggers SIGWINCH. | **Yes** — resize msg | **Yes** (always) | No | After canvas repair, or when a session first transitions to running (PTY may have missed earlier resize). |
| `ensureVisible()` | ours (TerminalSlot) | Sets `visibility: "visible"` on the host element. No repair, no resize, no network. | No | No | No | Safety net after restore completes, or on socket error/close to prevent permanently hidden terminals. |
| `attachToStageContainer(container)` | ours (TerminalSlot) | Moves the host element into a real DOM container via `appendChild`, then calls `fitAddon.fit()`. Sets `stageContainer`. Called once by pool (or by dedicated terminal caller). | No | No | No | Pool registration or dedicated terminal setup. After this call, `fitAddon.fit()` returns real dimensions even when hidden. |
| `show(appearance, options)` | ours (TerminalSlot) | Sets `visibleContainer = stageContainer`, runs `terminal.refresh()` for cheap repaint insurance, sets up ResizeObserver, calls `requestResize()`. Reveals host element if `restoreCompleted` is true. | **Yes** — resize msg | No | No | Task switch activation — replaces old `mount()`. No DOM reparent, no canvas repair. |
| `hide()` | ours (TerminalSlot) | Sets `visibleContainer = null`, tears down ResizeObserver, hides host element. | No | No | No | Task deactivation — replaces old `unmount()`. No container parameter needed. |
| `repairRendererCanvas(trigger)` | ours (TerminalSlot) | Full client-side rendering repair sequence: (1) dimension bounce `resize(cols-1, rows)`, (2) `clearTextureAtlas()`, (3) `refresh(0, rows-1)`, (4) `forceResize()` → sends resize to server with `force: true` → SIGWINCH. All synchronous in one event loop turn. Guard uses `stageContainer ?? visibleContainer`. | **Yes** — via forceResize | **Yes** — via forceResize | No | DPR change, user-initiated reset. No longer called on task switch (mount slow path removed). |
| `resetRenderer()` | ours (TerminalSlot) | Disposes the WebGL addon entirely, creates a new one, then runs `repairRendererCanvas("resetRenderer")`. Nuclear option for the rendering pipeline. | **Yes** — via repair | **Yes** — via repair | No | "Reset terminal rendering" debug button only. |
| `requestRestore()` | ours (TerminalSlot) | Sends `request_restore` to server via control socket. Server serializes headless mirror buffer via `SerializeAddon`, pauses live output, sends snapshot back. Client receives it as a `restore` control message → `applyRestore()` → `terminal.reset()` + `terminal.write(snapshot)`. Purely a data fix. | **Yes** — control msg + snapshot response | No | **Yes** — async round-trip | Manual repair of terminals that have drifted from server state. Not called in normal flow. |
| Server SIGWINCH | ours (session-manager) | Sent by the kernel automatically when PTY dimensions change via `pty.resize()`. Sent explicitly by `session-manager.ts` when `force: true` AND dimensions are unchanged. Agent catches signal → queries new dimensions → full TUI redraw → fresh output through PTY → headless mirror → client. | N/A (server-side) | N/A (it IS the signal) | Yes (agent response is async) | Task switch (force TUI redraw), actual terminal resize. Interrupts the agent if mid-work. |

## Full call site audit

### `terminal.refresh(0, rows-1)`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-slot.ts` | Inside `show()` — cheap repaint insurance | Staged, becoming visible | None | **Necessary** — repaints buffer content after potential tab backgrounding or GPU texture eviction |
| `terminal-slot.ts` | Inside `visibilitychange` handler — browser tab returns to foreground | Visible | None | **Necessary** — repaints after browser may have evicted GPU textures while backgrounded |
| `terminal-slot.ts` | Inside `repairRendererCanvas()` step 3 | Staged or visible | None directly (but `forceResize()` follows) | **Necessary** — repaints with fresh textures after atlas clear |

### `terminal.clearTextureAtlas()`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-slot.ts:1013` | Inside `repairRendererCanvas()` step 2 | Mounted, visible | None | **Necessary** within repair — wipes stale glyph cache before refresh |

### `terminal.reset()`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-slot.ts:290` | `disconnectFromTask()` — after write queue drains | No task connected (taskId cleared), may or may not be mounted | None | **Necessary** — clears stale buffer before slot reuse. Guarded by `!this.taskId` to avoid clobbering a new task that connected during the await. |
| `terminal-slot.ts:463` | `applyRestore()` — before writing server snapshot | Connected, restore in progress | None (the invalidateResize on line 461 bumps epoch but doesn't send) | **Necessary** — clears old buffer so the snapshot write starts clean. |
| `terminal-slot.ts:962` | Public `reset()` method — queued after write drain | Any state | None | **Necessary** — explicit buffer wipe exposed for external callers (e.g. session restart detection). |
| `use-persistent-terminal-session.ts:121` | Dedicated terminal path — `didSessionRestart` is true | Mounted, connected | None | **Necessary** — clears stale output when the underlying session restarted. |
| `use-persistent-terminal-session.ts:194` | Pool terminal path — `didSessionRestart` is true | Mounted, connected | None | **Necessary** — same as above for pool slots. |

### `terminal.resize(cols, rows)` (client-side, local only)

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-slot.ts:465` | `applyRestore()` — snapshot has different dims than current terminal | Connected, restore in progress, buffer just reset | None | **Necessary** — syncs client grid to server dimensions before writing snapshot. |
| `terminal-slot.ts:1009` | `repairRendererCanvas()` step 1 — dimension bounce `(cols-1, rows)` | Mounted, visible | None directly (the `forceResize()` on line 1019 sends the real dims to server) | **Necessary** within repair — forces fitAddon.fit() to not short-circuit. |

### `fitAddon.fit()`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-slot.ts:312` | `openTerminalWhenFontsReady()` — first open after construction | Freshly opened, may be in parking root or visible container | None (fit alone doesn't send to server) | **Necessary** — initial sizing. Guarded by `this.visibleContainer`. |
| `terminal-slot.ts:319` | Font ready callback — `document.fonts.ready` resolved | Same as above, slightly later | None | **Necessary** — re-fit after custom font metrics are available. May produce more accurate cols/rows. |
| `terminal-slot.ts:515` | Inside `requestResize()` — before sending dims to server | Connected, visible | None from fit itself (the resize message is sent on lines 528-535) | **Necessary** — ensures local terminal matches container before reporting dims to server. |

### `requestResize(force?)`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-slot.ts:505` | Inside `forceResize()` — called with `force: true` | Connected, visible | Resize message to server, SIGWINCH if dims unchanged | **Necessary** — see forceResize entries. |
| `terminal-slot.ts:605` | IO socket `onopen` — socket reconnected, `restoreCompleted` is true | Connected, visible, restore already done | Resize message to server (no force) | **Necessary** — server may have lost our dimensions across the reconnect. |
| `terminal-slot.ts:676` | Restore success handler — restore complete, IO socket open | Connected, visible, freshly restored | Resize message to server (no force) | **Necessary** — server connection is fresh and needs our dimensions. |
| `terminal-slot.ts:876` | ResizeObserver callback — container dimensions changed | Connected, visible | Resize message to server (no force, debounced 50ms) | **Necessary** — standard container resize propagation. |
| `terminal-slot.ts:882` | `mount()` end — initial mount with `isVisible !== false` | Just mounted, visible | Resize message to server (no force) | **Necessary** — ensures server has dimensions after mount. |

### `forceResize()`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-slot.ts:711` | Control socket `state` message — session transitioning into `running` or `awaiting_review` from a non-active state | Connected, visible | Resize message with `force: true` → SIGWINCH | **Necessary** — PTY may not have had our dimensions when session first started. Guarded: only fires on first transition into active state, not active→active. |
| `terminal-slot.ts:1019` | Inside `repairRendererCanvas()` step 4 — restoring real dims after bounce | Connected, visible, mid-repair | Resize message with `force: true` → SIGWINCH | **Necessary** within repair — restores real dimensions and forces agent TUI redraw. **Problematic** when repair is called unnecessarily (e.g. from `ensureVisible`). |

### `ensureVisible()`

All call sites just toggle `visibility: "visible"`. No network, no SIGWINCH, no repair.

| File:Line | Trigger | Terminal state | Assessment |
|-----------|---------|---------------|------------|
| `terminal-slot.ts:615` | IO socket `onerror` | Socket errored, buffer valid | **Correct** — safety net, just reveal |
| `terminal-slot.ts:623` | IO socket `onclose` | Socket closed, buffer valid | **Correct** — safety net, just reveal |
| `terminal-slot.ts:674` | Restore success — buffer populated, scrolled to bottom | Freshly restored | **Correct** — reveal after restore |
| `terminal-slot.ts:687` | Restore failure — `applyRestore` rejected | Buffer in unknown state | **Correct** — reveal so user sees error message |
| `terminal-slot.ts:731` | Control socket `onerror` | Socket errored | **Correct** — safety net |
| `terminal-slot.ts:739` | Control socket `onclose` | Socket closed | **Correct** — safety net |

### `repairRendererCanvas(trigger)`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| ~~`terminal-slot.ts:493`~~ | ~~`ensureVisible()` — removed~~ | — | — | **Removed** — `ensureVisible` no longer calls `repairRendererCanvas`. |
| `terminal-slot.ts` | DPR change handler — monitor move or browser zoom | Staged or visible | Resize + SIGWINCH via forceResize | **Necessary** — glyph textures are stale at old DPR. |
| ~~`terminal-slot.ts`~~ | ~~`mount()` slow path — DOM reparent~~ | — | — | **Removed** — pre-mount architecture eliminated DOM reparent. `show()` does `terminal.refresh()` instead. |
| `terminal-slot.ts` | `resetRenderer()` — after WebGL addon swap | Staged or visible | Resize + SIGWINCH via forceResize | **Necessary** — new renderer needs dimensions and fresh textures. |

### `resetRenderer()`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-pool.ts:499` | `resetAllTerminalRenderers()` — user clicks "Reset terminal rendering" in settings | Any pool/dedicated slot | Full repair chain per slot → SIGWINCH per slot | **Necessary** — user-initiated nuclear repair. |

### `requestRestore()`

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `terminal-pool.ts:517` | `restoreAllTerminals()` — user clicks "Restore all terminals" in settings (debug) | Connected pool/dedicated slots | `request_restore` control message → server serializes + sends snapshot | **Necessary** — user-initiated data repair. |

### Server-side SIGWINCH (`session-manager.ts:617`)

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `session-manager.ts:612` | PTY resize via `pty.resize()` — kernel sends SIGWINCH automatically when dimensions actually change | Active session | Agent receives SIGWINCH, redraws TUI | **Necessary** — real dimension change. |
| `session-manager.ts:616-617` | `force: true` + dimensions unchanged — explicit `sendSignal("SIGWINCH")` | Active session, same dimensions | Agent receives SIGWINCH, redraws TUI despite no size change | **Necessary for first active transition** (line 711). **Wasteful when triggered by unnecessary repairs** (ensureVisible). |

### Server-side resize flow (`ws-server.ts:519-528`)

| File:Line | Trigger | Terminal state | Server side effects | Assessment |
|-----------|---------|---------------|-------------------|------------|
| `ws-server.ts:520` | Client sends `resize` control message | Active session on server | `session-manager.resize()` → PTY resize + mirror resize + conditional SIGWINCH | **Necessary** — gateway for all client resize messages. |
