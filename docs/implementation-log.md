# Implementation Log

> Prior entries through 2026-04-15 in `implementation-log-through-2026-04-15.md`.

## Remove non-WebGL terminal renderer option (2026-04-15)

**What:** Removed the `terminalWebGLRenderer` config toggle. Terminals now always use WebGL rendering — the canvas 2D fallback path and the UI toggle to switch between them are gone.

**Why:** WebGL was already the default and provided the better experience. The toggle existed as an escape hatch but added config plumbing, a settings UI control, and a live-toggle code path across 12 files for a rarely-used option. Removing it simplifies the terminal initialization path and shrinks the config surface.

**What was kept:** The `onContextLoss` handler in `attachWebglAddon()` and the try/catch around addon creation remain — if WebGL is unavailable (e.g. in jsdom tests or headless environments), xterm.js falls back to its built-in canvas 2D renderer automatically.

**Files touched:**
- `src/config/global-config-fields.ts` — removed `terminalWebGLRenderer` field from registry
- `src/core/api/config.ts` — removed from response and save request Zod schemas
- `web-ui/src/hooks/use-settings-form.ts` — removed from form values type and initial values
- `web-ui/src/hooks/terminal/use-terminal-config-sync.ts` — removed WebGL sync effect
- `web-ui/src/terminal/terminal-pool.ts` — removed `setTerminalWebGLRenderer` export
- `web-ui/src/terminal/terminal-slot.ts` — removed global flag, `updateGlobalTerminalWebGLRenderer`, `setWebGLRenderer` method; `attachWebglAddon` no longer checks the flag
- `web-ui/src/components/settings/display-sections.tsx` — removed "Use WebGL renderer" toggle
- `web-ui/src/App.tsx` — removed `terminalWebGLRenderer` from config sync call
- `web-ui/src/providers/project-provider.tsx` — removed from context interface and value
- `web-ui/src/test-utils/runtime-config-factory.ts`, `web-ui/src/terminal/terminal-pool.test.ts`, `test/runtime/config/runtime-config.test.ts` — removed from test fixtures and mocks
- `docs/todo.md` — removed completed item
- `CHANGELOG.md` — added entry

## Fix: "Compare with local tree" from branch context menu opens Compare tab (2026-04-15)

**What:** Clicking "Compare with local tree" from any branch dropdown context menu (top bar, Files scope bar, task detail) navigated to the git view but immediately snapped back to the Uncommitted tab instead of staying on Compare.

**Root cause:** `GitView` has two effects that interact with `pendingCompareNavigation`:
- **Effect A** (line ~434): switches to the Compare tab when `pendingCompareNavigation` becomes truthy.
- **Effect B** (line ~581): resets to the Uncommitted tab on project changes, with a guard that skips the reset if `pendingCompareNavigation` is truthy.

Effect B had `pendingCompareNavigation` in its dependency array. The sequence: (1) Effect A fires, sets tab to "compare". (2) `useGitViewCompare` consumes the navigation → calls `onNavigationConsumed()` → clears state to `null`. (3) Effect B re-fires because its dependency changed, sees `null`, guard fails, resets tab to "uncommitted" — undoing Effect A.

**Fix:** Added a `pendingCompareNavigationRef` ref that mirrors the prop value. Effect B now reads from the ref (stable identity, no dependency) instead of the prop. The guard still works correctly for actual project changes, but consumption of the navigation no longer re-triggers the effect.

**Files:** `web-ui/src/components/git-view.tsx`

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
