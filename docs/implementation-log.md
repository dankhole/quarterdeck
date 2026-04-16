# Implementation Log

> Prior entries through 2026-04-15 in `implementation-log-through-2026-04-15.md`.

## Fix: restore sidebar panel state when returning to agent chat (2026-04-16)

**Problem:** When a sidebar panel (e.g. task_column) was open and the user switched to a full-screen main view (files or git), the auto-coupling rule in `setMainView` collapsed the sidebar. Switching back to terminal view did nothing to restore it — the sidebar stayed collapsed, forcing the user to manually reopen it every time.

**Fix:** Added `sidebarBeforeAutoCollapseRef` to `useCardDetailLayout`. When `setMainView("files")` or `setMainView("git")` auto-collapses a non-null, non-commit, non-pinned sidebar, the current sidebar ID is saved to the ref. When `setMainView("terminal")` is called and the sidebar is still null, the saved value is restored. The ref is cleared in four places to prevent stale restoration: (1) manual `toggleSidebar` calls, (2) `setMainView("home")`, (3) project switch reset, (4) after successful restoration. This ensures the restore only fires for the exact auto-collapse → return-to-terminal flow — not after the user has manually changed sidebar state.

**Files:**
- `web-ui/src/resize/use-card-detail-layout.ts` — added `sidebarBeforeAutoCollapseRef`, save in files/git branch, restore in terminal branch, clear in toggleSidebar/home/project-switch

## Refactor: split runtime-config.test.ts into focused test modules (2026-04-16)

**Problem:** `test/runtime/config/runtime-config.test.ts` was 951 lines — a single file mixing agent auto-selection, config persistence mechanics, audible notification settings, prompt shortcuts, and pinned branches. Well above the 500-line target for test files.

**What changed:**

Split into 5 focused test files + 1 shared helpers module:

1. **`runtime-config-helpers.ts`** (103 lines) — Shared utilities: `withTemporaryEnv` (env isolation), `writeFakeCommand` (fake CLI binaries), `createDefaultSavePayload` (factory for the full config object that was duplicated 3× inline at ~40 fields each).
2. **`agent-selection.test.ts`** (150 lines) — 5 tests: priority ordering, auto-select + persist, no-CLI fallback, invalid agent normalization, existing config without agent.
3. **`config-persistence.test.ts`** (248 lines) — 8 tests: global/project scope, default omission on save, empty project config cleanup, shortcut deletion cleanup, partial updates, autonomous mode roundtrip, concurrent writes.
4. **`audible-notifications.test.ts`** (166 lines) — 5 tests: defaults, roundtrip persistence, partial event merge, backcompat with missing fields, preservation of existing config.
5. **`prompt-shortcuts.test.ts`** (135 lines) — 5 tests: default shortcuts, persist/load, invalid filtering, all-invalid fallback, non-array normalization.
6. **`pinned-branches.test.ts`** (115 lines) — 5 tests: workspace read/write, null workspace, unpin cleanup, legacy project config ignore.

No test logic changes — same 28 tests, same assertions. The `createDefaultSavePayload` helper eliminates the repeated 40-field inline objects that were the main source of bloat in the persistence tests.

**Files:**
- `test/runtime/config/runtime-config.test.ts` — deleted
- `test/runtime/config/runtime-config-helpers.ts` — new shared helpers
- `test/runtime/config/agent-selection.test.ts` — new
- `test/runtime/config/config-persistence.test.ts` — new
- `test/runtime/config/audible-notifications.test.ts` — new
- `test/runtime/config/prompt-shortcuts.test.ts` — new
- `test/runtime/config/pinned-branches.test.ts` — new

## Fix: remember last viewed file when switching tasks + preserve file browser scroll position (2026-04-15)

**Problem 1 — Git view file selection resets on task switch:** `git-view.tsx:574-577` had a `useEffect([taskId])` that unconditionally set `selectedPath` to `null` when switching tasks. A module-level `lastSelectedPathByScope` Map and auto-select effect already existed to restore the cached path, but the explicit null reset created an intermediate state that interfered with restoration timing.

**Fix:** Replaced `setSelectedPathRaw(null)` with `setSelectedPathRaw(lastSelectedPathByScope.get(scopeKey) ?? null)` — eager scope-aware restoration matching the pattern in `use-file-browser-data.ts:98-101`. The auto-select effect at L520-530 still serves as the fallback when the cached path doesn't exist in the new task's file list.

**Problem 2 — File browser scroll resets to top on navigation:** `FilesView` is keyed by `${taskId}-${scopeMode}` in `card-detail-view.tsx`, so switching tasks or views fully unmounts/remounts the component, destroying all internal state including the scroll container's position and expanded directory set.

**Fix — scroll position:** Added a module-level `scrollPositionByScope` Map in `file-browser-tree-panel.tsx`. A `useEffect` cleanup saves `scrollContainerRef.current.scrollTop` on unmount. On mount, the virtualizer's `initialOffset` option reads from the Map — this sets the correct offset during the first layout calculation, avoiding the visual flash that a post-mount `useEffect` scrollTop assignment would cause (the virtualizer's `_willUpdate` runs in `useLayoutEffect` before `useEffect`, which would otherwise scroll to 0 first).

**Fix — expanded dirs:** Added module-level `expandedDirsByScope` Map and `initializedExpansionByScope` Set in `files-view.tsx`. `expandedDirs` and `hasInitializedExpansion` are initialized from these caches on mount (via `useState` initializer). A `useEffect` persists `expandedDirs` changes back to the cache. `handleInitializedExpansion` writes to the Set so the auto-expansion effect in `FileBrowserTreePanel` doesn't overwrite restored dirs on remount.

**Files:**
- `web-ui/src/components/git-view.tsx` — replaced null reset with scope-aware restoration (L574-577)
- `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx` — added `scopeKey` prop, `scrollPositionByScope` Map, unmount save effect, `initialOffset` on virtualizer
- `web-ui/src/components/files-view.tsx` — added `scopeKey` prop, `expandedDirsByScope` Map, `initializedExpansionByScope` Set, scope-aware state initialization, persistence effect, updated `handleInitializedExpansion`
- `web-ui/src/components/card-detail-view.tsx` — passed `scopeKey` to `FilesView`
- `web-ui/src/components/home-view.tsx` — passed `scopeKey` to `FilesView`
- `docs/todo.md` — removed both completed items

## Refactor: extract domain logic from hooks into plain TS modules — Phase 2 (2026-04-15)

**Goal:** Phase 2 of the hooks directory refactoring plan (`docs/refactor-hooks-directory.md`). Extract business logic from React hooks into companion pure TS modules so the logic is readable and testable without React.

**What changed:**

Split 3 priority hooks into domain module + thin React wrapper pairs, following the pattern in `docs/patterns-frontend-service-extraction.md`:

1. **`hooks/board/task-lifecycle.ts`** (from `use-task-lifecycle.ts`) — Extracted 5 functions: `isNonIsolatedTask` (predicate), `buildWorkspaceInfoFromEnsureResponse` (maps ensure response shape to workspace-info shape), `revertOptimisticMoveToInProgress` / `revertOptimisticMoveToReview` (board state reverts when async operations fail), `applyDeferredMoveToInProgress` (non-optimistic column move). The hook now calls these instead of inlining the board manipulation and guard logic.

2. **`hooks/git/conflict-resolution.ts`** (from `use-conflict-resolution.ts`) — Extracted `EMPTY_GIT_SYNC_SUMMARY` constant, `shouldResetOnStepChange` (rebase step-advancement detection), `filterUnresolvedPaths` (set difference for conflict file fetching), `detectExternallyResolvedFiles` (external resolution detection between metadata polls), `buildNoWorkspaceContinueResponse` / `buildNoWorkspaceAbortResponse` (fallback responses). The hook's effects and callbacks now delegate to these for decisions and data transforms.

3. **`hooks/project/workspace-sync.ts`** (from `use-workspace-sync.ts`) — Extracted `mergeTaskSessionSummaries` (was already a standalone function, moved to domain module), `WorkspaceVersion` interface (typed version-tracking shape), `shouldApplyWorkspaceUpdate` (stale revision guard — returns `"apply"` or `"skip"`), `shouldHydrateBoard` (board replacement vs session-only merge decision). The hook's `applyWorkspaceState` callback now calls these instead of inlining the revision comparison logic.

**Testing:** 3 new test files with 29 domain-level unit tests (plain `describe`/`it`, no `renderHook`). All 7 existing hook-level test files continue to pass unchanged. Final count: 62 web-ui test files, 595 tests.

**Files:**
- New: `web-ui/src/hooks/board/task-lifecycle.ts`, `web-ui/src/hooks/board/task-lifecycle.test.ts`, `web-ui/src/hooks/git/conflict-resolution.ts`, `web-ui/src/hooks/git/conflict-resolution.test.ts`, `web-ui/src/hooks/project/workspace-sync.ts`, `web-ui/src/hooks/project/workspace-sync.test.ts`
- Modified: `web-ui/src/hooks/board/use-task-lifecycle.ts`, `web-ui/src/hooks/git/use-conflict-resolution.ts`, `web-ui/src/hooks/project/use-workspace-sync.ts`

## Refactor: extract ConnectedTopBar, HomeView, and AppDialogs from AppContent (2026-04-15)

**What:** Extracted three JSX-heavy sections from `web-ui/src/App.tsx` AppContent (1348 → 820 lines) into dedicated child components, each reading from existing contexts and receiving only hook-local values as props.

**Why:** AppContent was the remaining monolith after the provider migration — ~1160 lines of hooks + JSX. The hooks/callbacks section (~490 lines) must stay in AppContent, but the three largest JSX blocks were self-contained enough to extract.

**Files touched:**
- `web-ui/src/App.tsx` — removed 559 lines of inline JSX, added 31 lines of component instantiations + imports
- `web-ui/src/components/connected-top-bar.tsx` — new (184 lines). TopBar with branch pill, git sync buttons, shortcut/prompt-shortcut wiring. Reads from ProjectContext, BoardContext, GitContext, TerminalContext, DialogContext. Props: `onBack`, shortcut actions, navbar state, git summary, workspace snapshot.
- `web-ui/src/components/home-view.tsx` — new (271 lines). The else-branch of the selected-card ternary: loading spinner, "no projects" empty state, GitView/FilesView/QuarterdeckBoard three-way switch, bottom home terminal pane. Reads from ProjectContext, BoardContext, GitContext, TerminalContext, InteractionsContext. Props: `topBar` (ReactNode), task editor values, git summary.
- `web-ui/src/components/app-dialogs.tsx` — new (234 lines). All 18 dialog/shelf components: DebugShelf, RuntimeSettingsDialog, PromptShortcutEditorDialog, TaskCreateDialog, ClearTrashDialog, HardDeleteTaskDialog, TaskTrashWarningDialog, 2× CheckoutConfirmationDialog, 2× CreateBranchDialog, 2× DeleteBranchDialog, 2× MergeBranchDialog, MigrateWorkingDirectoryDialog, ProjectDialogs, GitActionErrorDialog. Reads from all 5 action contexts. Props: `savePromptShortcuts`, migrate dialog state.

**Constraint:** No hooks, callbacks, useMemos, or side effects were moved out of AppContent — pure JSX extraction only.

## Refactor: organize web-ui hooks into domain subdirectories (2026-04-15)

**Goal:** Phase 1 of the hooks directory refactoring plan (`docs/refactor-hooks-directory.md`). The flat 78-file `web-ui/src/hooks/` directory was unnavigable — finding anything required grep or memorized filenames, and 5 files weren't even hooks.

**What changed:**

1. **Non-hook files relocated** — 5 files that ended up in `hooks/` by gravity moved to their proper homes:
   - `app-utils.tsx` → `utils/app-utils.tsx` (pure utility functions)
   - `session-summary-utils.ts` → `utils/session-summary-utils.ts` (pure utility functions)
   - `terminal-constants.ts` → `terminal/terminal-constants.ts` (constants)
   - `quarterdeck-access-blocked-fallback.tsx` → `components/quarterdeck-access-blocked-fallback.tsx` (React component)
   - `runtime-disconnected-fallback.tsx` → `components/runtime-disconnected-fallback.tsx` (React component)

2. **Hooks grouped into 5 domain subdirectories:**
   - `hooks/board/` (11 hooks + tests) — task lifecycle, board orchestration, drag-and-drop
   - `hooks/git/` (10 hooks + tests) — VCS operations, diffs, conflict resolution
   - `hooks/terminal/` (5 hooks + tests) — PTY panels, shell management, migration
   - `hooks/project/` (8 hooks + tests) — workspace and project navigation
   - `hooks/notifications/` (5 hooks + tests) — alerts, sound, visibility

3. **Cross-cutting hooks stayed flat** (16 files) — `use-app-hotkeys`, `use-app-dialogs`, `use-escape-handler`, `use-settings-form`, `use-task-editor`, etc. These are genuinely cross-cutting or standalone with no natural domain cluster.

4. **Import paths updated** — ~123 import sites across ~40 source files rewritten from `@/hooks/use-foo` to `@/hooks/{domain}/use-foo` (or `@/utils/`, `@/terminal/`, `@/components/` for non-hooks). No barrel files — every import is a direct file path.

**Zero logic changes.** Pure file moves + import path rewrites. Typecheck, all 552 web-ui tests, and production build pass clean.

**Files:** Every file in `web-ui/src/hooks/` was either moved or had its imports updated. Key consumers: `App.tsx`, all 6 providers (`board-provider.tsx`, `git-provider.tsx`, `terminal-provider.tsx`, `project-provider.tsx`, `dialog-provider.tsx`, `interactions-provider.tsx`), `card-detail-view.tsx`, `git-view.tsx`, `runtime-settings-dialog.tsx`, `commit-panel.tsx`, `diff-viewer-panel.tsx`, `stash-list-section.tsx`, `terminal-pool.ts`, and many hook-to-hook cross-references.

## Fix: dedicated shell terminals blank after close/reopen (2026-04-15)

**Problem:** Shell terminals (home terminal, detail dev shell) appeared blank or broken when toggled closed and reopened. The issue was intermittent — it depended on whether the WebGL context survived the DOM detachment.

**Root cause:** Dedicated shell terminals live in ephemeral React containers — when the panel closes, React unmounts the `<ResizableBottomPane>` and removes the container `<div>` from the DOM. The `TerminalSlot`'s `hostElement` (a child of that container) was removed along with it, orphaning the xterm canvas from the live DOM. This caused WebGL context loss and a stale rendering surface. On reopen, `ensureDedicatedTerminal()` returned the existing `TerminalSlot` and `attachToStageContainer()` moved the `hostElement` into the fresh container, but the rendering context was already dead. Pool terminals don't have this problem because their shared container persists across task switches.

**Fix:** Added `park()` method to `TerminalSlot` — moves the `hostElement` back to the off-screen parking root (the same persistent `<div>` used at construction time) and clears the `stageContainer` reference. Called in the dedicated terminal effect cleanup after `terminal.hide()`, before React removes the container from the DOM. This keeps the canvas in the live DOM across close/reopen cycles. All 16 `stageContainer` read sites are already null-guarded via `??` fallback or explicit checks, so setting it to null is safe.

**Files:** `web-ui/src/terminal/terminal-slot.ts` (new `park()` method), `web-ui/src/terminal/use-persistent-terminal-session.ts` (call `park()` in dedicated cleanup), `web-ui/src/terminal/use-persistent-terminal-session.test.tsx` (added `park` to mock)

## Fix: auto-restart state-awareness — stop restarting completed tasks (2026-04-15)

**Problem:** Agent sessions that completed their work and were sitting in `awaiting_review` would spam auto-restart attempts when their process exited. The logs showed repeated `auto-restart skipped on exit` with `reason: 'rate_limited'` — the restart loop hit 3 attempts in 5 seconds before being throttled. Clicking a review card after the agent process died would either not restart or show "Error" instead of "Ready for review."

**Root cause:** Three interconnected bugs:
1. `shouldAutoRestart` was state-blind — it checked suppression, listeners, and rate limits but never checked whether the agent was actually working when it died. Every non-suppressed exit triggered restart.
2. The state machine's `process.exit` handler unconditionally overwrote `reviewReason`, so `awaiting_review/hook` (agent completed) became `awaiting_review/error` when the process exited with code 1 (normal CLI shutdown noise).
3. `recoverStaleSession` (called on viewer reconnect) only skipped restart for `reviewReason === "exit"` (code 0). The overwritten `"error"` reason triggered spurious restart attempts on reconnect.

**Fix:**
1. `session-auto-restart.ts`: `shouldAutoRestart` now takes `preExitState` parameter (captured before the state machine runs). Returns `{ restart: false, reason: "not_running" }` if pre-exit state wasn't `"running"`. Auto-restart only fires for genuine crashes during active work.
2. `session-state-machine.ts`: `process.exit` on an `awaiting_review` session now preserves the existing review reason — only patches `exitCode` and `pid: null`. Cards stay "Ready for review" instead of flipping to "Error."
3. `session-manager.ts`: `recoverStaleSession` inverted from `=== "exit"` to `!== "error"` — only restarts for genuine crash errors. Removed the `store.update` that forced `reviewReason: "error"` before calling `scheduleAutoRestart`.
4. `session-reconciliation.ts`: `checkProcesslessActiveSession` simplified to skip all `awaiting_review` sessions — a processless review card is expected state, not an error.

**Files:** `src/terminal/session-auto-restart.ts`, `src/terminal/session-state-machine.ts`, `src/terminal/session-manager.ts`, `src/terminal/session-reconciliation.ts`, `test/runtime/terminal/session-manager-auto-restart.test.ts`, `test/runtime/terminal/session-state-machine.test.ts`, `test/runtime/terminal/session-reconciliation.test.ts`, `test/runtime/terminal/session-manager-reconciliation.test.ts`, `test/runtime/terminal/session-manager-interrupt-recovery.test.ts`

## Fix: auto-focus agent terminal on open (2026-04-15)

**Problem:** Opening an agent terminal required clicking on it before keyboard input would register. The terminal should auto-focus immediately.

**Root cause:** `TerminalSlot.show()` called `this.terminal.focus()` immediately, but the terminal element was still `visibility: hidden` at that point — the restore snapshot hadn't arrived yet, and the terminal defers visibility to avoid the full history visibly scrolling past during the write. Browsers silently ignore `focus()` on hidden elements. By the time restore completed and `ensureVisible()` revealed the terminal, the focus call was already lost.

**Fix:** Added a `pendingAutoFocus` flag to `TerminalSlot`. When `show()` is called with `autoFocus: true` and the terminal isn't revealed yet (`restoreCompleted === false`), the intent is stored instead of calling focus on a hidden element. After restore completes (both success and failure paths) and `ensureVisible()` reveals the terminal, the deferred `focus()` is applied. The flag is cleared on `hide()` and `reset()` to prevent stale focus on recycled pool slots.

**Files:** `web-ui/src/terminal/terminal-slot.ts`

## Refactor: rename debug-logger to runtime-logger (2026-04-15)

**Goal:** The runtime logger was still called `debug-logger` from when it was a boolean on/off toggle. Now that it's a proper four-level logger (`debug`/`info`/`warn`/`error`) used for all runtime logging, the name was misleading.

**What changed:**

1. **File rename** — `src/core/debug-logger.ts` → `src/core/runtime-logger.ts`, test file renamed to match.
2. **Type renames** — `DebugLogLevel` → `LogLevel`, `DebugLogEntry` → `LogEntry`, `DebugLogEntryListener` → `LogEntryListener`. Internal only; API contract schemas (`RuntimeDebugLogLevel`, `RuntimeDebugLogEntry` in `streams.ts`) are wire-format types shared with the frontend and left unchanged.
3. **Function renames** — `getRecentDebugLogEntries` → `getRecentLogEntries`, `onDebugLogEntry` → `onLogEntry`, `_resetDebugLoggerForTests` → `_resetLoggerForTests`.
4. **Console timestamps** — Added `[HH:MM:SS]` prefix to all console output in the `emit` function, using local time via `toTimeString().slice(0, 8)`.
5. **Orphan cleanup log level** — Bumped "found orphaned agent processes" and "killed orphaned agent process" from `info` to `warn` so they appear at the default threshold.

**Files:** `src/core/runtime-logger.ts` (renamed + modified), `src/terminal/orphan-cleanup.ts`, `src/server/runtime-state-hub.ts`, `src/server/runtime-state-messages.ts`, `src/core/service-interfaces.ts`, `src/trpc/handlers/set-log-level.ts`, `src/trpc/handlers/save-config.ts`, `src/core/event-log.ts` (comment), `src/cli.ts`, and 13 files with `createTaggedLogger` import path updates. `test/runtime/runtime-logger.test.ts` (renamed + updated assertions for timestamp prefix).

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
