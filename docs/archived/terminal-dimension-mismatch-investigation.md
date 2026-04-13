> **ARCHIVED** — Superseded by `docs/terminal-visual-bugs.md`

# Terminal Dimension Mismatch Investigation

**Date**: 2026-04-13
**Status**: Root cause identified, fix pending
**Branch for fix**: `fix/terminal-task-switch-rendering`

## Symptoms

1. **Off by 1 in status bar / input bar**: Claude Code's TUI is rendered for the wrong number of rows. Status bar appears one row too high, input prompt is shifted.
2. **Enter scrolls part of the status bar up**: Pressing Enter causes a linefeed at Claude's perceived "bottom," which isn't the actual bottom, producing a partial scroll of the status bar.
3. **Cursor in bottom-left corner after task switch**: Default cursor position visible, suggesting Claude's TUI didn't redraw for the current dimensions.
4. **Almost always slightly off after task switch**: The mismatch appears consistently when switching between tasks.
5. **Manual resize fixes it**: Dragging the window or otherwise triggering a fresh resize resolves all artifacts.
6. **Got worse in the last 1-2 days**: Correlates with removal of the SIGWINCH hack.

## Root Cause

Two contributing factors:

### 1. SIGWINCH removal left Claude with no forced redraw on task switch

**Timeline**:
- `48aa0762` (2026-04-13 12:17) — Added `sendControlMessage({ type: "resize", cols: cols - 1, rows })` during mount's canvas repair RAF. This sent the intermediate cols-1 dimension to the server, causing a real PTY resize → SIGWINCH → Claude redraws its TUI. This forced Claude to redraw on every task switch.
- `d72fedc5` (2026-04-13 14:33) — Removed the server-side intermediate resize because it was causing chat content duplication (the SIGWINCH triggered Claude to re-output its entire TUI through the PTY, which xterm.js processed as new output). Replaced with client-side-only canvas repair.

After `d72fedc5`, the canvas repair is client-side only. The server gets a resize via `forceResize()` at the end of the repair, but if the PTY already has the same dimensions (same container size as last time), the PTY doesn't actually resize, no SIGWINCH is sent, and Claude doesn't redraw. Claude's TUI stays rendered for whatever dimensions it last drew at, which may differ from the current terminal viewport.

### 2. Bug: `requestResize()` marks epoch as satisfied before confirming send

**File**: `web-ui/src/terminal/persistent-terminal-manager.ts`, `requestResize()` method (line ~375)

```typescript
private requestResize(): void {
    if (!this.visibleContainer) {
        return;
    }
    this.fitAddon.fit();
    const { cols, rows } = this.terminal;
    const epochSatisfied = this.lastSatisfiedResizeEpoch === this.resizeEpoch;
    if (epochSatisfied && cols === this.lastSentCols && rows === this.lastSentRows) {
        return;  // deduped — thinks it already sent these dimensions
    }
    this.lastSentCols = cols;                           // ← marks as "sent"
    this.lastSentRows = rows;
    this.lastSatisfiedResizeEpoch = this.resizeEpoch;   // ← marks epoch satisfied
    // ...
    this.sendControlMessage({                           // ← silently drops if socket not open!
        type: "resize", cols, rows, ...
    });
}
```

`sendControlMessage` (line ~289) silently returns if `!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN`. But `lastSentCols`, `lastSentRows`, and `lastSatisfiedResizeEpoch` are already updated before the send attempt. The system believes it sent the resize but didn't.

Consequences:
- Future calls to `requestResize()` with the same dimensions are deduped
- The PTY stays at stale dimensions
- Only a resize with DIFFERENT dimensions (e.g., manual window resize) breaks through the dedup

This can happen during initial terminal creation when the control socket is still in CONNECTING state, or after a socket drop/reconnect where the socket is briefly null.

## Fix Plan

### Fix 1: Don't mark epoch satisfied until send confirmed

Move the epoch/dedup state updates AFTER `sendControlMessage`, and only if the socket was actually open:

```typescript
private requestResize(): void {
    if (!this.visibleContainer) {
        return;
    }
    this.fitAddon.fit();
    const { cols, rows } = this.terminal;
    const epochSatisfied = this.lastSatisfiedResizeEpoch === this.resizeEpoch;
    if (epochSatisfied && cols === this.lastSentCols && rows === this.lastSentRows) {
        return;
    }
    if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
        return;  // don't update dedup state — retry on next call
    }
    this.lastSentCols = cols;
    this.lastSentRows = rows;
    this.lastSatisfiedResizeEpoch = this.resizeEpoch;
    const bounds = this.visibleContainer.getBoundingClientRect();
    this.controlSocket.send(JSON.stringify({
        type: "resize",
        cols,
        rows,
        pixelWidth: Math.round(bounds.width) || undefined,
        pixelHeight: Math.round(bounds.height) || undefined,
    }));
}
```

This ensures any dropped resize will be retried on the next `requestResize()` call (ResizeObserver, DPR change, state transition, etc.).

### Fix 2: Consider re-adding server-side resize on task switch (without the intermediate cols-1)

The SIGWINCH hack was removed because sending `cols-1` to the server caused content duplication. But we could send the REAL dimensions to the server via `forceResize()` and still get a SIGWINCH if the dimensions differ from the PTY's current size. The problem is when they DON'T differ.

One approach: send a no-op resize (same dimensions) with a flag that tells the server to deliver SIGWINCH anyway. This would require a protocol change.

Another approach: send a cols-1 resize followed immediately by the real resize, but ONLY to the server (not to the client terminal). The PTY would get two rapid resizes — the first causes SIGWINCH, the second restores correct dimensions. Risk: kernel may coalesce the SIGWINCHs if they arrive too fast (this was the original problem with `48aa0762`).

### Fix 3: Ensure resize is sent after every restore completes

The post-restore resize (line ~514) already exists but depends on `this.ioSocket && this.visibleContainer`. If either is null at restore completion time, the resize is skipped. Adding the resize to the `controlSocket.onopen` handler as well would cover the initial connection case.

## Files to Modify

- `web-ui/src/terminal/persistent-terminal-manager.ts` — `requestResize()`, possibly `mount()` RAF callback
- Possibly `src/terminal/session-manager.ts` — if adding a force-SIGWINCH server-side mechanism

## Related Context

- **Architecture docs**: `docs/terminal-architecture.md` and `docs/terminal-architecture-explained.md` — full system reference written during this investigation session
- **Scrollback investigation**: `docs/terminal-scrollback-investigation.md` — covers the ED2 duplication and alternate screen transition problems
- **Rendering investigation**: `docs/terminal-rendering-investigation.md` — covers WebGL vs canvas 2D text quality
- **Canvas repair**: The `repairRendererCanvas()` method in `persistent-terminal-manager.ts` was also fixed in this session (was missing `clearTextureAtlas()` and dimension bounce). That fix is on this branch at commit `33294afe`.

## Other Changes on This Branch

This branch (`fix/terminal-reset-button-and-debug-logging`) also contains:

1. **Reset terminal rendering button fix** (commit `33294afe`): Extracted `repairRendererCanvas()` shared method, added `clearTextureAtlas()` and dimension bounce to `resetRenderer()`, added visibility guard to skip repair for parked terminals. Added debug logging via `createClientLogger` to `resetRenderer`, `requestRestore`, and registry-level functions.

2. **Terminal architecture docs** (commit `59ef1f81`): Two new docs — `terminal-architecture.md` (full technical reference) and `terminal-architecture-explained.md` (plain-English walkthrough).

3. **Merged `fix/terminal-task-switch-rendering`** which brought in the canvas repair approach, `request_restore` protocol, and "Re-sync terminal content" button.

## Debug Logging Available

The debug logging added in commit `33294afe` will help verify the fix:
- `[persistent-terminal] {taskId} canvas repair` — logs trigger, renderer type, DPR, cols/rows, elapsed ms
- `[persistent-terminal] {taskId} renderer reset` — logs previous/current renderer, DPR
- `[persistent-terminal] {taskId} requestRestore skipped` — logs exact bail-out reason
- `[terminal] resetting renderers for N terminal(s)` — logs registry keys, total elapsed
- All routed through `createClientLogger` → browser console + debug log panel

To diagnose a specific dimension mismatch, add temporary logging to `requestResize()` that logs: calculated cols/rows, epoch state, dedup decision, and whether `sendControlMessage` actually sent.
