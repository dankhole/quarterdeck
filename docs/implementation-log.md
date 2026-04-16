# Implementation Log

> Prior entries through 2026-04-15 in `implementation-log-through-2026-04-15.md`.

## Refactor: complete frontend provider migration (2026-04-15)

**Goal:** Decompose the monolithic App.tsx (~2200 lines) into focused provider components so each domain (project, board, git, terminal, interactions, dialogs) is independently maintainable.

**What changed:** Executed a 13-commit migration across 6 providers:

1. **Context field expansion** — Added missing fields to ProjectContextValue, BoardContextValue, GitContextValue so downstream providers could read from context instead of props.
2. **AppContent extraction** — Split App into App (outer, runs hooks) and AppContent (inner, renders JSX) to unblock provider migrations.
3. **DialogProvider** — Moved useAppDialogs, useDebugTools, useDebugLogging. Reads handleCancelCreateTask from BoardContext.
4. **ProjectProvider** — Moved useProjectNavigation, useRuntimeProjectConfig, useQuarterdeckAccessGate, useStartupOnboarding, useWorkspaceSync, useDocumentVisibility, and ~50 derived values.
5. **TerminalProvider** — Moved useTerminalPanels, useTerminalConnectionReady, derived terminal metadata. Derives navigationProjectPath internally from ProjectContext.
6. **GitProvider** — Moved useGitActions, useScopeContext, useBranchActions (x2), useFileBrowserData, useGitNavigation, useCardDetailLayout. Reads fetchTaskWorkspaceInfo from BoardContext.
7. **InteractionsProvider** — Moved useBoardInteractions, useTaskStartActions.
8. **BoardProvider** — Moved useDetailTaskNavigation, useTaskSessions, useTaskBranchOptions, useTaskEditor, boardContextValue construction. BoardContextValue expanded with taskEditor, createTaskBranchOptions, handleCancelCreateTask, isInitialRuntimeLoad, isAwaitingWorkspaceSnapshot.
9. **AppCore collapse** — Eliminated AppCore entirely. App is now ~50 lines (state atoms + provider tree). AppContent reads from 6 contexts + 2 props.
10. **Cleanup** — Deleted AppProviders wrapper, deleted 4 completed plan docs, updated todo.md and patterns doc.

**Provider nesting order:** ProjectProvider > AppEarlyBailout > BoardProvider > GitProvider > TerminalProvider > InteractionsProvider > DialogProvider > AppContent.

**Files:** `web-ui/src/App.tsx`, `web-ui/src/providers/board-provider.tsx`, `web-ui/src/providers/dialog-provider.tsx`, `web-ui/src/providers/git-provider.tsx`, `web-ui/src/providers/interactions-provider.tsx`, `web-ui/src/providers/project-provider.tsx`, `web-ui/src/providers/terminal-provider.tsx`, `web-ui/src/providers/app-providers.tsx` (deleted), `web-ui/src/hooks/use-app-dialogs.ts`, `web-ui/src/hooks/use-board-interactions.ts`, `web-ui/src/components/card-detail-view.test.tsx`, `docs/patterns-frontend-service-extraction.md`, `docs/todo.md`

## Fix: preserve terminal review reasons across server restart (2026-04-15)

**Problem:** Two CI test failures since Apr 12. (1) `git-stash.test.ts` dirtyTree test failed on CI because `git init --bare` didn't specify `-b main`, so the bare repo defaulted to `master` and `git push -u origin main` failed. (2) The `skip-shutdown-cleanup` integration test expected `awaiting_review` sessions with `reviewReason: "hook"` to survive a restart, but `hydrateFromRecord` (changed in `4c2bd593` on Apr 15) started marking all `awaiting_review` sessions as `interrupted` unconditionally.

**Root cause:** `hydrateFromRecord` in `session-manager.ts` and `persistInterruptedSessions` / `shouldInterruptSessionOnShutdown` in `shutdown-coordinator.ts` treated all `awaiting_review` sessions the same — marking them `interrupted` for auto-resume. But sessions with terminal review reasons (`hook`, `exit`, `error`, `attention`, `stalled`) represent completed agent work and should survive restarts. Only `running` sessions and `awaiting_review` sessions with non-terminal reasons (`interrupted`, `null`) are genuinely stale.

**Fix:**
1. `session-manager.ts`: Added `isTerminalReviewReason()` helper. `hydrateFromRecord` now only marks sessions as interrupted when the review reason is non-terminal.
2. `shutdown-coordinator.ts`: `shouldInterruptSessionOnShutdown` now checks for terminal review reasons. `persistInterruptedSessions` also filters through this check before overwriting.
3. `git-stash.test.ts`: Added `-b main` to `git init --bare` call.
4. Updated assertions in 4 test files to match new behavior: `session-manager-reconciliation.test.ts`, `session-manager-interrupt-recovery.test.ts`, `runtime-state-stream.integration.test.ts`, `shutdown-coordinator.integration.test.ts`.

**Files:** `src/terminal/session-manager.ts`, `src/server/shutdown-coordinator.ts`, `test/runtime/git-stash.test.ts`, `test/integration/runtime-state-stream.integration.test.ts`, `test/integration/shutdown-coordinator.integration.test.ts`, `test/runtime/terminal/session-manager-interrupt-recovery.test.ts`, `test/runtime/terminal/session-manager-reconciliation.test.ts`

## Fix: reconnect terminal WebSockets after sleep/wake (2026-04-15)

**Problem:** After a computer sleeps and wakes, clicking a task showed a blank/frozen terminal even though the agent was still running (prompt shortcuts still worked). Trashing and untrashing didn't help. Changing projects did fix it (because that forces a full re-mount of the terminal pool).

**Root cause:** OS sleep kills TCP connections, so the IO and control WebSockets in each `TerminalSlot` die. The `onclose` handlers null the socket refs and reset `connectionReady`/`restoreCompleted`. But when the user clicks a task, `acquireForTask()` finds the slot is already assigned to that taskId via `slotTaskIds` and returns it immediately — without checking if the sockets are alive. `show()` sets up visuals but doesn't touch sockets. Result: terminal renders but has no data connection.

The same gap existed in `ensureDedicatedTerminal()` for home/dev shells — it returned existing dedicated terminals without checking socket state.

A secondary gap: if the user was already viewing a task when sleep happened, no React effect re-runs on wake (deps haven't changed), so only the `visibilitychange` event could trigger reconnection — but it only did a visual `refresh()`.

**Fix:** Three changes:
1. Added `ensureConnected()` method on `TerminalSlot` — calls `connectIo()` and `connectControl()` which already guard against double-open (`if (this.ioSocket) return`), making it idempotent and safe to call anytime.
2. `acquireForTask()` now calls `existing.ensureConnected()` when reusing a pool slot. `ensureDedicatedTerminal()` does the same for dedicated terminals.
3. The `visibilitychange` handler now reconnects dead sockets on tab return (`!this.ioSocket || !this.controlSocket`), covering the case where the same task is selected and no React effect fires.

**Files:** `web-ui/src/terminal/terminal-slot.ts`, `web-ui/src/terminal/terminal-pool.ts`, `web-ui/src/terminal/terminal-pool.test.ts`

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
