# Terminal Pool Pre-Mount — Quick Reference

## Slot lifecycle

1. **Construction** — slot created in parking root, xterm opened
2. **Staging** — `attachToStageContainer(container)` moves slot into real container, `fitAddon.fit()` sizes it
3. **Warmup** — `connectToTask()` opens sockets, server sends restore, buffer populates while hidden
4. **Show** — `show()` sets `visibility: "visible"`, sets up ResizeObserver, runs `terminal.refresh()`
5. **Hide** — `hide()` sets `visibility: "hidden"`, tears down ResizeObserver
6. **Disconnect** — `disconnectFromTask()` closes sockets, resets buffer
7. **Dispose** — full cleanup

## What triggers SIGWINCH now

| Trigger | Sends SIGWINCH? | Why |
|---------|----------------|-----|
| Task switch (show) | **No** | No DOM reparent, no repair, no forceResize |
| Warmup restore complete | **No** | requestResize sends dims but not force |
| Session first goes active (→running/awaiting_review) | **Yes** | forceResize — PTY may have missed earlier resize |
| Container resize (browser window, panel drag) | Only if dims change | Normal PTY resize, kernel sends SIGWINCH automatically |
| DPR change (monitor move, zoom) | **Yes** | repairRendererCanvas includes forceResize |
| User clicks "Reset terminal rendering" | **Yes** | resetRenderer → repairRendererCanvas |

## What triggers restore snapshots now

Unchanged from before:
- Initial socket connect (server sends restore automatically)
- User clicks "Restore all terminals" (debug button)
- requestRestore() (available for manual repair)

Agent TUI redraws happen on first active transition only. Task switching between already-active
agents does NOT send SIGWINCH or request new snapshots — the buffer is already current from
the live IO stream.

## Background health

| Mechanism | What it does | When |
|-----------|-------------|------|
| `terminal.refresh()` in `show()` | Repaints all rows from buffer | Every time a slot becomes visible |
| `document.visibilitychange` | Repaints revealed slot | Browser tab returns to foreground |
| DPR change listener | Full repairRendererCanvas | Monitor move, browser zoom |
| Pool rotation timer (3 min) | Dispose + recreate oldest FREE slot | Prevents WebGL resource staleness |
| resetRenderer (user action) | Destroy + recreate WebGL addon | User-initiated debug action |

## Container lifecycle

- Pool calls `attachPoolContainer(container)` when React terminal panel mounts
- Pool calls `detachPoolContainer()` when React terminal panel unmounts
- All 4 pool slots live in the container permanently (visibility toggled per slot)
- Dedicated terminals manage their own containers independently
- Rotation timer: new replacement slot gets `attachToStageContainer` if container exists
