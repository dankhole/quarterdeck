# Implementation Log

> Prior entries through 2026-04-12 in `implementation-log-through-2026-04-12.md`.

## Git view — file context menus (2026-04-13)

Added right-click context menus to file names in the diff viewer panel (file section headers) and the file tree sidebar panel. Both menus offer Copy name, Copy path, and Show in File Browser. "Show in File Browser" navigates to the file browser main view and selects the file, using the existing `navigateToFile` infrastructure from `use-git-navigation.ts`.

Extracted a shared `FileContextMenuItems` component into `context-menu-utils.tsx` (renamed from `.ts` to support JSX). It renders `ContextMenu.Content` with optional "Show in File Browser" navigation, Copy name, Copy path, and a `children` slot for extra items. Refactored `file-browser-tree-panel.tsx` to use it too (passing "Copy file contents" as a child). The commit panel was left as-is because its menu has unique leading items (Rollback, Open in Diff Viewer) that don't fit the shared pattern.

Threading: `navigateToFile` callback is passed from `App.tsx` / `card-detail-view.tsx` → `GitView` → `DiffViewerPanel` and `FileTreePanel`. Both the home-level and task-level git views receive it.

Files touched: `context-menu-utils.ts` → `context-menu-utils.tsx` (renamed + expanded), `diff-viewer-panel.tsx`, `file-tree-panel.tsx`, `file-browser-tree-panel.tsx`, `git-view.tsx`, `card-detail-view.tsx`, `App.tsx`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Top bar scope indicator (2026-04-13)

Added scope-aware visual context to the top bar, matching the pattern already used by the file browser's `ScopeBar` component. The top bar now shows a 3px colored left border (gray/blue/purple for home/task/branch_view) and, when in task scope, a truncated task title in accent blue.

**Changes:**
- `web-ui/src/components/top-bar.tsx` — added `scopeType` and `taskTitle` props, computed `border-l-3` class based on scope type, added task title `<span>` with `truncate max-w-[200px]` after the branch pill slot
- `web-ui/src/App.tsx` — passed `scopeType` (derived from `selectedCard` presence and `homeResolvedScope.type`) and `taskTitle` (from `selectedCard.card.title`) to `TopBar`

No new dependencies. Reuses existing design tokens (`border-l-accent`, `border-l-text-secondary`, `border-l-status-purple`) and the `cn` utility.

## Fix: pinned branches not shared across all branch dropdowns (2026-04-13)

The git view compare bar's two `BranchSelectorPopover` instances (source ref and target ref selectors) were not receiving `pinnedBranches` or `onTogglePinBranch` props. Branches pinned via the top bar or file browser scope bar didn't appear pinned in the compare bar, and users couldn't pin/unpin from those dropdowns.

Threaded `pinnedBranches` and `onTogglePinBranch` through `GitViewProps` → `CompareBar` → both `BranchSelectorPopover` instances. Passed the props at both `GitView` call sites: home scope in `App.tsx` and task scope in `card-detail-view.tsx`.

Files touched: `web-ui/src/components/git-view.tsx` (+14), `web-ui/src/App.tsx` (+2), `web-ui/src/components/card-detail-view.tsx` (+2).

## Refactor: split api-contract.ts into 11 domain modules (2026-04-13)

Split the 1,297-line monolithic Zod schema file into 11 focused domain files under `src/core/api/`. Motivation: AI coding agents must read the entire file to find any schema, burning ~1,300 lines of context window every time. Domain splitting gives 4–25x context reduction depending on the feature area (e.g., an agent working on git history reads ~95 lines instead of 1,297).

**File assignments:**
- `shared.ts` (93 lines) — foundational enums (`runtimeAgentIdSchema`, `runtimeBoardColumnIdSchema`, etc.), cross-cutting primitives (`runtimeTaskImageSchema`, `runtimeTaskWorkspaceInfoRequestSchema`), small standalone schemas (slash commands, shortcuts, command run, open file, debug reset)
- `board.ts` (41 lines) — `runtimeBoardCardSchema`, `runtimeBoardColumnSchema`, `runtimeBoardDependencySchema`, `runtimeBoardDataSchema`
- `workspace-files.ts` (80 lines) — file changes, search, content, list files
- `git-sync.ts` (116 lines) — repo info, sync summary/response, checkout, discard, branch CRUD, commit, discard file
- `git-merge.ts` (174 lines) — merge, conflict state/resolution/continue/abort, auto-merged files, stash operations
- `git-history.ts` (90 lines) — git log, refs, commit diff, cherry-pick
- `task-session.ts` (165 lines) — session state/mode/hooks/summary, start/stop/input, shell, migration, hook ingest
- `task-chat.ts` (88 lines) — chat messages + CRUD operations
- `config.ts` (114 lines) — agent definition, config response/save
- `workspace-state.ts` (175 lines) — workspace state/metadata, projects, worktree lifecycle
- `streams.ts` (191 lines) — state stream messages (11 variants + discriminated union), terminal WS client/server messages

**Dependency DAG (no cycles):** `shared` is the leaf (depends only on zod). `board`, `workspace-files`, `git-sync`, `git-history`, `config` depend on `shared`. `git-merge` depends on `shared` + `git-sync`. `task-session` depends on `shared`. `task-chat` depends on `shared` + `task-session`. `workspace-state` depends on `git-sync` + `git-merge` + `board` + `task-session`. `streams` depends on `workspace-state` + `task-session`.

**Backward compatibility:** `api-contract.ts` becomes `export * from "./api/index.js"` — all 42+ runtime consumers and 92 web-ui consumers resolve through the barrel chain with zero import changes. The web-ui path alias (`@runtime-contract` → `api-contract.ts`) and package export (`src/index.ts`) both work unchanged.

Files touched: 13 (1 modified, 12 new). Net change: +1,339 / −1,297 lines. All checks pass: typecheck (runtime + web-ui), lint (415 files), runtime tests (690), web-ui tests (509), production build.

## Refactor: large file decomposition — 8 modules split into focused units (2026-04-13)

Systematic decomposition of the largest files across runtime, web-ui, CLI commands, and test infrastructure. All 8 splits are pure refactors with zero behavior change — verified by full test suite (690 runtime + 509 web-ui tests passing).

**Runtime splits:**
- `src/workspace/git-sync.ts` (1,407 → ~240 lines) — extracted `git-probe.ts` (workspace probing, sync summary, untracked line counting, fingerprint-based change detection), `git-conflict.ts` (merge/rebase conflict resolution, pause-on-conflict, per-file resolution actions), `git-cherry-pick.ts` (cherry-pick via temp worktree with cleanup), `git-stash.ts` (stash/pop/apply/drop with selection support). Imports updated across 15+ consumer files in both runtime and web-ui.
- `src/trpc/workspace-api.ts` — deduplicated error factories (collapsed ~10 near-identical error response builders into shared helpers), extracted common validation patterns, reduced by ~300 lines net.
- `src/commands/task.ts` — extracted `task-board-helpers.ts` (board state queries, card lookup), `task-lifecycle-handlers.ts` (start/stop/restart/trash command handlers), `task-workspace.ts` (worktree creation and checkout).

**Web-UI splits:**
- `dependency-overlay.tsx` — extracted `dependency-geometry.ts` (SVG path calculations, control points, arrow tip rendering), `use-dependency-layout.ts` (DOM measurement, column/card rect computation), `use-side-transitions.ts` (animated opacity/scale side transitions).
- `diff-viewer-panel.tsx` — extracted `diff-split.tsx` (side-by-side diff view), `diff-unified.tsx` (unified diff view), `diff-viewer-utils.tsx` (shared line number gutter, line rendering), `use-diff-comments.ts` (comment state management), `use-diff-scroll-sync.ts` (scroll position synchronization between split panes).
- `persistent-terminal-manager.ts` — extracted `terminal-registry.ts` (terminal instance creation, disposal, lookup) and `terminal-socket-utils.ts` (WebSocket URL construction, connection lifecycle).
- `runtime-settings-dialog.tsx` — extracted `SettingsSwitch` and `SettingsCheckbox` primitives to `ui/settings-controls.tsx`, replacing ~80 inline Radix Switch/Checkbox + label compositions.

**Test infrastructure:**
- Extracted shared utilities from 6 integration test files into `test/utilities/`: `integration-server.ts` (server lifecycle), `runtime-stream-client.ts` (WebSocket stream client), `trpc-request.ts` (tRPC HTTP helper), `temp-dir.ts` (temp directory creation), `git-env.ts` (git test env setup). Net reduction of ~220 lines of duplicated setup code.

**Merge notes:** `workspace-api-dedup` and `split-git-sync` both independently extracted `resolveRepoRoot` to `git-utils.ts` — resolved by removing the duplicate definition.

Files touched: 51 files across `src/`, `web-ui/src/`, and `test/`. 28 new files created, net reduction of ~195 lines.

## Refactor: code duplication cleanup across runtime and web-ui (2026-04-13)

Systematic deduplication based on a full codebase audit. Net reduction of ~55 lines while improving maintainability.

**New shared utilities:**
- `src/fs/node-error.ts` — `isNodeError(error, code)` replaces 3 ad-hoc ENOENT checks in `locked-file-system.ts`, `lock-cleanup.ts`, `workspace-state.ts`
- `src/workspace/file-fingerprint.ts` — `FileFingerprint` interface + `buildFileFingerprints()` replaces two identical implementations in `git-sync.ts` and `get-workspace-changes.ts`
- `src/workspace/git-utils.ts` — added `resolveRepoRoot`, `countLines`, `parseNumstatTotals`, `parseNumstatLine`, `runGitSync`, `assertValidGitRef`
- `web-ui/src/utils/to-error-message.ts` — `toErrorMessage()` replaces 42 inline error extraction patterns across 18 files

**Runtime deduplication:**
- `git-sync.ts` — removed 4 local functions (countLines, parseNumstatTotals, buildPathFingerprints, resolveRepoRoot), imports from shared modules. Renamed `GitPathFingerprint` → `FileFingerprint`.
- `get-workspace-changes.ts` — removed 5 local definitions (FileFingerprint, buildFileFingerprints, toLineCount, validateRef) + consolidated 3 readDiffStat variants into 1 `readDiffNumstat`. Replaced 4 inline repo-root-resolution patterns with `resolveRepoRoot`.
- `workspace-state.ts` — removed `isNodeErrorWithCode` and `runGitCapture`, imports `isNodeError` and `runGitSync`
- `workspace-api.ts` — imports `assertValidGitRef` from `git-utils.ts` instead of `validateRef` from `get-workspace-changes.ts`

**Web-UI fixes:**
- `web-ui/src/types/board.ts` — `resolveTaskAutoReviewMode` now respects its input instead of always returning `"move_to_trash"`. `getTaskAutoReviewCancelButtonLabel` returns mode-specific labels.

**Audit doc:** `docs/code-duplication-audit.md` — 14 findings with phases 1–3 and partial 5 completed. Remaining: ConfirmationDialog wrapper (needs visual testing), cross-boundary ANSI stripping, git error formatting round-trip.

Files touched: `src/fs/node-error.ts`, `src/fs/lock-cleanup.ts`, `src/fs/locked-file-system.ts`, `src/workspace/file-fingerprint.ts`, `src/workspace/git-utils.ts`, `src/workspace/git-sync.ts`, `src/workspace/get-workspace-changes.ts`, `src/state/workspace-state.ts`, `src/trpc/workspace-api.ts`, `web-ui/src/utils/to-error-message.ts`, `web-ui/src/types/board.ts`, `web-ui/src/types/board.test.ts`, 18 web-ui hook/component files, `docs/code-duplication-audit.md`, `docs/todo.md`, `CHANGELOG.md`

## Refactor: extract 11 custom hooks from App.tsx (2026-04-13)

Extracted inline state, callbacks, and effects from `App.tsx` (1,975 → 1,774 lines) into 11 focused custom hooks. The file had accumulated ~1,360 lines of hooks/state/effects before the JSX return — much of it logically grouped but physically scattered. This follows the same extraction pattern already used by `use-board-interactions`, `use-task-sessions`, `use-task-editor`, etc.

**Extracted hooks (effect-only, no return values):**
- `use-stream-error-handler.ts` — stream error → toast notification effect (was `lastStreamErrorRef` + effect)
- `use-task-title-sync.ts` — applies WebSocket-delivered task title updates to the board
- `use-board-metadata-sync.ts` — `replaceWorkspaceMetadata` + self-heal reconciliation effects
- `use-terminal-config-sync.ts` — syncs terminal font weight and WebGL renderer to persistent manager
- `use-focused-task-notification.ts` — fire-and-forget tRPC call to notify runtime of focused task

**Extracted hooks (state + callbacks):**
- `use-git-navigation.ts` — `pendingCompareNavigation`, `pendingFileNavigation`, `openGitCompare`, `navigateToFile`, `navigateToGitView`, auto-switch effect. Note: `isGitHistoryOpen` state stays in App.tsx because `handleProjectSwitchStart` (declared before `useCardDetailLayout`) references it.
- `use-app-dialogs.ts` — `isSettingsOpen`, `settingsInitialSection`, `isClearTrashDialogOpen`, `promptShortcutEditorOpen` + their open/close handlers
- `use-migrate-task-dialog.ts` — wraps `useMigrateWorkingDirectory` + dialog confirmation state (`pendingMigrate`, `handleConfirmMigrate`, `cancelMigrate`). `serverMutationInFlightRef` stays in App.tsx as a bridge to the workspace persistence conflict handler.

**Extracted hooks (cleanup / derived state):**
- `use-project-switch-cleanup.ts` — consolidates 4 scattered effects that reset state on `isProjectSwitching` or `currentProjectId` change
- `use-escape-handler.ts` — unified Escape key handler (close git history, deselect task)
- `use-navbar-state.ts` — derives `activeWorkspacePath`, `activeWorkspaceHint`, `navbarWorkspacePath`, `navbarRuntimeHint`, `shouldHideProjectDependentTopBarActions`

**Design decisions:**
- Hook call ordering matters: `useGitNavigation` must be called after `useCardDetailLayout` (needs `setMainView`). The `navigateToGitViewRef` bridge stays in App.tsx to allow branch action hooks (declared earlier) to reference the callback.
- `isGitHistoryOpen` stays in App.tsx because `handleProjectSwitchStart` is declared before `useCardDetailLayout` and needs the setter. Extracting it would require a ref bridge — not worth the indirection.
- Config-derived one-liners (`skipTaskCheckoutConfirmation = config?.x ?? DEFAULT`) stay in App.tsx — extracting them adds indirection without reducing complexity.
- `stableCardActions`/`reactiveCardState` memos stay — they have 15+ inputs and just pass through to context providers.

**Files touched:** `web-ui/src/App.tsx` (modified), 11 new files in `web-ui/src/hooks/`.

## Refactor: extract session-manager.ts into focused modules (2026-04-13)

Decomposed the monolithic `session-manager.ts` (1,359 lines) into 6 files with clear responsibility boundaries. The class had accumulated workspace trust auto-confirm, auto-restart, reconciliation sweep, and interrupt recovery logic alongside its core session lifecycle — all loosely coupled but forced into one file.

**Extracted modules:**
- `session-manager-types.ts` (255 lines) — `ActiveProcessState`, `ProcessEntry`, `Start*Request` interfaces, clone helpers, `createActiveProcessState` factory, `teardownActiveSession`, `finalizeProcessExit`, `normalizeDimension`, merged `formatSpawnFailure`
- `session-workspace-trust.ts` (153 lines) — `processWorkspaceTrustOutput`, `trySendDeferredCodexStartupInput`, `checkAndSendDeferredCodexInput`, trust buffer constants
- `session-interrupt-recovery.ts` (70 lines) — `clearInterruptRecoveryTimer`, `detectInterruptSignal`, `scheduleInterruptRecovery`
- `session-auto-restart.ts` (95 lines) — `shouldAutoRestart`, `scheduleAutoRestart`, rate-limit constants
- `session-reconciliation-sweep.ts` (173 lines) — `reconcileSessionStates`, `applyReconciliationAction`, `createReconciliationTimer`
- `session-manager.ts` (780 lines) — core lifecycle: `startTaskSession`, `startShellSession`, `stop*`, `writeInput`, `attach`, `hydrateFromRecord`

**DRY improvements folded in:**
- Merged `formatSpawnFailure` / `formatShellSpawnFailure` into one function with `context` param
- Extracted `normalizeDimension(value, fallback)` — was duplicated inline in both start methods
- Created `createActiveProcessState` factory — shell sessions just pass `willAutoTrust: false`
- Extracted `teardownActiveSession` — shared "stop timers, kill PTY, null active, dispose mirror" block
- Extracted `finalizeProcessExit` — shared "notify listeners, extract cleanup fn, null active, resolve exits" sequence used by onExit and reconciliation dead-process recovery
- Inlined the `now()` wrapper (was just `Date.now()`)
- Extracted `handleTaskSessionOutput` and `handleTaskSessionExit` as private methods to flatten the deeply nested `onData`/`onExit` closures in `startTaskSession`

**Design decisions:**
- All extracted modules receive dependencies via callback interfaces, never a manager reference — avoids circular imports and keeps each module independently testable
- The public API (`TerminalSessionManager` class, `StartTaskSessionRequest`, `StartShellSessionRequest`) is unchanged — zero import path changes for external consumers
- The reconciliation timer lifecycle is encapsulated in a `createReconciliationTimer()` closure, replacing the `reconciliationTimer` / `repoPath` fields on the class

**Files changed:** `src/terminal/session-manager.ts`, `src/terminal/session-manager-types.ts` (new), `src/terminal/session-workspace-trust.ts` (new), `src/terminal/session-interrupt-recovery.ts` (new), `src/terminal/session-auto-restart.ts` (new), `src/terminal/session-reconciliation-sweep.ts` (new)

## Fix: terminal renders at half width after untrashing a task (2026-04-13)

When a task was untrashed (restored from trash to the review column), the terminal rendered at roughly half its container width until the user resized the browser window. The issue was specific to tasks being untrashed but could also occur on any mount where the terminal's initial geometry estimate matched the container's actual dimensions.

**Root cause**: `PersistentTerminal` creates the xterm Terminal and opens it in an offscreen parking root (a 1px × 1px hidden div) during construction. The WebGL addon initializes its canvas at that tiny size. When `mount()` later moves the host element to the real container and calls `fitAddon.fit()`, the FitAddon checks whether the proposed cols/rows differ from the terminal's current values. If they match (because `estimateTaskSessionGeometry` happened to produce the same cols as the real container), `fit()` skips `terminal.resize()` entirely — the WebGL canvas is never told to update to the new container dimensions.

The ResizeObserver on the container should catch subsequent size changes, but if the container was already at its final dimensions when the observer was set up, no change event fires.

**Fix**: Added a deferred `requestAnimationFrame` callback in `mount()` that fires when the host element moves to a new container. The callback:
1. Temporarily resizes the terminal to `cols - 1` — this forces xterm past its same-dimensions guard, triggering the WebGL renderer's `handleResize()` which properly recalculates canvas dimensions
2. Calls `forceResize()` which invalidates the resize epoch and re-runs `fitAddon.fit()`, sizing the canvas correctly for the real container and sending the authoritative dimensions to the server

The temporary `cols - 1` state is never visible (both resizes execute synchronously within the same RAF, before the browser paints) and never reaches the server (server messages are only sent via `requestResize()`, which runs after `fit()` corrects back to the real dimensions).

The RAF handle is cleaned up in `unmount()` and transitively in `dispose()`.

**Files changed**: `web-ui/src/terminal/persistent-terminal-manager.ts`

## 2026-04-13 — Fix branch ahead/behind indicators

**Problem**: The up/down arrow indicators on the `BranchPillTrigger` were always showing 0/0 even when branches were ahead of or behind origin. The UI rendering path was correct — `BranchPillTrigger` already rendered arrows when `aheadCount`/`behindCount` were non-zero, and `App.tsx` already passed `homeGitSummary?.aheadCount` and `homeGitSummary?.behindCount` to it. The issue was that the data was always 0.

**Root causes**:
1. **No upstream tracking**: Quarterdeck creates worktree branches without `--set-upstream-to`, so `git status --porcelain=v2 --branch` omits the `# branch.ab` line entirely, and `probeGitWorkspaceState` left `aheadCount`/`behindCount` at 0.
2. **Stale remote tracking refs**: No periodic `git fetch` was happening, so the local `origin/<branch>` refs were snapshots from the last manual fetch/pull/push. Even branches with upstream tracking had stale behind counts.

**Fix**:
- `src/workspace/git-sync.ts`: Added fallback in `probeGitWorkspaceState()` — when `upstreamBranch` is null and `currentBranch` is not null, computes ahead/behind via `git rev-list --left-right --count HEAD...origin/<branch>`. Reuses existing `parseAheadBehindCounts` for parsing. Silently returns 0/0 when `origin/<branch>` doesn't exist (never-pushed branch).
- `src/server/workspace-metadata-monitor.ts`: Added 60-second periodic `git fetch --all --prune` via `performRemoteFetch()` with `remoteFetchTimer`. Uses `createGitProcessEnv({ GIT_TERMINAL_PROMPT: "0" })` to prevent credential hangs. After successful fetch, invalidates `entry.homeGit.stateToken` and calls `refreshHome()` to broadcast updated counts. Also fires a non-blocking initial fetch on `connectWorkspace`. Timer follows existing pattern (setInterval + unref + in-flight boolean guard).
