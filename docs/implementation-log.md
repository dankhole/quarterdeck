# Implementation Log

> Prior entries through 2026-04-12 in `implementation-log-through-2026-04-12.md`.

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
