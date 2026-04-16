# Implementation Log

> Prior entries through 2026-04-15 in `implementation-log-through-2026-04-15.md`.

## Refactor: split git-view into domain module, hook, and sub-components (2026-04-16)

**Problem:** `web-ui/src/components/git/git-view.tsx` was 757 lines mixing persistence logic, data fetching for 3 tab modes, resize handling, conflict resolution, rollback, and rendering. Agents working on a rendering fix had to load the entire file; agents debugging data fetching had to read past 400 lines of unrelated JSX.

**Changes:**

- **Domain module** (`hooks/git/git-view.ts`, 88 lines): `GitViewTab` type, tab persistence (`loadGitViewTab`, `persistGitViewTab`), scoped path cache (`lastSelectedPathByScope` Map + IIFE hydration from localStorage, `getLastSelectedPath`, `setLastSelectedPath`), and derived state helpers (`deriveActiveFiles`, `deriveEmptyTitle`). Pure TS, no React imports.
- **Hook** (`hooks/git/use-git-view.ts`, 343 lines): All state (`activeTab`, `fileTreeVisible`, `selectedPath`, `diffComments`), effects (tab navigation, file navigation, context resets, auto-select), data fetching (3 `useRuntimeWorkspaceChanges` calls + `useAllFileDiffContent`), resize handling, conflict resolution, and file rollback. Explicit `UseGitViewResult` interface (23 fields).
- **CompareBar** (`components/git/git-view-compare-bar.tsx`, 132 lines): Extracted from inline function — has own `useState` for two popover open states, clean props interface.
- **Empty/loading panels** (`components/git/git-view-empty.tsx`, 36 lines): `GitViewLoadingPanel` (skeleton) and `GitViewEmptyPanel` (icon + title).
- **View component** (`components/git/git-view.tsx`, 255 lines): `GitViewProps extends UseGitViewOptions` for hook props + 7 render-only props. `TabButton` stays inline (28 lines, stateless, single call site).

**Design decisions:** `GitViewProps extends UseGitViewOptions` with `...hookOptions` rest spread — novel in this codebase but appropriate since the view is a thin shell over the hook. Explicit `UseGitViewResult` interface matches every other hook's pattern (not `ReturnType`). Module-level `lastSelectedPathByScope` Map stays singleton via ES module evaluation semantics.

**Files:** `web-ui/src/components/git/git-view.tsx` (rewritten), `web-ui/src/components/git/git-view-compare-bar.tsx` (new), `web-ui/src/components/git/git-view-empty.tsx` (new), `web-ui/src/hooks/git/git-view.ts` (new), `web-ui/src/hooks/git/use-git-view.ts` (new), `web-ui/src/hooks/git/index.ts` (barrel update). Public API (`GitView`, `GitViewProps`) unchanged — zero consumer updates.

## Refactor: split hooks-api test into domain-focused files (2026-04-16)

**Problem:** `test/runtime/trpc/hooks-api.test.ts` was 888 lines covering 5 unrelated behavioral domains (basic transitions, conversation summaries, permission metadata guard, permission-aware transition guard, turn checkpoints) plus misplaced `isPermissionActivity` tests that belong to `session-reconciliation.ts`. Every test repeated a 7-line `createHooksApi({...})` setup block.

**Changes:** Split into `test/runtime/trpc/hooks-api/` subdirectory:
- `_helpers.ts` (84 lines) — shared factories (`createMockManager`, `createSummary`, `permissionActivity`, `nullFilledActivity`) plus new `createTestApi(manager, overrides?)` that eliminates the boilerplate dependency injection from every test.
- `transitions.test.ts` (62 lines) — ineligible hook no-ops, activity metadata storage.
- `summaries.test.ts` (144 lines) — `appendConversationSummary`, `setDisplaySummary` fallback, truncation, edge cases.
- `permission-guard.test.ts` (350 lines) — both permission suites: metadata guard (blocks non-permission hooks from clobbering permission state) and transition guard (blocks stale `PostToolUse` during permission review).
- `checkpoints.test.ts` (105 lines) — turn checkpoint capture and ordering guarantees.

Moved `isPermissionActivity` tests (6 tests, 43 lines) to `test/runtime/terminal/is-permission-activity.test.ts` where the source function lives.

**Files:** deleted `test/runtime/trpc/hooks-api.test.ts`, created `test/runtime/trpc/hooks-api/_helpers.ts`, `test/runtime/trpc/hooks-api/transitions.test.ts`, `test/runtime/trpc/hooks-api/summaries.test.ts`, `test/runtime/trpc/hooks-api/permission-guard.test.ts`, `test/runtime/trpc/hooks-api/checkpoints.test.ts`, `test/runtime/terminal/is-permission-activity.test.ts`. All 25 tests pass.

## Refactor: split board-state.test.ts into domain-focused modules (2026-04-16)

**Problem:** `board-state.test.ts` was 899 lines with two `describe` blocks. The first — "board dependency state" — was a 562-line catch-all mixing dependency lifecycle, drag-and-drop rules, normalization, and task mutations under one misleading name. Finding tests for a specific function required scanning the entire file.

**Approach:** Grouped tests by the board-state function under test (not by the original `describe` blocks), creating 4 files that each answer one question: "where are the tests for X?" Extracted shared fixture builders (`createBacklogBoard`, `requireTaskId`) into a helpers module.

**Files:**
- Deleted: `web-ui/src/state/board-state.test.ts` (899 lines)
- Created: `board-state-dependencies.test.ts` (223 lines, 10 tests), `board-state-drag.test.ts` (302 lines, 8 tests), `board-state-normalization.test.ts` (118 lines, 6 tests), `board-state-mutations.test.ts` (239 lines, 12 tests), `board-state-test-helpers.ts` (31 lines)

## Fix: client-side logger missing log level gating (2026-04-16)

**Problem:** The `[perf]` logging added in the terminal-slot decomposition commit used `log.debug()` via `createClientLogger`, expecting level gating to suppress debug entries at the default "warn" threshold. The server-side `runtime-logger.ts` correctly filters by level, but `client-logger.ts` only had an on/off toggle (`enabled`) — no severity check. When the debug panel was open, every `log.debug()` call hit the console and panel regardless of the user's chosen level. The level dropdown only filtered server-side entries.

**Fix:** Added `LOG_LEVEL_SEVERITY` map and `currentLogLevel` state (default "warn") to `client-logger.ts`, mirroring the server pattern. The `emit()` function now short-circuits when the entry's severity is below the threshold. Added `setClientLogLevel()` export and wired it via a `useEffect` in `use-debug-logging.ts` so the panel's level dropdown controls both server and client entries.

**Files:** `web-ui/src/utils/client-logger.ts`, `web-ui/src/hooks/debug/use-debug-logging.ts`

## Refactor: frontend feature folders and barrel exports — Phases 1, 2, 4 (2026-04-16)

**Problem:** `web-ui/src/components/` had 48 files at root level mixing board, git, task, settings, debug, and shell components. `hooks/` had 15 orphan files outside domain subdirectories. Every import was a direct file path with no barrel re-exports, leading to verbose multi-line import blocks.

**Phase 1 — Sort orphan hooks:** Moved 15 hooks and their domain modules + tests from `hooks/` root into `hooks/app/` (4 files), `hooks/debug/` (4 files), `hooks/settings/` (6 files), and existing `hooks/board/` (8 files) and `hooks/git/` (2 files). Updated ~30 import sites.

**Phase 2 — Group components:** Created 6 new feature directories under `components/`: `app/` (13 files), `board/` (6 + `dependencies/` subdir), `task/` (15 files), `git/` (8 + renamed `history/` + `panels/` subdirs), `terminal/` (4 files), `debug/` (3 files). Moved 4 files into existing `settings/`. Renamed `detail-panels/` → `git/panels/`, `git-history/` → `git/history/`. Components root now has only `app-toaster.ts`, `open-workspace-button.tsx`, `search-select-dropdown.tsx` plus `shared/` and `ui/`.

**Phase 4 — Barrel exports:** Added 17 `index.ts` files: 9 in `components/` (`app/`, `board/`, `task/`, `git/`, `git/panels/`, `git/history/`, `terminal/`, `settings/`, `debug/`) and 8 in `hooks/` (`app/`, `board/`, `git/`, `terminal/`, `project/`, `notifications/`, `settings/`, `debug/`). Updated 14 external consumers to use barrel imports — consolidating e.g. 6 separate `@/components/app/*` imports into one `@/components/app` import. Phase 3 (component decomposition) deferred.

**Files touched:** ~140 files renamed/moved, ~40 files with import path updates, 17 new `index.ts` barrel files. Zero logic changes — all import paths verified via `npm run web:typecheck` after each batch. All 787 web-ui tests pass.

## Fix: awaiting_review sessions reset to idle after server restart (2026-04-16)

**Problem:** After a server restart, tasks that were legitimately in `awaiting_review` (agent fired `to_review` hook, work complete) were being recovered to `idle` when a viewer reconnected. The user's review card disappeared silently.

**Root cause:** `recoverStaleSession` (session-manager.ts:537) preserved `awaiting_review` state only when `entry.restartRequest?.kind === "task"` — but `restartRequest` is in-memory only (initialized to `null` by `createProcessEntry`). After a server restart, `hydrateFromRecord` correctly preserves the review state in the store, but the subsequent `recoverStaleSession` call (triggered by WebSocket viewer connect in ws-server.ts) falls through the `restartRequest` guard and resets to idle.

The same semantic decision ("is this a terminal review reason?") was already correctly implemented in `hydrateFromRecord` using `isTerminalReviewReason`, but `recoverStaleSession` used a different, narrower guard that depended on ephemeral server-lifetime state.

**Fix:** Restructured `recoverStaleSession` to check `isTerminalReviewReason` first, preserving `awaiting_review` state for terminal reasons regardless of `restartRequest`. The auto-restart path for `error` reason is still gated behind `restartRequest` (it needs the original launch params). Added a test covering the hydrate → viewer connect → `recoverStaleSession` path.

**Files:** `src/terminal/session-manager.ts`, `test/runtime/terminal/session-manager-interrupt-recovery.test.ts`

## Refactor: terminal-slot decomposition + loading indicator + perf logging (2026-04-16)

**Problem:** `terminal-slot.ts` was 1,227 lines handling orchestration, WebSocket management, WebGL rendering, resize handling, and a write queue. Users saw an empty background for 50-500ms while the terminal connected/restored. No perf timing existed for warmup, acquire, show, or restore round-trips. The background `requestRestore()` on PREVIOUS demotion repaired the *old* slot proactively but if the agent kept writing after the restore, the buffer drifted again before the user switched back.

**Changes:**

*Decomposition:* Extracted 4 private helper classes from `terminal-slot.ts`:
- `slot-socket-manager.ts` (239 lines) — IO + control WebSockets, `connectionReady`, `restoreCompleted`
- `slot-renderer.ts` (185 lines) — WebGL addon, font readiness, DPR change, canvas repair
- `slot-resize-manager.ts` (115 lines) — resize epoch dedup, ResizeObserver, debounce, `pendingScrollToBottom`
- `slot-write-queue.ts` (65 lines) — serialized `terminal.write()` queue with ack and text notification

Shared types (`PersistentTerminalAppearance`, `TERMINAL_SCROLLBACK`) moved to `terminal-options.ts` and `terminal-constants.ts` to avoid circular imports, re-exported from `terminal-slot.ts` for backward compat.

*Scroll fix:* Restore handler reordered to `requestResize()` → `scrollToBottom()` → `ensureVisible()`. ResizeObserver now performs synchronous `fit()+scrollToBottom()` when `pendingScrollToBottom` is armed, before the debounce timer fires.

*Loading indicator:* Added `isLoading` state to `usePersistentTerminalSession` — `true` from effect setup until `onConnectionReady` fires. Renders a centered `<Spinner>` overlay in the terminal container div. State resets ordered before `subscribe()` to avoid race with already-connected slots firing `onConnectionReady` synchronously.

*Restore timing fix:* Moved `requestRestore()` from PREVIOUS demotion in `acquireForTask` to PREVIOUS re-acquire — the restore now runs at the moment the user switches back, repairing any drift that accumulated while hidden.

*Perf logging:* Added `[perf]` timing to: `warmup` (preload start + ready), `acquireForTask` (all exit paths), `show()` (synchronous work), `requestRestore` round-trip (request → handleRestore), plus existing: socket open, font ready, restore applied, connect-to-ready, show-to-interactive, server getSnapshot, server sendRestoreSnapshot.

**Files:**
- `web-ui/src/terminal/terminal-slot.ts` — orchestrator (749 lines), perf timestamps for show/restore round-trip
- `web-ui/src/terminal/slot-socket-manager.ts` — new, WebSocket lifecycle
- `web-ui/src/terminal/slot-renderer.ts` — new, WebGL + font rendering
- `web-ui/src/terminal/slot-resize-manager.ts` — new, resize handling
- `web-ui/src/terminal/slot-write-queue.ts` — new, write serialization
- `web-ui/src/terminal/terminal-constants.ts` — `TERMINAL_SCROLLBACK` (updated 3000→1500)
- `web-ui/src/terminal/terminal-options.ts` — `PersistentTerminalAppearance` type
- `web-ui/src/terminal/terminal-pool.ts` — perf logging in warmup/acquire, moved requestRestore to re-acquire path
- `web-ui/src/terminal/use-persistent-terminal-session.ts` — `isLoading` state
- `web-ui/src/components/detail-panels/agent-terminal-panel.tsx` — Spinner overlay
- `src/terminal/terminal-state-mirror.ts` — perf logging in getSnapshot, flushBatch before snapshot
- `src/terminal/ws-server.ts` — perf logging in sendRestoreSnapshot

## Fix: clicking agent terminal panel always focuses terminal (2026-04-16)

**Problem:** Clicking in the agent terminal main view area outside the xterm canvas (padding, gutters, empty space around the terminal) did not focus the terminal for keyboard input. Only clicks directly on the xterm canvas element triggered xterm's built-in focus behavior.

**Fix:** Added an `onClick` handler to the terminal panel's content wrapper div in `AgentTerminalPanelLayout`. The handler calls `getTerminalController(taskId)?.focus?.()` which delegates to `TerminalSlot.focus()` → `xterm.focus()`. Placed on the outer padding wrapper (not the inner `kb-terminal-container`) so clicks on the 3px padding also trigger focus.

**Files touched:**
- `web-ui/src/components/detail-panels/agent-terminal-panel.tsx` — added `getTerminalController` import, changed `taskId: _taskId` → `taskId` to use it, added `onClick` handler on terminal content wrapper div

## Refactor: split audible-notifications test into focused modules (2026-04-16)

**Problem:** `web-ui/src/hooks/notifications/use-audible-notifications.test.tsx` was 1,393 lines — a single file covering basic sound events, per-event toggles, visibility gating, settle window timing, and project suppression.

**What changed:**

Split into 4 focused test files + 1 shared utilities module:

1. **`audible-notifications-test-utils.tsx`** (125 lines) — Shared `createMockSession` factory, `HookProps` type, `defaultProps`, `HookHarness` component, `setupTestHarness`/`cleanup` lifecycle.
2. **`audible-notifications-basic.test.tsx`** (439 lines) — 11 tests: permission/review/failure sounds, exit codes, PTY crash, attention, volume, batch updates, cross-workspace.
3. **`audible-notifications-toggles.test.tsx`** (426 lines) — 10 tests: master toggle, per-event toggles, visibility gating, silent states, initial snapshot, session removal.
4. **`audible-notifications-settle.test.tsx`** (263 lines) — 5 tests: priority upgrade during settle, cancel on resume, immediate fire for non-hook, settle delay enforcement, AudioContext click listener.
5. **`audible-notifications-suppress.test.tsx`** (211 lines) — 4 tests: current-project suppression, non-suppressed event passthrough, other-project passthrough, mixed batch.

No test logic changes — same 31 tests, same assertions.

**Files:**
- `web-ui/src/hooks/notifications/use-audible-notifications.test.tsx` — deleted
- `web-ui/src/hooks/notifications/audible-notifications-test-utils.tsx` — new shared utilities
- `web-ui/src/hooks/notifications/audible-notifications-basic.test.tsx` — new
- `web-ui/src/hooks/notifications/audible-notifications-toggles.test.tsx` — new
- `web-ui/src/hooks/notifications/audible-notifications-settle.test.tsx` — new
- `web-ui/src/hooks/notifications/audible-notifications-suppress.test.tsx` — new

## Refactor: split globals.css into domain-specific stylesheets (2026-04-16)

**Problem:** `web-ui/src/styles/globals.css` was a 920-line god file mixing 9 unrelated concerns — theme tokens, base resets, board layout, diff viewer styles (the largest block at ~300 lines), markdown prose rendering, component-specific styles, keyframe animations, PWA window controls overlay, and utility classes. Finding and editing styles required scrolling through the entire file.

**Fix:** Split into 9 files by domain, each self-contained:

| File | Lines | Domain |
|------|-------|--------|
| `theme.css` | 45 | `@theme` design tokens (surfaces, borders, text, status, fonts, radii) |
| `base.css` | 39 | html/body/root reset, scrollbar styling, focus ring |
| `board.css` | 145 | Board flex layout, column cards, card shell, dependency overlays/paths, navbar buttons |
| `diff.css` | 304 | Diff rows, split view grid, inline segments, syntax tokens, entry/header/comments, readonly mode |
| `markdown.css` | 151 | Rendered markdown headings, lists, tables, code blocks, blockquotes |
| `components.css` | 143 | Project navigation rows, file tree rows, git history rows, terminal scrollbar, Sonner toast |
| `animations.css` | 37 | `@keyframes` (overlay, dialog, tooltip, skeleton) + `.kb-skeleton` class |
| `pwa.css` | 24 | `@media (display-mode: window-controls-overlay)` drag regions |
| `utilities.css` | 19 | `.kb-line-clamp-{1,2,5}` helpers |

`globals.css` reduced to an 11-line import manifest (`@import "tailwindcss"` + 9 local imports). No style changes — verified via full production build (CSS bundle size unchanged).

**Files:**
- `web-ui/src/styles/globals.css` — rewritten as import manifest
- `web-ui/src/styles/theme.css` — new
- `web-ui/src/styles/base.css` — new
- `web-ui/src/styles/board.css` — new
- `web-ui/src/styles/diff.css` — new
- `web-ui/src/styles/markdown.css` — new
- `web-ui/src/styles/components.css` — new
- `web-ui/src/styles/animations.css` — new
- `web-ui/src/styles/pwa.css` — new
- `web-ui/src/styles/utilities.css` — new

## Feature: stale-while-revalidate board caching for project switches (2026-04-16)

**Problem:** Switching between projects showed a full-screen loading spinner while the WebSocket reconnected and the snapshot loaded, even for projects the user had just visited seconds ago. The server-side latency was already optimized, but the client threw away all board state on every project switch and waited for a fresh load.

**Solution:** A module-scoped board cache (`project-board-cache.ts`) that retains board state per project across switches. The cache holds `BoardData`, sessions, revision, workspace path, and git info — everything needed to display the board immediately. On project switch, the old project's board is stashed into the cache, and the target project's board is restored from cache if available. The loading spinner is suppressed when cached data is being served.

**Key design decisions:**

1. **`canPersistWorkspaceState` stays `false` while serving cached data.** This is the critical safety gate — cached board data is displayed (stale-while-revalidate) but cannot be written back to disk. Only when authoritative data arrives from the server does persistence re-enable. This prevents the scenario where stale cached data overwrites fresher server state.

2. **`workspaceRevision` is set from cache.** The `shouldApplyWorkspaceUpdate` / `shouldHydrateBoard` guards use the cached revision to determine whether incoming data requires a full board hydration. If nothing changed since the cache was stashed, the board stays as-is; if the revision advanced, a full hydration replaces the cached data.

3. **`resetWorkspaceSyncState(targetProjectId)` does both stash and restore in one call.** The target project ID is passed from `useProjectSwitchCleanup`, which has access to `navigationCurrentProjectId` (the project the user clicked on). This avoids the timing issue where `currentProjectId` (from the WebSocket stream) hasn't updated yet.

4. **Cache is populated on every successful `applyWorkspaceState` via `updateProjectBoardCache`.** This means the cache stays fresh as long as the user is on a project — any board mutations that persist successfully also update the cache entry. Cache entries for the current project are updated in-place (via `updateProjectBoardCache`) rather than stashed/restored.

5. **5-minute TTL, 10-entry max.** TTL prevents serving extremely stale data. Max entries prevents unbounded memory growth. Oldest entry is evicted on overflow.

6. **Board data stored normalized.** The cache stores the output of `normalizeBoardData`, not raw server data. This ensures `setBoard(cached.board)` is safe.

**Relationship to preload-on-hover cache:** The two caches serve different scenarios:
- **Preload cache** (15-second TTL): First visit to a project after hovering. Consumed once on switch.
- **Board cache** (5-minute TTL): Revisiting a previously loaded project. Persists across multiple switches.

They don't conflict — the preload cache is consumed in the stream reducer, which feeds into `applyWorkspaceState`, which updates the board cache.

**Files:**
- `web-ui/src/runtime/project-board-cache.ts` — **new**. Module-scoped cache (Map) with stash/restore/update/invalidate/clear operations. TTL check on restore. LRU eviction on overflow.
- `web-ui/src/runtime/project-board-cache.test.ts` — **new**. 9 unit tests covering stash/restore, TTL expiry, eviction, update-only-existing, invalidate, clear, overwrite.
- `web-ui/src/hooks/project/use-workspace-sync.ts` — Added `boardRef`/`sessionsRef` inputs, `isServedFromBoardCache` state. `resetWorkspaceSyncState` now accepts `targetProjectId`, stashes old board, restores target from cache. `applyWorkspaceState` clears cache flag and updates cache entry on success.
- `web-ui/src/hooks/project/use-project-switch-cleanup.ts` — Added `navigationCurrentProjectId` input, passes it to `resetWorkspaceSyncState`.
- `web-ui/src/hooks/project/use-project-ui-state.ts` — Added `isServedFromBoardCache` input. `shouldShowProjectLoadingState` is now `false` when cached data is being served.
- `web-ui/src/providers/project-provider.tsx` — Threads `boardRef`/`sessionsRef` to `useWorkspaceSync`, exposes `isServedFromBoardCache` in context.
- `web-ui/src/App.tsx` — Creates `boardRef`/`sessionsRef` refs, passes to `ProjectProvider`. Passes `isServedFromBoardCache` to `useProjectUiState`.
- `web-ui/src/hooks/project/use-workspace-sync.test.tsx` — Updated test harness with `boardRef`/`sessionsRef`.
- `web-ui/src/hooks/project/use-project-ui-state.test.tsx` — Added `isServedFromBoardCache` to test input.

## Feature: auto-sync task base ref on branch change (2026-04-16)

**Problem:** Task `baseRef` was set at creation via `resolveTaskBaseRef()` and never updated. When a user checked out a different branch in the worktree (e.g. switched from a branch forked from `main` to one forked from `develop`), the "from main" label and behind-base commit count became stale.

**Solution — auto-detection in metadata polling:**

Added branch change detection to the metadata monitor's existing polling cycle. `CachedTaskWorkspaceMetadata` now tracks `lastKnownBranch`. When the focused or background task refresh detects a branch change (`newBranch !== lastKnownBranch`), it calls `resolveBaseRefForBranch()` to compute the appropriate new base ref.

`resolveBaseRefForBranch()` (`src/workspace/git-utils.ts`) uses a two-phase strategy:
1. Check the branch's upstream tracking ref (`@{upstream}`) — if it points at an integration branch (e.g. `origin/develop`), use that.
2. Fall back to merge-base distance: test each candidate (project default base ref + `main`/`master`/`develop`), compute distance from merge-base to HEAD, pick the closest ancestor.

**Solution — WebSocket broadcast (single-writer pattern):**

Follows the `task_title_updated` reference pattern to respect the board state single-writer rule. New `task_base_ref_updated` stream message type flows: server detects change → `broadcastTaskBaseRefUpdated()` → WebSocket → `runtime-stream-dispatch.ts` handler → `latestTaskBaseRefUpdate` in reducer → `useTaskBaseRefSync` hook applies to board state → normal debounced persist cycle.

**Solution — manual override UI:**

The "from X" label in `ConnectedTopBar` is now a clickable `BaseRefLabel` component backed by a Radix Popover. It shows:
- A text input pre-filled with the current base ref
- A pin/unpin toggle — when pinned, `baseRefPinned: true` on the card suppresses auto-sync
- Pinned state displays a lock icon on the label

**Schema changes:**

- `RuntimeBoardCard` (`src/core/api/board.ts`): added `baseRefPinned?: boolean`
- `BoardCard` (`web-ui/src/types/board.ts`): added `baseRefPinned?: boolean`
- New stream message: `task_base_ref_updated` (schema, factory, broadcast, dispatch handler, reducer case)

**Files changed:**
- `src/core/api/board.ts` — added `baseRefPinned` field
- `src/core/api/streams.ts` — new `runtimeStateStreamTaskBaseRefUpdatedMessageSchema`, added to discriminated union
- `src/core/service-interfaces.ts` — `broadcastTaskBaseRefUpdated` on `IRuntimeBroadcaster`
- `src/server/runtime-state-messages.ts` — `buildTaskBaseRefUpdatedMessage` factory
- `src/server/runtime-state-hub.ts` — broadcast impl + wired monitor callbacks (`onTaskBaseRefChanged`, `getProjectDefaultBaseRef`)
- `src/server/workspace-metadata-monitor.ts` — `checkForBranchChanges` helper, called from `refreshFocusedTask` and `refreshBackgroundTasks`
- `src/server/workspace-metadata-loaders.ts` — `lastKnownBranch` in `CachedTaskWorkspaceMetadata`, populated in all return paths
- `src/workspace/git-utils.ts` — `resolveBaseRefForBranch()` utility
- `web-ui/src/runtime/runtime-stream-dispatch.ts` — handler + action type for `task_base_ref_updated`
- `web-ui/src/runtime/use-runtime-state-stream.ts` — `TaskBaseRefUpdate` type, `latestTaskBaseRefUpdate` store field, reducer case
- `web-ui/src/hooks/project/use-project-navigation.ts` — threaded `latestTaskBaseRefUpdate`
- `web-ui/src/providers/project-provider.tsx` — threaded `latestTaskBaseRefUpdate`
- `web-ui/src/hooks/use-task-base-ref-sync.ts` — new hook (mirrors `useTaskTitleSync`)
- `web-ui/src/App.tsx` — wired `useTaskBaseRefSync`
- `web-ui/src/components/connected-top-bar.tsx` — `BaseRefLabel` component with Radix Popover, `handleUpdateBaseRef`
- `web-ui/src/types/board.ts` — `baseRefPinned` on `BoardCard`

## Feat: wire inline diff comments to agent terminal (2026-04-16)

**Problem:** The diff viewer had a fully built inline comment UI (click lines, type comments, keyboard shortcuts, formatting, styling, tests) but the terminal integration was never connected. `DiffViewerPanel` accepted `onAddToTerminal`/`onSendToTerminal` callbacks but `GitView` never passed them. Separately, `useBoardInteractions` had orphaned `handleAddReviewComments`/`handleSendReviewComments` handlers that were exported but never consumed by any component.

**Fix:** Created `handleAddToTerminal` and `handleSendToTerminal` callbacks in `CardDetailView` using `sendTaskSessionInput` from `BoardContext`. "Add" pastes formatted comments via paste mode without submitting. "Send" pastes, waits 200ms, then sends `\r` to submit — matching the existing pattern from the orphaned handlers and `use-git-actions.ts:235-248`. After send, focuses the terminal via `getTerminalController`. Both show error toasts on failure.

Threaded the callbacks through `GitView` (new props) → `DiffViewerPanel` (existing props, now populated). The `HomeView` git view correctly gets no callbacks since there's no agent terminal in that context.

Removed the orphaned handlers from `useBoardInteractions` along with their `sendTaskSessionInput` input prop, `getTerminalController` import, and `showAppToast` import. Updated `InteractionsProvider` to stop passing the removed prop. Cleaned up test fixture.

**Files:**
- `web-ui/src/components/card-detail-view.tsx` — added `sendTaskSessionInput` from board context, `handleAddToTerminal`/`handleSendToTerminal` callbacks, imported `showAppToast` and `getTerminalController`, passed callbacks to `GitView`
- `web-ui/src/components/git-view.tsx` — added `onAddToTerminal`/`onSendToTerminal` to `GitViewProps`, destructured in component, passed through to `DiffViewerPanel`
- `web-ui/src/hooks/board/use-board-interactions.ts` — removed `handleAddReviewComments`, `handleSendReviewComments`, `sendTaskSessionInput` from input interface, removed unused imports (`showAppToast`, `getTerminalController`, `SendTerminalInputOptions`)
- `web-ui/src/providers/interactions-provider.tsx` — removed `sendTaskSessionInput` from `useBoardContext` destructuring and `useBoardInteractions` call
- `web-ui/src/hooks/board/use-board-interactions.test.tsx` — removed `NOOP_SEND_TASK_INPUT` and its usage in fixture

## Branch management tier 2: rebase onto, rename branch, reset to here (2026-04-16)

**What:** Added three new branch operations to the context menus in both the top-bar `BranchSelectorPopover` and the git history `GitRefsPanel`: "Rebase onto", "Rename branch", and "Reset to here". Each has a confirmation dialog, full task-scoped worktree support, and toast feedback.

**Backend (5 files):**
- `src/core/api/git-sync.ts` — added `runtimeGitRenameBranchRequest/Response` and `runtimeGitResetToRefRequest/Response` Zod schemas + types
- `src/core/api/git-merge.ts` — added `runtimeGitRebaseRequest/Response` schemas (placed after `runtimeConflictStateSchema` to avoid forward reference)
- `src/workspace/git-conflict.ts` — added `runGitRebaseAction()` — runs `git rebase <onto>`, detects conflicts via `ls-files -u`, auto-aborts on non-conflict failure, returns `RuntimeGitRebaseResponse` with optional `conflictState`
- `src/workspace/git-sync.ts` — added `renameBranch()` (`git branch -m`) with existence/uniqueness validation, and `resetToRef()` (`git reset --hard`) with ref verification
- `src/trpc/app-router-context.ts` — added `renameBranch`, `rebaseBranch`, `resetToRef` to the `workspaceApi` interface
- `src/trpc/workspace-procedures.ts` — added three new tRPC mutations wired to the workspace API
- `src/trpc/workspace-api.ts` — implemented the three methods: rebase and reset support task-scoped worktree resolution and shared-checkout guards; rename operates on the home repo only

**Frontend (12 files):**
- `web-ui/src/hooks/git/use-branch-actions.ts` — added `RebaseBranchDialogState`, `RenameBranchDialogState`, `ResetToRefDialogState` types, dialog state + open/close/confirm handlers for all three, wired to tRPC mutations with toast feedback and conflict detection callbacks
- `web-ui/src/components/detail-panels/rebase-branch-dialog.tsx` — new confirmation dialog (primary variant, warns about history rewriting)
- `web-ui/src/components/detail-panels/rename-branch-dialog.tsx` — new dialog with text input, ref-based focus, Enter-to-submit, validates non-empty and different-from-current
- `web-ui/src/components/detail-panels/reset-to-ref-dialog.tsx` — new confirmation dialog (danger variant, warns about permanent data loss)
- `web-ui/src/components/detail-panels/branch-selector-popover.tsx` — added `onRebaseBranch`, `onRenameBranch`, `onResetToRef` callback props, threaded through to `BranchItem`, rendered as context menu items (rebase/reset on all branches, rename on local only)
- `web-ui/src/components/git-history/git-refs-panel.tsx` — added same three callbacks to `GitRefsPanel` and `RefContextMenu`, rendered with appropriate disabled states
- `web-ui/src/components/connected-top-bar.tsx` — passed the three new handlers from `topbarBranchActions` to `BranchSelectorPopover`
- `web-ui/src/components/home-view.tsx` — passed handlers to both the file browser `BranchSelectorPopover` and `GitHistoryView`
- `web-ui/src/components/git-history-view.tsx` — added three new props, threaded to `GitRefsPanel`
- `web-ui/src/App.tsx` — passed handlers to the board-level `GitHistoryView`
- `web-ui/src/components/app-dialogs.tsx` — rendered all six new dialog instances (2 each × fileBrowser + topbar scopes)
- `web-ui/src/components/card-detail-view.test.tsx` — added the 12 new properties to both mock `UseBranchActionsResult` objects

## Perf: headless mirror batching and scrollback reduction (2026-04-16)

**Problem:** With many agents running simultaneously, the terminal UI becomes laggy. Investigation revealed the bottleneck is server-side event loop saturation — every PTY output byte from every agent goes through a headless xterm `terminal.write()` (full ANSI parsing, cursor movement, line wrapping), each as a separate Promise-chained operation. With 8+ agents, this starves the event loop and delays WebSocket sends to the visible terminal.

**Changes:**

1. **Batched mirror writes** (`src/terminal/terminal-state-mirror.ts`): Added `setBatching(enabled)` toggle. When enabled, output chunks accumulate in a buffer and flush as a single concatenated `terminal.write()` every 160ms instead of one operation per PTY chunk. `getSnapshot()` synchronously flushes pending batches before serializing, so restore snapshots are always complete.

2. **Automatic batching lifecycle** (`src/terminal/session-manager.ts`): New mirrors start in batched mode (no browser viewer yet). When `attach()` receives a listener with `onOutput` (browser connects), batching turns off for instant output. When the last output listener detaches, batching re-enables. This means only the actively-viewed task does per-chunk writes; all others coalesce.

3. **Scrollback reduction** (`terminal-state-mirror.ts`, `web-ui/src/terminal/terminal-slot.ts`): Dropped from 3,000 to 1,500 lines on both server mirror and client terminal. Halves memory per terminal and halves snapshot serialization cost. The removed `scrollback: 3_000` override in the task session mirror constructor was redundant — it now uses the module-level default.

**Files changed:**
- `src/terminal/terminal-state-mirror.ts` — batching state, `setBatching()`, `flushBatch()`, timer management, scrollback constant
- `src/terminal/session-manager.ts` — batching toggle in `attach()` detach callback, initial batching on mirror creation, removed redundant scrollback override
- `web-ui/src/terminal/terminal-slot.ts` — scrollback constant 3000→1500

## Refactor: remove CLI task commands and enforce single-writer pattern (2026-04-16)

**Problem:** The `quarterdeck task` CLI subcommands (create, update, trash, delete, start, link, unlink, list) used `mutateWorkspaceState` to write board state directly to disk. This was the only server-side board state writer and could race with the UI's single-writer persist cycle when a browser was connected, potentially causing `WorkspaceStateConflictError` toasts. The CLI commands were unused — all operations were handled by the browser UI.

Additionally, `migrate-task-working-directory` (a tRPC handler called by the browser) also used `mutateWorkspaceState` to update `card.workingDirectory` and `card.useWorktree` server-side, violating the single-writer rule.

**Fix:**
1. Deleted 4 CLI task command files (~750 lines): `src/commands/task.ts`, `task-lifecycle-handlers.ts`, `task-workspace.ts`, `task-board-helpers.ts`.
2. Removed `registerTaskCommand` from `src/cli.ts`.
3. Deleted `mutateWorkspaceState` and its supporting types (`RuntimeWorkspaceAtomicMutationResult`, `RuntimeWorkspaceAtomicMutationResponse`) from `src/state/workspace-state.ts`.
4. Refactored `migrate-task-working-directory` to broadcast a `task_working_directory_updated` WebSocket message instead of writing board state. New message type wired through the full stack: Zod schema (`src/core/api/streams.ts`), message builder (`src/server/runtime-state-messages.ts`), broadcaster interface and hub (`src/core/service-interfaces.ts`, `src/server/runtime-state-hub.ts`), runtime API deps (`src/trpc/runtime-api.ts`), frontend dispatch (`web-ui/src/runtime/runtime-stream-dispatch.ts`), state stream reducer (`web-ui/src/runtime/use-runtime-state-stream.ts`), project navigation/provider plumbing, and new `use-task-working-directory-sync.ts` board sync hook (mirrors `use-task-title-sync.ts`).
5. Updated `AGENTS.md` single-writer rule documentation.
6. Cleaned up test mocks referencing `mutateWorkspaceState` across 4 test files; removed integration tests for deleted CLI commands.

**Files:**
- `src/commands/task.ts` — deleted
- `src/commands/task-lifecycle-handlers.ts` — deleted
- `src/commands/task-workspace.ts` — deleted
- `src/commands/task-board-helpers.ts` — deleted
- `src/cli.ts` — removed `registerTaskCommand` import/call
- `src/state/workspace-state.ts` — removed `mutateWorkspaceState` + types
- `src/trpc/handlers/migrate-task-working-directory.ts` — broadcast instead of mutate
- `src/core/api/streams.ts` — new `task_working_directory_updated` schema
- `src/server/runtime-state-messages.ts` — new builder
- `src/core/service-interfaces.ts` — new broadcaster method
- `src/server/runtime-state-hub.ts` — new broadcast implementation
- `src/trpc/runtime-api.ts` — updated broadcaster Pick
- `src/trpc/workspace-api.ts` — comment cleanup
- `web-ui/src/runtime/runtime-stream-dispatch.ts` — new handler
- `web-ui/src/runtime/use-runtime-state-stream.ts` — new type, state, reducer case
- `web-ui/src/hooks/project/use-project-navigation.ts` — plumbing
- `web-ui/src/providers/project-provider.tsx` — plumbing
- `web-ui/src/hooks/use-task-working-directory-sync.ts` — new board sync hook
- `web-ui/src/App.tsx` — wire new sync hook
- `AGENTS.md` — updated single-writer rule docs
- `test/runtime/trpc/runtime-api.test.ts` — removed mutate mocks/assertions
- `test/runtime/trpc/workspace-api.test.ts` — removed mutate mocks/assertions
- `test/runtime/trpc/workspace-api-conflict.test.ts` — removed mutate mock
- `test/runtime/trpc/workspace-api-stash.test.ts` — removed mutate mock
- `test/integration/task-command-exit.integration.test.ts` — removed CLI task tests

## Refactor: complete hook domain logic extraction — Phase 2 final (2026-04-16)

**Goal:** Complete all remaining hook domain extractions and close out Phase 2.

**Extractions performed (7 domain modules, 119 new tests):**

1. **`notifications/audible-notifications.ts`** — 6 functions + 2 constants from `use-audible-notifications.ts`: `deriveColumn`, `resolveSessionSoundEvent`, `getSettleWindowMs`, `isTabVisible`, `areSoundsSuppressed`, `isEventSuppressedForProject`, `EVENT_PRIORITY`, `AudibleNotificationEventConfig` type. 35 tests.

2. **`debug-logging.ts`** — 5 functions + 1 constant from `use-debug-logging.ts`: `loadDisabledTags`, `persistDisabledTags`, `mergeLogEntries`, `extractAvailableTags`, `filterLogEntries`, `LEVEL_ORDER`. Types re-exported from hook file for backward compatibility. 22 tests.

3. **`task-editor.ts`** — 5 functions from `use-task-editor.ts`: `isPlanModeDisabledByAutoReview` (plan mode + auto-review incompatibility check), `resolveDefaultBranchRef` (config override vs last-used-branch memory), `isBranchRefValid` (branch option validation), `isTaskSaveValid` (prompt + branch ref validation), `resolveEffectiveBaseRef` (branch ref with fallback). Replaced 6 inline expressions in the hook. 21 tests.

4. **`board/review-auto-actions.ts`** — 4 functions + 1 constant from `use-review-auto-actions.ts`: `isTaskAutoReviewEnabled`, `buildColumnByTaskId` (board → Map<taskId, columnId>), `getReviewCardsForAutomation` (review column + auto-review filter), `isAutoTrashMode` (resolved mode check), `AUTO_REVIEW_ACTION_DELAY_MS`. Replaced the inline column-building loop and double filter in `evaluateAutoReview`. 14 tests.

5. **`terminal/shell-auto-restart.ts`** — 3 functions + 3 constants from `use-shell-auto-restart.ts`: `parseRestartTarget` (taskId → `{type: "home"}` | `{type: "detail", cardId}` | null), `canRestart` (sliding window rate limiter check), `recordRestart` (prune + append timestamp), `MAX_RESTARTS`, `RATE_LIMIT_WINDOW_MS`, `RESTART_DELAY_MS`. Replaced inline taskId validation and rate limiting logic. 13 tests.

6. **`board/linked-backlog-task-actions.ts`** — 2 functions from `use-linked-backlog-task-actions.ts`: `getDependencyAddErrorMessage` (reason → user-facing message mapping), `buildTrashWarningViewModel` (card + workspace info → dialog view model). Replaced 10-line ternary chain and inline view model construction. 11 tests.

7. **`shortcut-actions.ts`** — 2 functions from `use-shortcut-actions.ts`: `getNextShortcutLabel` (case-insensitive collision detection with suffix incrementing), `validateNewShortcut` (command + label validation with auto-dedup). Replaced `getNextShortcutLabel` callback and inline validation in `handleCreateShortcut`. 12 tests. Changed from `useCallback` to `useMemo` for `existingLabels` derivation.

**Named candidates closed out (no extraction needed):**
- **`use-board-interactions`** — Pure orchestration hub composing 7 sub-hooks with no domain logic.
- **`use-task-start`** — React refs + DOM queries + programmatic card move coordination, under threshold.

**Files changed:**
- 7 new domain modules: `notifications/audible-notifications.ts`, `debug-logging.ts`, `task-editor.ts`, `board/review-auto-actions.ts`, `terminal/shell-auto-restart.ts`, `board/linked-backlog-task-actions.ts`, `shortcut-actions.ts`
- 7 new domain test files (119 tests total)
- 7 hook files updated to import from domain modules
- `docs/web-ui-conventions.md` — added 7 rows to domain modules reference table (now 16 total)
- `docs/todo.md` — updated Phase 2 counts
- `CHANGELOG.md` — added entry under [Unreleased]

## Refactor: split linked backlog task actions test file (2026-04-16)

**Problem:** `use-linked-backlog-task-actions.test.tsx` was 1,096 lines — the largest test file in `web-ui/src/hooks/board/`. Three distinct test groups (core actions, trash confirmation dialog, worktree notice toast) were interleaved in a single `describe` block sharing ~160 lines of boilerplate (mocks, factories, harness component, setup/teardown).

**Fix:** Extracted the shared infrastructure into `linked-backlog-actions-test-harness.tsx` (183 lines) exporting `createTask`, `createBoard`, `requireSnapshot`, `createDeferred`, `HookHarness`, `HookHarnessProps`, `HookSnapshot`, `Deferred`, `RequestMoveTaskToTrashOptions`, and `useTestEnvironment`. Split the tests into three focused files by `describe` group:

- `use-linked-backlog-task-actions.test.tsx` (265 lines) — 6 core action tests (dependency creation, auto-start linked tasks, animated starts, session stop on trash, direct trash via request handler, animation queuing)
- `use-linked-backlog-trash-confirmation.test.tsx` (321 lines) — 7 trash confirmation dialog tests (uncommitted changes, optimistic move passthrough, skip warning, zero/null/missing changedFiles, optimistic selection update)
- `use-linked-backlog-worktree-notice.test.tsx` (385 lines) — 9 worktree notice toast tests (column-aware show/hide, prop transitions, dismiss lifecycle, dialog suppression)

Each new file imports from the harness and declares its own `vi.mock` calls and `vi.hoisted` mock refs where needed (the `sonner` and `workspace-metadata-store` mocks are only used by the confirmation and notice files, not the core actions file).

**Files:**
- `web-ui/src/hooks/board/linked-backlog-actions-test-harness.tsx` — new shared harness
- `web-ui/src/hooks/board/use-linked-backlog-task-actions.test.tsx` — rewritten (core actions only)
- `web-ui/src/hooks/board/use-linked-backlog-trash-confirmation.test.tsx` — new (confirmation dialog tests)
- `web-ui/src/hooks/board/use-linked-backlog-worktree-notice.test.tsx` — new (worktree notice tests)

## Refactor: split runtime-state-stream integration tests (2026-04-16)

**Problem:** `test/integration/runtime-state-stream.integration.test.ts` was 1,126 lines — a single `describe.sequential` block containing 9 tests covering project discovery, project management, state streaming, hooks, metadata, worktree preservation, and server restart behavior. Too large to navigate and a merge-conflict magnet.

**What changed:** Split into 4 focused test files, each under 500 lines:

1. **`project-discovery.integration.test.ts`** (185 lines, 3 tests) — startup scenarios: no-git directory, home directory launch, first indexed project fallback.
2. **`project-management.integration.test.ts`** (189 lines, 2 tests) — git init confirmation for non-git projects, active project removal with fallback.
3. **`state-streaming.integration.test.ts`** (360 lines, 3 tests) — per-project snapshot isolation, hook review event streaming, workspace metadata updates.
4. **`server-restart.integration.test.ts`** (375 lines, 3 tests) — worktree preservation on base ref advance, review card persistence across restart, skip-shutdown-cleanup flag.

Extracted `createBoard` and `createReviewBoard` helpers into `test/utilities/board-factory.ts` (68 lines) — both functions were duplicated inline in the original file and are now shared.

**Files:**
- Deleted: `test/integration/runtime-state-stream.integration.test.ts`
- New: `test/integration/project-discovery.integration.test.ts`, `test/integration/project-management.integration.test.ts`, `test/integration/state-streaming.integration.test.ts`, `test/integration/server-restart.integration.test.ts`, `test/utilities/board-factory.ts`

## Fix: Windows compatibility — path resolution and signal handling (2026-04-16)

**Problem 1 — `startsWith("/")` for absolute path detection:** Two places used `startsWith("/")` to check if a path is absolute: `git-conflict.ts:55` (resolving the git dir from `git rev-parse --git-dir`) and `state-backup.ts:109` (resolving a backup path-or-name argument). On Windows, absolute paths start with a drive letter (e.g., `C:\`), so these checks would treat Windows absolute paths as relative, producing malformed double-rooted paths like `C:\repo\C:\actual\path`.

**Fix:** Replaced both with `path.isAbsolute()`, which handles Unix `/...` and Windows `C:\...` paths. On Unix/macOS, `path.posix.isAbsolute` is functionally identical to `startsWith("/")` — zero behavioral change on existing platforms.

**Problem 2 — SIGHUP on parent disconnect crashes on Windows:** `cli.ts:629` sends `process.kill(process.pid, "SIGHUP")` when stdin closes (parent process died). SIGHUP is not a valid Windows signal — `process.kill` throws `ERR_UNKNOWN_SIGNAL` with no surrounding try/catch. Additionally, the graceful shutdown handler at `graceful-shutdown.ts:199` already filters SIGHUP out on Windows, so even if it were deliverable, no handler would catch it.

**Fix:** Platform-conditional signal: `process.platform === "win32" ? "SIGTERM" : "SIGHUP"`. SIGTERM is in the Windows-filtered signal set and triggers the same graceful shutdown path. Exit code changes from 129 (SIGHUP) to 143 (SIGTERM) on Windows only — no caller inspects this programmatically.

**Also added** a `TODO(windows)` comment at `session-manager.ts:654` documenting that `sendSignal("SIGWINCH")` is a silent no-op on Windows (the catch block in `pty-session.ts:147` swallows the error). TUI agents won't force-redraw on task switch when dimensions are unchanged. A resize-nudge workaround is noted but needs ConPTY testing.

**Files:**
- `src/workspace/git-conflict.ts` — `startsWith("/")` → `isAbsolute()` (L2, L55)
- `src/state/state-backup.ts` — `startsWith("/")` → `isAbsolute()` (L17, L109)
- `src/cli.ts` — platform-guarded signal on parent disconnect (L629)
- `src/terminal/session-manager.ts` — added TODO(windows) comment for SIGWINCH (L654-656)

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

## Refactor: split terminal-pool test file (2026-04-16)

**Problem:** `web-ui/src/terminal/terminal-pool.test.ts` was 1,002 lines — well above the sub-500-line target for test files. A single file covered pool acquisition, lifecycle management (warmup, eviction, rotation), and dedicated terminal CRUD, making it hard to navigate and slow to reason about which tests cover which behavior.

**What changed:** Split into three files organized by domain:

1. **`terminal-pool-acquire.test.ts`** (412 lines) — `acquireForTask`, `releaseTask`, `getSlotForTask`, `releaseAll`, `disconnectFromTask` on release. These are the core slot acquisition and release tests.
2. **`terminal-pool-lifecycle.test.ts`** (456 lines) — `initPool`, `warmup`, `cancelWarmup`, eviction timeout clearing, rotation (FREE slot replacement, skip-when-full, dispose-before-create ordering), `attachPoolContainer`/`detachPoolContainer`. These cover the pool's background lifecycle management.
3. **`terminal-pool-dedicated.test.ts`** (347 lines) — `isDedicatedTerminalTaskId`, `ensureDedicatedTerminal`, `disposeDedicatedTerminal`, `disposeAllDedicatedTerminalsForWorkspace`, `writeToTerminalBuffer`, `isTerminalSessionRunning`. These cover the dedicated terminal subsystem that lives outside the pool.

The `MockSlot` factory (~100 lines) is duplicated in each file because vitest hoists `vi.mock()` calls to module scope — shared mock modules can't be imported before the hoisted mock registration.

All 42 original tests preserved and passing. No behavioral changes.

**Files:**
- Deleted: `web-ui/src/terminal/terminal-pool.test.ts`
- New: `web-ui/src/terminal/terminal-pool-acquire.test.ts`, `web-ui/src/terminal/terminal-pool-lifecycle.test.ts`, `web-ui/src/terminal/terminal-pool-dedicated.test.ts`

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
