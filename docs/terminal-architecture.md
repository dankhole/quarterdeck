# Terminal System Architecture

**Date**: 2026-04-13
**Purpose**: Complete top-to-bottom reference for how agent terminal data flows from process to pixels. Written to make visual bug investigation faster — every layer is documented with file references, known tensions, and where things can go wrong.

**Related docs**:
- `terminal-rendering-investigation.md` — WebGL vs canvas 2D rendering quality
- `terminal-scrollback-investigation.md` — scrollback duplication root causes
- `implementation-log.md` — canvas repair fix (2026-04-13 entry)

---

## Data Flow Overview

```
Agent process (Claude Code, Codex, shell)
  │ writes bytes to stdout/stderr
  ▼
PTY (node-pty)                            src/terminal/pty-session.ts
  │ raw Buffer chunks via onData
  ▼
Protocol Filter                           src/terminal/terminal-protocol-filter.ts
  │ strips OSC color queries, synthesizes replies
  ▼
┌──────────────────────────────────────────────────────────┐
│ handleTaskSessionOutput()         src/terminal/session-manager.ts:627
│                                                          │
│  Two independent consumers process the same filtered bytes:
│                                                          │
│  ┌─────────────────────┐    ┌──────────────────────────┐ │
│  │ Server Mirror        │    │ Listener fan-out         │ │
│  │ (headless xterm)     │    │ → WebSocket bridge       │ │
│  │ terminal-state-      │    │   ws-server.ts           │ │
│  │ mirror.ts            │    │                          │ │
│  └─────────────────────┘    └──────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
         │                              │
         │ serialized snapshot          │ binary chunks
         │ on connect/restore           │ over IO socket
         │ (control socket)             │
         ▼                              ▼
┌──────────────────────────────────────────────────────────┐
│ Client Terminal (browser)                                │
│ persistent-terminal-manager.ts                           │
│                                                          │
│  xterm.js Terminal instance                              │
│    │                                                     │
│    ├─ write queue (serialized promises)                  │
│    ├─ WebGL or canvas 2D renderer                        │
│    └─ glyph texture atlas cache                          │
│                                                          │
│  Canvas → pixels on screen                               │
└──────────────────────────────────────────────────────────┘
```

---

## Layer 1: PTY Process

**File**: `src/terminal/pty-session.ts`

`PtySession` wraps `node-pty`. It spawns the agent in a pseudo-terminal with `encoding: null` (raw binary output, not decoded strings). The `onData` callback normalizes every chunk to a `Buffer` before passing it upstream.

Key behaviors:
- **write()** (line ~111): Converts Buffer to string for node-pty. Silently swallows `EIO`/`EBADF` errors from writes to dead PTYs.
- **resize()** (line ~121): No-ops if already exited. Supports optional pixel dimensions.
- **stop()** (line ~151): Calls `pty.kill()` and sends `SIGTERM` to the process group (`kill(-pid)`) on non-Windows for thorough cleanup.
- **pause()/resume()** (lines ~143-149): Proxied to node-pty for flow control (used by backpressure system).

The terminal environment is set up with `COLORTERM=truecolor`, `TERM=xterm-256color`, `TERM_PROGRAM=quarterdeck` (see `session-manager-types.ts` line ~122).

---

## Layer 2: Protocol Filter

**File**: `src/terminal/terminal-protocol-filter.ts`

A **stateful** byte-level parser between raw PTY output and all downstream consumers (mirror + WebSocket). It intercepts:

### OSC 10/11 color queries

TUI apps (especially Codex) send `\e]10;?\e\\` and `\e]11;?\e\\` to ask "what are your terminal colors?" Before a browser is connected, nobody can answer. The filter:
1. Detects these sequences in the byte stream
2. Strips them from the output (they don't reach the mirror or client)
3. Synthesizes hardcoded color replies and writes them back to the PTY

Once a browser viewer attaches, `disableOscColorQueryIntercept()` is called and subsequent queries pass through to the browser terminal.

### Statefulness

The filter carries a `pendingChunk` for escape sequences that span chunk boundaries. If an ESC is the last byte of a chunk, it's held until the next chunk arrives. This is important — protocol filtering is not a per-chunk operation.

---

## Layer 3: Session Manager

**File**: `src/terminal/session-manager.ts`

Central coordinator. Owns a `Map<string, ProcessEntry>` keyed by `taskId`.

### Starting an agent session (`startTaskSession`, line ~152)

1. Saves request as `restartRequest` for potential auto-restart
2. Tears down any existing PTY and mirror
3. Creates a `TerminalStateMirror` with `scrollOnEraseInDisplay: false`
4. Resolves agent binary, args, environment via `prepareAgentLaunch()`
5. Spawns `PtySession` with `onData` → `handleTaskSessionOutput`
6. Stores active process state + mirror on the entry
7. Updates summary store to `running` or `awaiting_review`

### Output handling (`handleTaskSessionOutput`, line ~627)

1. `filterTerminalProtocolOutput()` on the raw chunk
2. If filtered chunk is empty (all content was queries), stop
3. `entry.terminalStateMirror.applyOutput(filteredChunk)` — headless mirror
4. Fan-out to all `entry.listeners` — the WebSocket bridge listener
5. Timestamp `lastOutputAt`, run `detectOutputTransition()` for state machine

---

## Layer 4: Server-Side Mirror

**File**: `src/terminal/terminal-state-mirror.ts`

A headless `@xterm/headless` Terminal that processes every filtered byte from the PTY. Exists solely to provide **restore snapshots** for clients that connect or reconnect.

### Configuration

| Setting | Agent sessions | Shell sessions |
|---------|---------------|----------------|
| `scrollOnEraseInDisplay` | `false` | `true` (default) |
| `scrollback` | 10,000 (floor: 100) | 10,000 (floor: 100) |

The `scrollOnEraseInDisplay: false` setting for agents is critical. Claude Code sends ED2 (Erase In Display) constantly for TUI redraws. With `true`, each redraw pushes the viewport into scrollback, creating thousands of duplicate frames. With `false`, erased content is discarded.

The scrollback floor of 100 lines exists to avoid an xterm.js 6.x circular-buffer crash where `lineFeed` with `scrollback: 0` causes an out-of-bounds write on `ybase + y`.

### Operation queue

All operations (`applyOutput`, `resize`, `getSnapshot`) are serialized through a promise queue. `getSnapshot()` awaits the queue drain before calling `serializeAddon.serialize({ scrollback: 10000 })`.

### Input response routing

The mirror's `onData` callback generates device attribute responses. These are routed back to the PTY **only when no browser viewer is connected** (`hasLiveOutputListener` check). When a browser is connected, the browser terminal handles these instead. This prevents the server and browser from racing on input responses.

---

## Layer 5: WebSocket Bridge

**File**: `src/terminal/ws-server.ts`

### Two channels per viewer

| Channel | Path | Transport | Purpose |
|---------|------|-----------|---------|
| IO | `/api/terminal/io` | Binary (`arraybuffer`) | PTY output → client, keystrokes → server |
| Control | `/api/terminal/control` | JSON | Restore, state, resize, ack, stop, exit, error |

URL params on both: `taskId`, `workspaceId`, `clientId`. The `clientId` is a per-browser-tab UUID that isolates viewer state while sharing the same PTY.

### Multi-viewer state

```
TerminalStreamState (one per taskId)
  ├── viewers: Map<clientId, TerminalViewerState>
  ├── backpressuredViewerIds: Set<string>
  └── detachOutputListener (single PTY listener)

TerminalViewerState (one per browser tab)
  ├── restoreComplete: boolean
  ├── pendingOutputChunks: Buffer[]     ← buffered during restore
  ├── ioState: IoOutputState            ← batching + backpressure
  ├── ioSocket: WebSocket
  └── controlSocket: WebSocket
```

### Output fan-out

One PTY output listener per task (not per viewer). When output arrives:
- Viewer with `restoreComplete && ioState`: output enqueued via `ioState.enqueueOutput(chunk)`
- Viewer still restoring: output buffered in `pendingOutputChunks`

### Output batching

Small chunks (≤256 bytes) with an idle window (>5ms since last send) → sent immediately for low latency. Otherwise chunks accumulate and flush every 4ms as a single concatenated buffer.

### Backpressure

Two thresholds per viewer:
- **WebSocket buffer**: pause at 16KB buffered, resume at 4KB
- **Unacknowledged bytes**: pause at 100KB, resume at 5KB

When **any** viewer enters backpressure → `pty.pause()` stops the kernel from reading the PTY master. Resume only when **all** backpressured viewers have caught up.

### Control messages

| Direction | Type | Purpose |
|-----------|------|---------|
| Server → Client | `restore` | Serialized snapshot + cols/rows |
| Server → Client | `state` | Session summary update |
| Server → Client | `exit` | Process exited with code |
| Server → Client | `error` | Error message |
| Client → Server | `resize` | Terminal dimensions changed |
| Client → Server | `stop` | Kill the session |
| Client → Server | `output_ack` | "I committed N bytes" (backpressure) |
| Client → Server | `restore_complete` | "Snapshot applied, send live output" |
| Client → Server | `request_restore` | "Send me a fresh snapshot" |

---

## Layer 6: Restore Protocol

The restore flow is the most complex interaction in the terminal system.

### Initial connection restore

```
  Client                          Server
    │                               │
    ├─ control socket opens ───────►│
    │                               ├── viewerState.restoreComplete = false
    │                               ├── pendingOutputChunks = []
    │◄── { type: "restore",  ──────┤
    │      snapshot, cols, rows }   ├── getSnapshot() from mirror
    │                               │
    ├── terminal.reset()            │   (client wipes all state)
    ├── terminal.write(snapshot)    │
    │                               │   (new PTY output arrives)
    │                               ├── buffers in pendingOutputChunks
    │                               │
    ├── { type: "restore_complete" }►│
    │                               ├── viewerState.restoreComplete = true
    │                               ├── flushPendingOutput() → IO socket
    │                               │
    ├── scrollToBottom()            │
    ├── requestResize()             │
    └── notifyConnectionReady()     │
```

### On-demand restore (`request_restore`)

Same flow but client-initiated. The "Re-sync terminal content" settings button triggers this via `requestRestore()` → `sendControlMessage({ type: "request_restore" })`.

### Output during restore

Between `restore` and `restore_complete`, new PTY output is buffered server-side in `pendingOutputChunks`. The client's IO socket handler does NOT gate on `restoreCompleted` — it trusts the server to buffer. After `restore_complete`, pending chunks are flushed to the IO socket and the client processes them through its normal write queue.

---

## Layer 7: Client-Side Terminal

**File**: `web-ui/src/terminal/persistent-terminal-manager.ts`

### Construction

1. Creates a hidden `hostElement` div
2. Appends it to the **parking root** — a hidden div at `left: -10000px, opacity: 0`
3. Creates an xterm.js `Terminal` with full options (font, scrollback 10k, theme colors)
4. Loads addons: FitAddon, ClipboardAddon, WebLinksAddon, Unicode11Addon
5. Waits for font readiness, then calls `terminal.open(hostElement)`
6. Attaches WebGL addon if enabled
7. Opens both WebSocket connections

### The parking root pattern (DOM persistence)

Terminals survive task switches by **never being destroyed**. The xterm instance, WebGL context, canvas, and buffer all persist across React re-renders.

- **`mount(container)`**: Moves `hostElement` from parking root into the visible container via `appendChild`. Sets up ResizeObserver, DPR listener, and schedules canvas repair.
- **`unmount(container)`**: Disconnects observers, moves `hostElement` back to parking root.

### Canvas repair (`repairRendererCanvas`)

After any DOM re-parent, the renderer's cached glyph textures and canvas dimensions go stale. xterm.js does not automatically invalidate them. Three steps fix it:

1. **Dimension bounce** — `resize(cols-1, rows)`. Forces `fitAddon.fit()` to actually call `terminal.resize()` instead of short-circuiting because dimensions "haven't changed." This recalculates the canvas pixel dimensions.
2. **`clearTextureAtlas()`** — Discards cached glyph textures so the renderer rebuilds them at the current device pixel ratio. **This is the step that fixes blurriness.** Without it, `refresh()` just re-composites the same stale textures.
3. **`refresh(0, rows-1)`** — Repaints every visible row using the newly rebuilt textures.

Then `forceResize()` restores the real dimensions and sends them to the server.

**All three steps must run together. Skipping any one produces a silent no-op.**

Called from:
- `mount()` RAF callback — repairs after DOM re-parent (task switch)
- `resetRenderer()` — user-initiated "Reset terminal rendering" button

### Terminal write queue

All writes to xterm.js go through a serialized promise chain (`terminalWriteQueue`). This guarantees ordering between restore snapshot writes, live output, and local messages like `[quarterdeck] session exited`. The `output_ack` is sent **inside the write callback**, meaning the server is told "I committed N bytes" only after xterm has actually processed them.

### Resize epoch system

Prevents duplicate resize messages while ensuring resizes go through when needed:
- `resizeEpoch` bumped on: socket open, restore, mount to new container
- `lastSatisfiedResizeEpoch` tracks when we last sent a resize
- `requestResize()` only sends if epoch is unsatisfied OR dimensions changed

### WebGL vs canvas 2D

Controlled by a global flag (`currentTerminalWebGLRenderer`). WebGL is faster but produces chunkier text than the browser's native canvas 2D renderer (see `terminal-rendering-investigation.md`). The `attachWebglAddon()` method creates the addon with a `onContextLoss` handler that falls back to canvas 2D.

### DPR change handling

`listenForDprChange()` creates a `matchMedia` query for the current DPR. When it fires (monitor switch), triggers `requestResize()` and re-registers for the new DPR.

**Note**: This calls `requestResize()` but does NOT call `repairRendererCanvas()`. The dimensions update but glyph textures remain stale. See "Known Issues" below.

---

## Layer 8: Terminal Registry

**File**: `web-ui/src/terminal/terminal-registry.ts`

A module-level `Map<string, PersistentTerminal>` keyed by `workspaceId:taskId`.

- `ensurePersistentTerminal()` — get-or-create pattern
- `disposePersistentTerminal()` — dispose + remove
- `resetAllTerminalRenderers()` — iterate all, call `resetRenderer()`
- `restoreAllTerminals()` — iterate all, call `requestRestore()`
- `setTerminalFontWeight()` / `setTerminalWebGLRenderer()` — apply config to all live terminals
- `dumpTerminalDebugInfo()` — log buffer state for all terminals (debug panel)

---

## Layer 9: React Integration

**File**: `web-ui/src/terminal/use-persistent-terminal-session.ts`

Bridges React component lifecycle to the persistent terminal.

**On mount**: Calls `ensurePersistentTerminal()`, subscribes to events (`onConnectionReady`, `onLastError`, `onSummary`, `onExit`), calls `terminal.mount(container)`.

**On cleanup**: Unsubscribes and calls `terminal.unmount()`. Does NOT dispose the terminal — it stays alive in the registry.

**Task switch flow**: React unmounts the old terminal panel and mounts the new one. Old terminal's `unmount()` parks its DOM element. New terminal's `mount()` moves its element into the visible container. Both stay alive with their WebSocket connections and buffer state.

**Session restart detection**: Compares `sessionStartedAt` with previous value. If changed, calls `terminal.reset()`.

---

## Terminal Types

| Type | Task ID pattern | `scrollOnEraseInDisplay` | Purpose |
|------|----------------|--------------------------|---------|
| Agent task | card UUID | `false` (both sides) | Claude Code, Codex |
| Home shell | `__home_terminal__` | `true` (both sides) | Project root shell |
| Detail shell | `__detail_terminal__:{cardId}` | `true` (both sides) | Per-task shell |

---

## Known Issues and Architectural Tensions

### 1. Two-terminal drift

The server mirror and client terminal are two independent xterm.js instances processing the same byte stream. There is no mechanism to verify they agree. Settings are configured independently on each side — they match today but there's no enforced coupling. If they drift, restore writes "what the server thinks" into a client that was seeing something different.

### 2. Every restore is a hard wipe

`terminal.reset()` destroys all client-side state (scrollback, cursor, alternate buffer). The snapshot is then written. This causes a visible flash. If the snapshot is incomplete or serialized at different dimensions, you get a visual mismatch.

### 3. Canvas repair is fragile

After any DOM re-parent, the 3-step repair must run. If any step is skipped, or the RAF fires before the container has its final layout, the terminal looks broken (blurry text, wrong dimensions, stale content). This is historically the #1 source of visual bugs.

### 4. No automatic reconnection

If either WebSocket drops, the terminal shows an error and stays dead. No heartbeat, no cross-socket health check. A half-connected state (one socket alive, one dead) is possible and produces confusing behavior.

### 5. Alternate screen buffer leaks

Claude Code uses the alternate screen buffer for its TUI. Transitions in/out (`\e[?1049h`/`\e[?1049l`) during resizes leak TUI content into the primary buffer scrollback. `scrollOnEraseInDisplay: false` prevents ED2 duplication but can't prevent this. See `terminal-scrollback-investigation.md`.

### 6. Backpressure starvation

One slow viewer pauses the entire PTY for all viewers. There is no timeout to kick slow viewers. A single hung browser tab can freeze output for every other tab watching the same task.

### 7. DPR changes don't clear the texture atlas

`listenForDprChange()` calls `requestResize()` but not `repairRendererCanvas()`. A monitor switch gets the right dimensions but stale glyph textures — producing blurry text until the next task switch (which triggers mount's canvas repair).

### 8. Snapshot includes full scrollback

`getSnapshot()` serializes 10,000 lines of scrollback. For the `request_restore` use case (repair a drifted terminal), the user only needs the current viewport, not a full history replay. Long-running sessions with Claude Code's conversation replays produce large snapshots with duplicated content.

### 9. Mirror input response race

The mirror answers device attribute queries only when no browser is connected. If a browser connects but is mid-restore (can't answer queries yet), TUI apps may time out waiting for a response. There's no mechanism to detect this and fall back to the mirror.
