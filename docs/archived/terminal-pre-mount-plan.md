# Terminal Pre-Mount Architecture — Implementation Plan

> Branch: `fix/terminal-restore-scroll-flash`
> Prereqs already on branch: `ensureVisible` reverted to bare visibility toggle, `findFreeOrEvict` picks newest FREE slot.
> Read `docs/terminal-restore-visibility.md` for full investigation context.

## Goal

Eliminate DOM reparent on task switch. All 4 pool slots live in the terminal container permanently. Mount becomes a visibility toggle. Warmup does the full fit+resize cycle while hidden so click-time activation is instant.

## What changes and what doesn't

**Changes:**
- Pool gets container registration (`attachContainer`/`detachContainer`)
- Pool moves all slots into the container on first registration (one-time DOM reparent from parking root)
- `mount()` → `show()`: pure visibility toggle + ResizeObserver setup
- `unmount()` → `hide()`: pure visibility toggle + ResizeObserver teardown
- Warmup path does `fitAddon.fit()` + `requestResize()` while hidden (correct dims since slot is in real container)
- `repairRendererCanvas("mount")` removed from show path
- `terminal.refresh(0, rows-1)` added to show path as cheap insurance (repaint from buffer before revealing)
- `document.visibilitychange` listener repaints revealed slot when tab comes back to foreground
- `visibleContainer` splits into `stageContainer` (physical DOM parent, set by pool) + `revealed` (boolean, set by show/hide)

**Doesn't change:**
- `repairRendererCanvas` still exists, still used by DPR change handler and `resetRenderer`
- `forceResize` on first active transition (line 711) stays — PTY needs our dimensions
- Restore flow stays the same (server sends snapshot, client writes it, reveals)
- `ensureVisible()` stays the same (bare visibility toggle)
- Dedicated terminals untouched (own lifecycle, not in pool)
- Server-side code untouched
- SIGWINCH on first session active transition stays (the only intentional one)

**SIGWINCH / restore after this change:**
- Normal task switch no longer sends SIGWINCH (mount path repair removed)
- First session active transition still sends `forceResize` → SIGWINCH (line 711, correct)
- Agent TUI redraw happens on first active only, not on every view switch
- Restore snapshots still arrive on cold switches (socket connect triggers server-side restore)
- No change to when or how restores happen — we're only changing the rendering/DOM side

## Steps

### Step 1: Add `stageContainer` to TerminalSlot, split from `visibleContainer`

**File: `web-ui/src/terminal/terminal-slot.ts`**

Add new private field:
```
private stageContainer: HTMLDivElement | null = null;
```

`stageContainer` means "I'm physically in a real, correctly-sized container." Set by pool via a new public method `attachToStageContainer(container)`. Unlike `visibleContainer`, it persists across show/hide cycles.

Add public method:
```typescript
/**
 * Move this slot's host element into a stage container. Called by the pool
 * when a terminal container becomes available. After this call, fitAddon.fit()
 * returns real dimensions even when the slot is hidden.
 */
attachToStageContainer(container: HTMLDivElement): void {
    if (this.disposed) return;
    if (this.stageContainer === container) return;
    this.stageContainer = container;
    container.appendChild(this.hostElement);
    // Size to real container dimensions now that we're in the DOM properly.
    // No repair needed — no glyph textures exist yet (slot may never have rendered),
    // and even if they did, the reparent doesn't stale them.
    this.fitAddon.fit();
}
```

Update `requestResize` (line 508) — change the `visibleContainer` guard to allow resize when staged but not yet visible. This lets warmup send dimensions to the server:
```typescript
private requestResize(force?: boolean): void {
    if (!this.connectedTaskId) return;
    // Allow resize if staged (in real container) even when not visible.
    // This enables warmup to send correct dimensions before the slot is shown.
    const container = this.visibleContainer ?? this.stageContainer;
    if (!container) return;
    this.fitAddon.fit();
    const { cols, rows } = this.terminal;
    // ... rest unchanged, but use `container` for getBoundingClientRect
```

Update the `getBoundingClientRect` call (line 521) to use `container` instead of `this.visibleContainer`.

Update `repairRendererCanvas` (line 995) — change its guard from `this.visibleContainer` to `this.stageContainer ?? this.visibleContainer` so it works for staged slots too (used by DPR change handler on hidden slots).

Update `openTerminalWhenFontsReady` (lines 311, 318) — change `this.visibleContainer` guards to `this.stageContainer ?? this.visibleContainer` so initial fit works when staged.

### Step 2: Rename `mount()` → `show()`, simplify

**File: `web-ui/src/terminal/terminal-slot.ts`**

Rename `mount()` to `show()`. Remove the fast/slow path entirely. The method becomes:

```typescript
show(
    appearance: PersistentTerminalAppearance,
    options: { autoFocus?: boolean; isVisible?: boolean },
): void {
    if (this.disposed) return;
    this.updateAppearance(appearance);

    const shouldReveal = this.restoreCompleted;

    // Cheap repaint from buffer — insurance against stale canvas frames
    // from browser tab backgrounding or GPU texture eviction.
    // No network, no SIGWINCH, no atlas clear.
    this.terminal.refresh(0, this.terminal.rows - 1);

    if (shouldReveal) {
        this.hostElement.style.visibility = "visible";
    }
    this.visibleContainer = this.stageContainer;

    // ResizeObserver setup (same as current mount)
    if (this.resizeObserver) {
        this.resizeObserver.disconnect();
    }
    this.resizeObserver = new ResizeObserver(() => {
        if (this.resizeTimer !== null) {
            clearTimeout(this.resizeTimer);
        }
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null;
            this.requestResize();
        }, RESIZE_DEBOUNCE_MS);
    });
    this.resizeObserver.observe(this.stageContainer!);
    this.listenForDprChange();
    if (options.isVisible !== false) {
        this.requestResize();
        if (options.autoFocus) {
            this.terminal.focus();
        }
    }
}
```

Key differences from current `mount()`:
- No `container` parameter — uses `stageContainer` (already set by pool)
- No fast/slow path — always the same flow (no DOM reparent ever)
- No `repairRendererCanvas("mount")` — no DOM reparent means no stale canvas
- Adds `terminal.refresh()` as cheap repaint insurance
- No `mountedContainer` tracking — not needed anymore

### Step 3: Rename `unmount()` → `hide()`

**File: `web-ui/src/terminal/terminal-slot.ts`**

Rename `unmount()` to `hide()`. Remove the `container` parameter (not needed — we know which container because `stageContainer` is set). Otherwise same logic:

```typescript
hide(): void {
    if (this.disposed && this.visibleContainer === null) return;
    if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
    }
    if (this.resizeTimer !== null) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = null;
    }
    this.clearDprListener();
    this.visibleContainer = null;
    if (this.connectedTaskId) {
        clearTerminalGeometry(this.connectedTaskId);
    }
    this.hostElement.style.visibility = "hidden";
}
```

Remove `mountedContainer` field entirely — no longer tracked.

### Step 4: Add container management to terminal-pool.ts

**File: `web-ui/src/terminal/terminal-pool.ts`**

Add module-level state:
```typescript
let poolContainer: HTMLDivElement | null = null;
```

Add exported function:
```typescript
/**
 * Register the DOM container for pool terminals. Moves all pool slots
 * into the container. Called via React ref callback when the terminal
 * panel mounts. Idempotent for the same container.
 */
export function attachPoolContainer(container: HTMLDivElement): void {
    if (poolContainer === container) return;
    poolContainer = container;
    for (const slot of slots) {
        slot.attachToStageContainer(container);
    }
    log.info(`pool container attached — ${slots.length} slots staged`);
}

/**
 * Detach the pool container. Called when the terminal panel unmounts.
 * Slots remain in the (now detached) DOM — harmless. They'll be moved
 * on the next attachPoolContainer call.
 */
export function detachPoolContainer(): void {
    poolContainer = null;
    log.info("pool container detached");
}
```

Also update `initPool()` — if `poolContainer` is already set when a new slot is created (e.g. rotation timer creates a fresh slot), attach it immediately:

In `rotateOldestFreeSlot()` (line ~400), after creating the fresh slot:
```typescript
const fresh = new TerminalSlot(newSlotId, DEFAULT_POOL_APPEARANCE);
slots[idx] = fresh;
setRole(fresh, "FREE");
if (poolContainer) {
    fresh.attachToStageContainer(poolContainer);
}
```

### Step 5: Expand warmup to do fit+resize while hidden

**File: `web-ui/src/terminal/terminal-pool.ts`**

In `warmup()`, after `slot.connectToTask(taskId, workspaceId)` (line ~281), the slot is now in the real container (via `attachToStageContainer`). The restore handler in `connectControl.onmessage` will call `requestResize()` after restore completes (line 676 in terminal-slot.ts), which now works because `stageContainer` is set.

No code change needed here — the restore success handler already calls `requestResize()` when `this.ioSocket && this.visibleContainer` is true. But `visibleContainer` isn't set during warmup. We need the `requestResize` guard change from Step 1 (using `container = this.visibleContainer ?? this.stageContainer`) to make this work.

Verify: after Step 1's `requestResize` guard change, the restore success handler's `requestResize()` call (line 676) will fire because `stageContainer` is set. The server gets correct dimensions during warmup. No additional code needed in warmup.

### Step 6: Add `document.visibilitychange` listener

**File: `web-ui/src/terminal/terminal-slot.ts`**

Add in constructor, after the terminal setup:
```typescript
this.visibilityChangeHandler = () => {
    if (document.visibilityState === "visible" && this.visibleContainer && !this.disposed) {
        this.terminal.refresh(0, this.terminal.rows - 1);
    }
};
document.addEventListener("visibilitychange", this.visibilityChangeHandler);
```

Add to `dispose()`:
```typescript
if (this.visibilityChangeHandler) {
    document.removeEventListener("visibilitychange", this.visibilityChangeHandler);
    this.visibilityChangeHandler = null;
}
```

Add private field:
```typescript
private visibilityChangeHandler: (() => void) | null = null;
```

This only fires `refresh()` (repaint from buffer) — no network, no SIGWINCH, no atlas clear. Handles browser tab backgrounding where GPU may have evicted textures or skipped frames.

### Step 7: Update callers of mount/unmount

**File: `web-ui/src/terminal/use-persistent-terminal-session.ts`**

Change `terminal.mount(container, appearance, options)` → `terminal.show(appearance, options)`.
Change `terminal.unmount(container)` → `terminal.hide()`.

The container is no longer passed to show/hide — it's managed at the pool level.

**For pool path (~line 192-210):** Before calling `terminal.show()`, ensure the pool container is attached. The container ref comes from the hook's `containerRef`. Add at the top of the effect:

```typescript
if (containerRef.current) {
    attachPoolContainer(containerRef.current);
}
```

This is idempotent — same container returns immediately.

**For dedicated terminal path (~line 114-161):** Dedicated terminals don't use the pool container. They need their own `attachToStageContainer(container)` call before `show()`:

```typescript
terminal.attachToStageContainer(container);
terminal.show({ cursorColor, terminalBackgroundColor }, { autoFocus, isVisible });
```

In the cleanup function:
```typescript
return () => {
    unsubscribe();
    terminal.hide();
    // ...
};
```

**File: `web-ui/src/terminal/terminal-pool.test.ts`**

Update the mock shape: rename `mount` → `show`, `unmount` → `hide`. Add `attachToStageContainer` mock.

### Step 8: Clean up dead code

**File: `web-ui/src/terminal/terminal-slot.ts`**

- Remove `mountedContainer` field
- Remove fast/slow path logic (replaced by simplified `show()`)
- Remove the `container` parameter from `show()` and `hide()`
- Update `repairRendererCanvas` JSDoc — remove "mount() RAF callback" from the "Called from:" list
- Keep the parking root for initial slot construction (before any container is registered)

### Step 9: Update docs

**File: `docs/terminal-restore-visibility.md`**

Update the "DOM reparent" section to reflect the new architecture. The fast/slow path distinction no longer exists. Mount is always a visibility toggle.

Update the call site audit:
- Remove `repairRendererCanvas("mount")` entry or mark as removed
- Add `terminal.refresh()` in `show()` entry
- Add `terminal.refresh()` in `visibilitychange` handler entry
- Update `requestResize` entries to note the `stageContainer` guard change

Update the cheat sheet:
- Update `ensureVisible()` — unchanged
- Add `attachToStageContainer()` — new method
- Update `show()` / `hide()` — renamed from mount/unmount
- Note: `repairRendererCanvas("mount")` no longer fires on task switch

**File: `docs/terminal-pre-mount-cheatsheet.md`** (new file)

Create a focused post-change reference doc:

```markdown
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
```

## Testing checklist

After making all changes, verify:

1. **Cold task switch** — click a task with no warm slot. Terminal should appear with correct content, scrolled to bottom, no flash.
2. **Warm task switch** — hover a card (triggers warmup), then click. Should be instant — buffer pre-populated.
3. **Back to previous** — switch to task A, then task B, then back to A. PREVIOUS slot reactivated instantly.
4. **Container change** — switch to git tab, then back to terminal tab. React unmounts/remounts the terminal panel. Slots should re-stage into the new container.
5. **Browser tab switch** — switch to another browser tab, wait 10s, switch back. Terminal should look correct (refresh on visibilitychange).
6. **DPR change** — move browser window to a different-DPI monitor. Text should re-render crisp (repairRendererCanvas still fires via DPR listener).
7. **Window resize** — drag browser window edge. Terminal should resize smoothly (ResizeObserver → requestResize).
8. **Session first active** — start a new agent task. forceResize should fire once when session transitions to "running." Agent should render correctly.
9. **Pool rotation** — leave 2+ tasks idle for 3+ minutes. Rotation should recycle oldest FREE slot. New slot should be staged in container.
10. **Reset terminal rendering** — click the debug button. All terminals should repair (resetRenderer → repairRendererCanvas).
11. **Restore all terminals** — click the debug button. All connected terminals should re-fetch server state.
12. **Dedicated terminal** — open home shell or detail shell. Should work independently of pool container lifecycle.
13. **Run `npm run check`** — typecheck + lint + tests should pass.
