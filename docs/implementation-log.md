# Implementation Log

> Prior entries through 2026-04-15 in `implementation-log-through-2026-04-15.md`.

## Perf: auto-evict PREVIOUS terminal slot after 30s (2026-04-15)

**Problem:** macOS WindowServer was running at ~49% CPU with multiple Quarterdeck agents active. Investigation revealed that hidden PREVIOUS terminal slots (demoted when the user switches tasks) kept their IO WebSocket open indefinitely. xterm.js continued parsing incoming PTY bytes and the WebGL addon executed `gl.drawArrays()` on every write — even though `visibility: hidden` was set. CSS visibility prevents compositing the result, but the GPU draw calls still execute and drive WindowServer work. `requestAnimationFrame` fires for hidden elements (only page-level backgrounding pauses it), so every agent output byte triggered a full render cycle in the invisible canvas.

**Fix:** Added a 30-second auto-eviction timer for PREVIOUS slots in `terminal-pool.ts`. When `acquireForTask` demotes the current ACTIVE to PREVIOUS, `schedulePreviousEviction()` starts a 30s timer. On expiry, the slot is evicted (IO socket closed, terminal disconnected, WebGL rendering stops). If the user switches back within 30s, the timer is cancelled and the warm slot is reused instantly. After 30s, the slot is reacquired fresh from the pool with a server restore snapshot — same path as any other evicted task.

The implementation mirrors the existing warmup timeout pattern. The timer is cleared in all the right places: when the PREVIOUS slot is reacquired (user switches back), when a stale PREVIOUS is explicitly evicted (step 3 of `acquireForTask`), and in `releaseAll` / `_resetPoolForTesting`.

**Files:** `web-ui/src/terminal/terminal-pool.ts`

## Fix: background terminal re-sync on task switch (2026-04-15)

**Problem:** Terminals occasionally got into a garbled visual state. The "Re-sync terminal content" button in settings or resizing the window would fix it, but the issue reappeared on task switches. Switching two tasks away and back also fixed it (because eviction forced a fresh restore on reconnect), but switching just one task away and back did not.

**Root cause:** When `acquireForTask` demotes the current ACTIVE slot to PREVIOUS, the slot keeps its WebSocket connections and continues receiving PTY output. But the xterm buffer can drift visually (rendering artifacts, stale cursor state) while detached from the DOM. On return, `acquireForTask` reuses the existing slot without re-syncing — the PREVIOUS → ACTIVE path never requested a restore snapshot.

**Fix:** Added `currentActive.requestRestore()` in `acquireForTask` immediately after demoting a slot to PREVIOUS. This re-syncs the buffer from the server's headless `TerminalStateMirror` while the user is looking at another task. The restore is safe when not visible: `applyRestore` writes to the xterm buffer (no paint cost when hidden), `ensureVisible` is guarded by `visibleContainer` (null after `hide()`), and `requestResize` only fires if dimensions changed. By the time the user switches back, the buffer is already clean.

**Files:** `web-ui/src/terminal/terminal-pool.ts`

## Fix: compare view branch dropdown left-click (2026-04-15)

**Problem:** Left-clicking a branch in the compare bar's source or target dropdown opened a context menu instead of selecting the branch for comparison.

**Root cause:** `BranchSelectorPopover` has a `disableContextMenu` prop that controls whether left-clicks dispatch a synthetic `contextmenu` event (for popovers that need checkout/merge/compare actions) or directly call `onSelect`. The two instances in `CompareBar` didn't pass this prop, so they inherited the default context-menu-on-left-click behavior — but the compare bar has no meaningful context menu actions, making the click feel broken.

**Fix:** Added `disableContextMenu` to both `BranchSelectorPopover` instances in the `CompareBar` component. Other usages (App.tsx top bar, card detail view) are unaffected.

**Files:** `web-ui/src/components/git-view.tsx`

## Fix: noisy auto-restart warning on task trash (2026-04-15)

**Problem:** When trashing a running task, `stopTaskSession` correctly sets `suppressAutoRestartOnExit = true` and kills the PTY (SIGHUP → exit code 129). The async exit handler in `handleTaskSessionExit` then calls `shouldAutoRestart`, which returns `false` — but the caller logged every `false` at `warn` level with no way to distinguish intentional suppression from unexpected skips.

**Root cause:** `shouldAutoRestart` returned a flat `boolean`, so the caller couldn't differentiate "stop/trash intentionally suppressed restart" from "no listeners attached" or "rate-limited after crash loop."

**Fix:** Changed `shouldAutoRestart` to return an `AutoRestartDecision` discriminated union: `{ restart: true }` or `{ restart: false, reason: "suppressed" | "no_listeners" | "rate_limited" }`. The caller now logs `suppressed` at `debug` (expected path) and the other reasons at `warn` (worth investigating). Also added `displaySummary` from the session summary to exit and skip log lines so tasks are identifiable without cross-referencing the task ID.

**Files:** `src/terminal/session-auto-restart.ts`, `src/terminal/session-manager.ts`
