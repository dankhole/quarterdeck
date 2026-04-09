# Implementation Log

Detailed implementation notes for completed features and fixes. Listed in reverse chronological order. Each entry records what changed, why, and what files were touched — useful for understanding past decisions and debugging regressions.

For the concise, user-facing summary of each release, see [CHANGELOG.md](../CHANGELOG.md).

## Fix trash column sort order (2026-04-09)

**Problem**: The trash column used the same sort as active columns (in_progress, review) — newest `updatedAt` first. This put the most recently trashed item at the top, which felt inverted compared to the natural chronological list order where new items appear at the bottom.

**Implementation**: Added a `columnId === "trash"` branch in `sortColumnCards()` that sorts by `a.updatedAt - b.updatedAt` (oldest first), separate from the active column sort which uses `b.updatedAt - a.updatedAt` with pinned-first priority. Backlog continues to preserve insertion order (no sort).

**Files**: `web-ui/src/state/sort-column-cards.ts`

**Commit**: `44d40281`

## Configurable git polling with focused-task priority (2026-04-09)

**Problem**: The workspace metadata monitor polled git state for all tracked tasks every 1 second via a single `setInterval`, spawning 20+ concurrent child processes at scale (10 tasks). All tasks polled equally regardless of whether the user was looking at them. `countUntrackedAdditions` re-read every untracked file on every poll even when files hadn't changed.

**Implementation**: Split the single poll timer into three independent timers (home repo, focused task, background tasks) with configurable intervals (default 10s/2s/5s). Added `p-limit(3)` to cap concurrent git child processes. Added mtime-based cache for untracked file line counts (bounded at 2000 entries, evicts oldest on overflow). Added backpressure guards (boolean flags) on `refreshHome` and `refreshTasks` to prevent overlapping calls. New `workspace.setFocusedTask` tRPC mutation fires on task selection in the UI, triggering an immediate probe. Poll interval defaults live in `config-defaults.ts` (single source of truth) and are configurable via three numeric inputs in the Settings dialog under "Git Polling."

**Files**: `src/server/workspace-metadata-monitor.ts` (rewritten — three timers, pLimit, backpressure), `src/workspace/git-sync.ts` (mtime cache, pathFingerprints on probe), `src/config/config-defaults.ts` (poll interval defaults), `src/config/runtime-config.ts` (new fields threaded through), `src/core/api-contract.ts` (schema), `src/server/runtime-state-hub.ts` (setFocusedTask/setPollIntervals), `src/trpc/app-router.ts` (setFocusedTask mutation), `src/trpc/workspace-api.ts`, `src/trpc/runtime-api.ts` (setPollIntervals on config save), `src/server/runtime-server.ts`, `src/cli.ts` (getActivePollIntervals), `src/terminal/agent-registry.ts` (config response), `web-ui/src/App.tsx` (setFocusedTask effect), `web-ui/src/components/runtime-settings-dialog.tsx` (poll interval UI), `web-ui/src/runtime/use-runtime-config.ts`, `docs/research/fs-watch-platform-quirks.md` (new)

**Commit**: `e3b7b73f`

## Unify card action prop threading via React context (2026-04-09)

**Problem**: `BoardCard` rendered through two independent parent chains — board columns and sidebar/context panel — each threading ~15 action props differently through intermediate components. Missing props silently disabled features (e.g. migrate button missing from sidebar cards, no `onCancelAutomaticAction` in sidebar). Adding a new card action required updating every intermediate component in every path.

**Implementation**: Replaced individual prop threading with two React contexts: `StableCardActions` (memoized handler callbacks that don't change per-render — trash, start, stop, restart, etc.) and `ReactiveCardState` (per-render values — selected card ID, running sessions, automatic actions). Both board columns and sidebar panels consume from the same context provider in `App.tsx`. Extracted `sortColumnCards()` into a shared utility (`sort-column-cards.ts`) since both paths needed consistent sorting. Added `onCancelAutomaticAction` to sidebar cards which was previously missing.

**Files**: `web-ui/src/state/card-actions-context.tsx` (new), `web-ui/src/state/sort-column-cards.ts` (new), `web-ui/src/App.tsx`, `web-ui/src/components/board-column.tsx`, `web-ui/src/components/card-detail-view.tsx`, `web-ui/src/components/detail-panels/column-context-panel.tsx`, `web-ui/src/components/quarterdeck-board.tsx`

**Commit**: `59e4d6a1`

## Resume conversation on session restart (2026-04-09)

**Problem**: Clicking the restart session button started a completely fresh agent conversation, losing all prior context. The `resumeFromTrash` flag was overloaded to control both the `--continue` flag and the initial session state (awaiting_review vs in_progress), so restart couldn't resume without also forcing the card back to in_progress.

**Implementation**: Split `resumeFromTrash` into two independent flags: `resumeConversation` (controls whether `--continue` is passed to the agent CLI) and `awaitReview` (controls initial session state). Restart now sets `resumeConversation: true` while preserving the card's current column. Fixed `buildRestartRequest` in the migration path to preserve `awaitReview` for tasks in awaiting_review state. Added test coverage for restart from both in_progress and review columns.

**Files**: `src/core/api-contract.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-manager.ts`, `src/trpc/runtime-api.ts`, `web-ui/src/hooks/use-board-interactions.ts`, `web-ui/src/hooks/use-task-sessions.ts`, plus tests

**Commit**: `eaa44fc6`. Closes #15.

## Incremental expand in diff viewer (2026-04-09)

**Problem**: Collapsed context blocks in the diff viewer expanded all hidden lines at once, which was overwhelming on large diffs with hundreds of hidden lines.

**Implementation**: Cherry-picked upstream commit `56adf45a` from cline/kanban#247. Added `useIncrementalExpand` hook that tracks per-block expansion state (top/bottom offsets). `CollapsedBlockControls` component renders "show 20 more lines" buttons at the top and bottom of each collapsed block. When a block is fully expanded, the controls disappear. Includes comprehensive test suite (12 tests) covering incremental expansion, full expansion, and edge cases.

**Files**: `web-ui/src/components/shared/diff-renderer.tsx`, `web-ui/src/components/shared/diff-renderer.test.ts` (new), `web-ui/src/components/detail-panels/diff-viewer-panel.tsx`

**Commit**: `5254b4ac`

## Grey out base ref dropdown when worktree unchecked (2026-04-09)

**Fix**: The base ref branch dropdown in the create task dialog remained interactive even when "Use isolated worktree" was unchecked, which is misleading since base ref only applies to worktree-based tasks. Added a `disabled` prop conditioned on the worktree checkbox state.

**Files**: `web-ui/src/components/task-create-dialog.tsx`

**Commit**: `c82766a4`

## Fix permission notification sound playing wrong beep count (2026-04-09)

**Problem**: The browser uses a 500ms settle window to upgrade a review notification (1 beep) to a permission notification (2 beeps) based on hook activity data. `applyHookActivity` was called *after* the async checkpoint capture in `hooks-api.ts`, which runs 7+ sequential git operations and routinely exceeds 500ms. The settle window expired before activity data arrived, so permission events always played 1 beep instead of 2.

**Fix**: Moved `applyHookActivity` and `applyConversationSummaryFromMetadata` before the checkpoint capture so the browser receives permission metadata within the settle window.

**Files**: `src/trpc/hooks-api.ts`

**Commit**: `acb76de1`

## Reduce default side panel ratio (2026-04-09)

**Fix**: Default side panel ratio reduced from 25% to 15% for a less intrusive initial sidebar size. Users can still drag to resize.

**Files**: `web-ui/src/resize/use-card-detail-layout.ts`

**Commit**: `121533b7`

## Increase default prompt shortcut textarea height (2026-04-09)

**Fix**: Default prompt shortcut textarea height increased from 3 rows to 5 rows for better visibility when editing longer prompts.

**Files**: `web-ui/src/components/prompt-shortcut-editor.tsx`

**Commit**: `0d0835ec`

## Runtime debug logging system (2026-04-09)

**Problem**: Quarterdeck had no structured logging — just ad-hoc `console.*` calls with manual `[tag]` prefixes. No way to toggle debug output at runtime or see server-side logs from the browser. A transient bug where task display summaries appeared to describe a different task was nearly impossible to diagnose because the title/summary generation pipeline had no observability.

**Solution**: Built a runtime-togglable debug logging system with three layers:

1. **Server logger** (`src/core/debug-logger.ts`): `createTaggedLogger(tag)` factory returning `{ debug, info, warn, error }` methods. Module-level state tracks enabled/disabled, a 200-entry ring buffer for recent history, and a listener set for WebSocket broadcast. Zero overhead when disabled (early return before any work).

2. **WebSocket integration** (`src/server/runtime-state-hub.ts`): Subscribes to logger entries, batches them (150ms matching existing `TASK_SESSION_STREAM_BATCH_MS`), broadcasts `debug_log_batch` messages to ALL connected clients. Sends `debug_logging_state` on new connection (with recent entries from ring buffer if enabled). New `broadcastDebugLoggingState` method on `RuntimeStateHub` interface.

3. **Browser UI**: Bottom panel (`web-ui/src/components/debug-log-panel.tsx`) with level/source filters, search, auto-scroll. Toggle via Settings dialog (new Debug section) or `Cmd+Shift+D` hotkey. Hook (`web-ui/src/hooks/use-debug-logging.ts`) manages panel state, filters, and client-side entries. Client logger (`web-ui/src/utils/client-logger.ts`) mirrors server API.

**Toggle flow**: UI calls `runtime.setDebugLogging` tRPC mutation → server sets module-level boolean → broadcasts state to all clients → UI updates panel visibility. Ephemeral (in-memory only, not persisted to config).

**Instrumentation added**: `llm-client` (call start/complete/fail/rate-limit), `title-generator` (prompt snippet + result), `summary-generator` (text snippet + result), `hooks-api` (taskId + event + conversationSummaryText snippet), `app-router` `regenerateTaskTitle` and `generateDisplaySummary` mutations (taskId + source text snippet + summary count). This is the minimum needed to trace the summary-unlinking bug if it recurs.

**Files touched**:
- `src/core/debug-logger.ts` (new) — server logger module
- `src/core/api-contract.ts` — `debug_log_batch` and `debug_logging_state` message schemas added to discriminated union
- `src/server/runtime-state-hub.ts` — subscribe to logger, batch+broadcast, send state on connect, cleanup in close()
- `src/trpc/app-router.ts` — `runtime.setDebugLogging` mutation + debug instrumentation on `regenerateTaskTitle` / `generateDisplaySummary`
- `src/trpc/runtime-api.ts` — `setDebugLogging` implementation + `broadcastDebugLoggingState` dependency
- `src/server/runtime-server.ts` — wire `broadcastDebugLoggingState` into tRPC context
- `src/title/llm-client.ts` — debug logging for LLM calls
- `src/title/title-generator.ts` — debug logging for title generation
- `src/title/summary-generator.ts` — debug logging for summary generation
- `src/trpc/hooks-api.ts` — debug logging for hook ingest
- `web-ui/src/components/debug-log-panel.tsx` (new) — bottom panel component
- `web-ui/src/hooks/use-debug-logging.ts` (new) — debug logging hook
- `web-ui/src/utils/client-logger.ts` (new) — client-side logger
- `web-ui/src/runtime/use-runtime-state-stream.ts` — handle new message types, store entries (500 max)
- `web-ui/src/runtime/runtime-config-query.ts` — `setDebugLogging` tRPC client helper
- `web-ui/src/components/runtime-settings-dialog.tsx` — Debug section with toggle
- `web-ui/src/hooks/use-app-hotkeys.ts` — `Cmd+Shift+D` hotkey
- `web-ui/src/hooks/use-project-navigation.ts` — pass through debug state
- `web-ui/src/App.tsx` — wire hook, render panel, pass props to settings dialog

## Unify config save dual path and config defaults single source of truth (2026-04-09, prev todo #25 + #26)

**Problem**: Two near-identical ~100-line functions (`updateRuntimeConfig` and `updateGlobalRuntimeConfig`) in `src/config/runtime-config.ts` required 8 parallel edits per new setting (4 sites x 2 functions: nextConfig build, hasChanges check, writeRuntimeGlobalConfigFile call, createRuntimeConfigStateFromValues call). This had already caused a bug where a semicolon replaced `||` in the global path's hasChanges check, silently breaking persistence for 12 settings. Additionally, config default values were duplicated across server constants, frontend `useState()` initial values, `??` fallback coalescing in App.tsx and the settings dialog, and test fixture factories.

**Solution — #25 (dual path)**: Extracted a shared `applyConfigUpdates` internal function that contains the single canonical implementation of nextConfig assembly, hasChanges detection, global config write, conditional project config write, and state return. Both public functions became thin wrappers: `updateRuntimeConfig` loads config from disk and passes the project config path; `updateGlobalRuntimeConfig` takes in-memory state and passes `projectConfigPath: null`, then patches the returned state to preserve the original project path reference. The `projectConfigPath` parameter now drives all three concerns (shortcut update acceptance, project config file write, project shortcut equality check in hasChanges).

**Solution — #26 (defaults)**: Created `src/config/config-defaults.ts` with all `DEFAULT_*` constants extracted from `runtime-config.ts`, plus a `CONFIG_DEFAULTS` convenience object for frontend use. The frontend imports via a new `@runtime-config-defaults` path alias (added to `web-ui/tsconfig.json`, `web-ui/vite.config.ts`, and `web-ui/vitest.config.ts`). Also fixed the commit prompt template duplication — `DEFAULT_PROMPT_SHORTCUTS` now references `DEFAULT_COMMIT_PROMPT_TEMPLATE` instead of a second hardcoded copy of the same multi-line string.

**Files touched**:
- `src/config/config-defaults.ts` (new) — single source of truth for all default constants
- `src/config/runtime-config.ts` — removed inline defaults, added imports from config-defaults, extracted `applyConfigUpdates`, simplified both update functions, re-exported `DEFAULT_PROMPT_SHORTCUTS`
- `web-ui/tsconfig.json` — added `@runtime-config-defaults` path alias
- `web-ui/vite.config.ts` — added `@runtime-config-defaults` resolve alias
- `web-ui/vitest.config.ts` — added `@runtime-config-defaults` resolve alias
- `web-ui/src/App.tsx` — replaced ~10 hardcoded `?? value` fallbacks with `CONFIG_DEFAULTS.*`
- `web-ui/src/components/runtime-settings-dialog.tsx` — replaced ~30 hardcoded defaults in `useState()`, initial value derivations, and `useEffect` setters with `CONFIG_DEFAULTS.*`
- `web-ui/src/test-utils/runtime-config-factory.ts` — replaced hardcoded defaults with `CONFIG_DEFAULTS.*`

## Windows runtime compatibility fixes (2026-04-09)

**Problem**: Several runtime code paths used Unix-only constructs that would crash or silently fail on Windows — `/dev/null` paths, `process.kill(pid, 0)` liveness semantics, unsupported POSIX signals, symlinks requiring admin, unconditional chmod, case-sensitive lock ordering, and `~` tilde in display paths.

**Fixes applied** (7 total, all small targeted platform conditionals):

1. **`/dev/null` → `NUL`** (`task-worktree.ts:213`): `git diff --binary --no-index -- /dev/null <file>` fails on Windows. Changed to platform-conditional null device.
2. **`isProcessAlive` EPERM-aware** (`session-reconciliation.ts:16-28`): The catch-all `catch {}` treated EPERM (access denied, process exists) as "dead". Adopted the more robust pattern from `scripts/dogfood.mjs` — EPERM returns true (alive), ESRCH returns false (dead). This is a correctness improvement on all platforms, not just Windows.
3. **Signal registration filter** (`graceful-shutdown.ts:197-209`): SIGQUIT is unsupported on Windows (throws on listen). SIGHUP has different semantics. Both are now filtered out on `win32` before the registration loop.
4. **Symlink junction fallback** (`task-worktree.ts:33,43-47`): `fs.symlink(src, dest, "dir")` requires Developer Mode or admin on Windows. Changed to `"junction"` type for directories on `win32` — junctions work without privileges on NTFS. File symlinks still require Dev Mode but the existing error catch returns "skipped" gracefully.
5. **chmod platform guard** (`locked-file-system.ts:129,139`): `chmod(path, 0o755)` is a no-op on Windows. Both call sites now check `process.platform !== "win32"`. Currently dormant (no caller passes `executable: true`) but correct for future use.
6. **Case-insensitive lock ordering** (`locked-file-system.ts:100-107`): `localeCompare()` on lockfile paths is case-sensitive, which could cause deadlocks on Windows where `C:\Foo.lock` and `c:\foo.lock` are the same file. Sort keys are now lowercased on `win32`.
7. **Display path** (`task-worktree-path.ts:1-12`): `~/.quarterdeck/worktrees` display constant replaced with `homedir()` join on `win32`. Note: the constant and `buildTaskWorktreeDisplayPath` are currently exported but not consumed by runtime code.

**Remaining work** (dev tooling, deferred): CI Windows matrix (commented out in `test.yml`), node-pty compilation docs, Husky hook validation, build script `chmod +x`, Windows Biome/Rolldown optional deps, test fixture Unix paths. Tracked in `docs/windows-compatibility.md`.

**Files**: `src/workspace/task-worktree.ts`, `src/terminal/session-reconciliation.ts`, `src/core/graceful-shutdown.ts`, `src/fs/locked-file-system.ts`, `src/workspace/task-worktree-path.ts`, `docs/windows-compatibility.md` (updated), `docs/specs/2026-04-09-windows-runtime-compat.md` (new)

**Commit**: `f7161b04`

## Diff sidebar notification for unmerged branch changes (2026-04-09, prev todo #16)

**Feature**: Blue dot indicator on the Changes sidebar icon when a task's worktree branch has unmerged changes relative to its base ref. Uses `git diff --quiet baseRef HEAD` (content-based comparison, resilient to squash merges) polled via the existing `WorkspaceMetadataMonitor`. Red dot (uncommitted changes) takes priority over blue dot (unmerged branch changes). Added a `showUnmergedChangesIndicator` setting (default on) with a toggle in the settings dialog.

**Files**: `src/core/api-contract.ts` (new field in workspace metadata), `src/server/workspace-metadata-monitor.ts` (diff polling), `src/config/runtime-config.ts` (new setting), `web-ui/src/components/detail-panels/detail-toolbar.tsx` (blue dot rendering), `web-ui/src/stores/workspace-metadata-store.ts` (expose new field), `web-ui/src/components/runtime-settings-dialog.tsx` (toggle), `web-ui/src/App.tsx`, `web-ui/src/runtime/runtime-config-query.ts`, `web-ui/src/runtime/use-runtime-config.ts`, `web-ui/src/types/board.ts`, plus test fixture updates.

**Commit**: `9e0ad14c`

## Remove OS browser notification system (2026-04-09, prev todo #1)

**Decision**: Remove entirely rather than fix. The browser `Notification` API permission flow was unreliable on macOS, the cross-tab visibility presence tracking (`tab-visibility-presence.ts`) added 115 lines of complexity for coordinating which tab "owns" notifications, and the Web Audio cue system already provided the core notification experience.

**What was removed**:
- `web-ui/src/utils/notification-permission.ts` — permission request/check helpers
- `web-ui/src/utils/notification-badge-sync.ts` — cross-tab badge coordination
- `web-ui/src/utils/tab-visibility-presence.ts` — BroadcastChannel-based tab presence tracking (+ tests)
- "Notifications" section in `runtime-settings-dialog.tsx` — permission toggle and request UI
- Notification permission auto-prompt in `use-board-interactions.ts` and `use-linked-backlog-task-actions.ts`
- `readyForReviewNotificationsEnabled` localStorage key

**What was kept**: Tab title badge count `(N)` in the document title when tasks are ready for review. `use-review-ready-notifications.ts` was simplified from 245 to 98 lines, now using a reactive `useDocumentVisibility()` hook for correct badge clearing instead of the custom presence system.

**Commit**: `3716ffcd`

## Rate limiting for background LLM calls (2026-04-08, prev todo #26)

**Problem**: Background LLM invocations (auto-generated titles, branch names, summaries) had no rate limiting. A bug or rapid state transitions could fire dozens of API calls in seconds.

**Implementation**: Rolling-window rate limiter added directly in `src/title/llm-client.ts` at the `callLlm()` level. Two limits enforced: 5 concurrent calls and 20 per rolling minute. When either limit is hit, `callLlm()` returns `null` with a `console.warn` for observability. All callers already handle null gracefully (they were designed for LLM-not-configured scenarios), so hitting the limit degrades silently — no error toasts, just skipped generation.

**Files**: `src/title/llm-client.ts`, `test/runtime/title/llm-client.test.ts` (new)

**Commit**: `31ead959`

## Beta notice in project sidebar (2026-04-08, prev todo #27)

**Implementation**: Added a beta notice card at the bottom of `project-navigation-panel.tsx` with a "Report issue" link to GitHub issues. Replaced the dead Featurebase feedback widget that was a no-op since the Cline SDK removal in v0.2.0.

**Removed files**: `featurebase-feedback-button.tsx`, `featurebase-feedback-button.test.tsx`, `use-featurebase-feedback-widget.ts`, `use-featurebase-feedback-widget.test.tsx`

**Commit**: `0a061c42`

## File browser: preserve state between sidebar and full-size views (2026-04-08, prev todo #21)

**Problem**: Toggling the file browser between the sidebar panel and the expanded full-size view reset the tree — expanded directories collapsed, file selection cleared.

**Implementation**: Lifted `fileBrowserExpandedDirs` (Set\<string\>) and `fileBrowserHasInitializedExpansion` (boolean) from `FileBrowserTreePanel` up into `CardDetailView`. Both the sidebar and expanded views now receive these as props, so state survives the toggle. State resets per-task via the existing `selection.card.id` effect. `FileBrowserPanel` passes the lifted state through to `FileBrowserTreePanel` via new props. `FileBrowserTreePanel` changed from owning state internally to accepting it via `expandedDirs`/`onExpandedDirsChange`/`hasInitializedExpansion`/`onInitializedExpansion`.

**Files**: `card-detail-view.tsx`, `detail-panels/file-browser-panel.tsx`, `detail-panels/file-browser-tree-panel.tsx`

**Commit**: `30a320c6`

## Allow sidebar to resize past 50% (2026-04-08, prev todo #20)

**Implementation**: Single-line change in `web-ui/src/resize/use-card-detail-layout.ts` — raised the `SIDE_PANEL_RATIO_PREFERENCE` normalize clamp from `clampBetween(value, 0.14, 0.45)` to `clampBetween(value, 0.14, 0.8)`. Default ratio (0.25) and minimum (0.14) unchanged.

**Commit**: `51ced93b`

## Remove redundant X buttons from expanded views (2026-04-08, prev todo #23)

**Investigation result**: The X buttons in `DiffToolbar` and `FileBrowserToolbar` called the exact same `onToggleExpand` as the adjacent Minimize2 button — fully redundant. The X icon implied "close/dismiss" when the action was "collapse back to sidebar". Decision: remove both, the Minimize2 button is clear enough.

**Implementation**: Removed the `{isExpanded ? <Button icon={<X />} ... /> : null}` blocks from both toolbar components. Removed the `X` import from lucide-react in `card-detail-view.tsx`.

**Commit**: `cfd1cb5a`

## Hide file browser expand button when no file selected (2026-04-08, prev todo #25)

**Implementation**: Added `showExpandButton` prop (default `true`) to `FileBrowserToolbar`. The expand/minimize `<Button>` is wrapped in `{showExpandButton ? ... : null}`. At the sidebar call site, passed `showExpandButton={fileBrowserSelectedPath !== null}`. The expanded-view call site doesn't pass the prop (defaults to `true`) since the expanded view always needs the minimize button to collapse back.

**Commit**: `75798ddb`

## Restart session button delay (2026-04-08, prev todo #16, delay portion only)

**Problem**: The restart session button appeared instantly when a session entered a dead state, causing it to flash during transient states — hydration after page load, brief agent exits before auto-restart, sub-second death/resurrection cycles.

**Implementation**: Added `isRestartDelayElapsed` state to `BoardCard` with a `useEffect` that starts a 1-second `setTimeout` when `isSessionDead` becomes true and resets when it becomes false. `isSessionRestartable` now requires all three conditions: correct column, dead session, AND delay elapsed. Cleanup via `clearTimeout` in the effect return.

**Files**: `web-ui/src/components/board-card.tsx` — added `useEffect` import, `isRestartDelayElapsed` state, timer effect, updated `isSessionRestartable` expression.

**Commit**: `de3a2d3b`

## Split summary character limits (2026-04-08)

Split the LLM summary system into two separate character limits: a prompt budget (75 chars) that the LLM is instructed to stay within, and a display limit (90 chars) used for UI truncation. Previously a single limit was used for both, causing frequent mid-word truncation when the model slightly overshot. Also reduced the summary context window from 2000 to 1800 chars. Implemented as part of the broader LLM generation UI unification in `src/title/summary-generator.ts`. Commits: `1aed4b30`.

## Recommended Nerd Font installation in README (2026-04-08)

Added a setup step in the README recommending installation of a Nerd Font (specifically JetBrainsMono Nerd Font) for proper terminal icon rendering. The terminal font stack already defaulted to Nerd Font Mono / JetBrains Mono NL, but there was no guidance for users who didn't have one installed. Commit: `3e476915`.

## Rename and rebrand: kanban to quarterdeck (2026-04-05 through 2026-04-07)

The project was renamed from "kanban" to "quarterdeck" across ~120 files in a series of commits. The rename progressed in phases: first Cline SDK removal (`220353f7`, `4450beda`, `d44ef968`, `7a92ccb6`), then `.cline/` directory paths renamed to `.kanban/` (`c25a543a`), then Factory Droid agent support removed (`45eb5421`), then Sentry/PostHog/OpenTelemetry/npm auto-update stripped (`e140271a`, `98a43032`), then the beta support footer removed (`06b782fe`), then the final kanban-to-quarterdeck rename across CLI binary, package names, env vars, HTTP headers, git refs, IPC messages, localStorage keys, imports, docs, and CI (`201c30c0`). Robot icons were replaced with lucide sailboat icons (`c2f00361`). The default runtime port changed from 3484 to 3500 as part of the rename commit. Dogfood state was isolated via `KANBAN_STATE_HOME` env var so development testing on feature branches doesn't collide with real usage (`50d3ca09`). Fork attribution to kanban-org/kanban was preserved in README and docs.

## Board cards redesign (2026-04-04 through 2026-04-06)

Redesigned board cards to be scannable at a glance. Raw prompt text was replaced with a dedicated title field (`014702d4`, `f1279c2e`), colored status badges replaced the tiny 6px dot (`800ea430`), and the description expand/collapse machinery (useMeasure, useLayoutEffect, pixel-width splitting) was removed in favor of fixed-height cards. LLM-generated card titles were added via Anthropic Haiku — titles auto-generate on task creation and can be regenerated with a button; hover tooltips show the latest agent message (`6fe318e9`). Inline click-to-edit title editing with a pen icon and auto-generate button was added (`587f3003`, `8a0467c6`). Pin-to-top lets users pin cards to the top of their column, with pinned cards sorted by updatedAt among themselves (`b44a7515`). An orange "No WT" badge appears on cards running without a worktree (`a64fc77d`). In-progress and review columns now sort by most recently updated instead of creation order (`a9420d30`). Permission prompts are distinguished from ready-for-review with separate badge colors and notification labels — orange "Waiting for approval" vs blue "Ready for review" (`e5a949dc`, `937142cb`).

## File browser panel (2026-04-06)

Added a full file browser panel to the card detail view, showing the task worktree as a tree view with expand all / collapse all buttons, keyboard navigation, debounced search, and symlink traversal. The implementation started with API schemas and tRPC routes for `listFiles` and `getFileContent` (`81e40842`), then the tree panel with expand/collapse buttons (`1bd1c696`), rendering deduplication (`1636a29f`), keyboard nav and styling cleanup (`b99f03cd`), and the persisted workingDirectory model that integrated the file browser into the detail view (`74889b05`). File browser state resets on card switch via keying the panel by `selection.card.id` (`e7dc0bdf`).

## Configurable worktree and branch strategy (2026-04-05)

Added two new options to the task create dialog: a "Use isolated worktree" checkbox and a "Feature branch" checkbox with an editable name input, both persisting their last-used value via localStorage. Worktrees default to on (`a64fc77d`), and when a branch name is provided, a feature branch is created at session start. Default commit/PR prompt templates were updated to detect actual git state instead of assuming detached HEAD (`0e91377b`).

## Simplified auto-review to trash-only mode (2026-04-07)

Simplified the auto-review system from a multi-mode dropdown (commit, PR, trash) to a single checkbox for move-to-trash. The commit and PR prompt injection buttons were removed from all UI surfaces (board cards, terminal panel, column context panel, card detail view) and the prompt builder infrastructure (`git-actions` directory) was deleted. Runtime config prompt templates were removed from the API contract and settings dialog (`31a16351`).

## Diff viewer and detail toolbar improvements (2026-04-05 through 2026-04-07)

Added a branch comparison label to the diff viewer toolbar showing which branches are being compared (e.g. `feat/my-feature -> main`) with live updates via `useTaskWorkspaceInfoValue` (`f7038f4f`). An uncommitted changes indicator (red dot badge) was added to the Changes toolbar button, and the diff panel layout was swapped so the file tree appears on the left and the diff preview on the right (`172e2367`). A JetBrains-style toolbar replaced the 3-column detail layout with a 40px icon strip on the left for toggling between board and changes views (`b1b25c0e`).

## Larger, resizable task create dialog (2026-04-06)

Made the task create dialog resizable with CSS resize, larger by default (30vw x 52vh), and clamped between 20vw-90vw and 30vh-85vh. Dialog default sizing was moved from Tailwind classes to inline styles so `contentStyle` overrides cleanly via spread. Settings dialog was widened to 34vw. Task prompt textarea `minHeight` increased from 80px to 125px (`e6a772e0`). Follow-up guardrails added a 400px min-width floor and `maxWidth` on the settings dialog (`a6835337`).

## Shell terminal in detail view (2026-04-06)

Added a toggleable shell terminal to the card detail view with clear (eraser icon) and restart (rotate icon) buttons. Clear resets the terminal content; restart stops the current shell session and spawns a fresh one. The shell terminal appears as a bottom pane in both the home view and detail view (`dbf7aa47`).

## Restart session button for failed/stuck tasks (2026-04-06)

Added a restart button on board cards when an agent session is dead (idle, failed, interrupted, or errored). Clicking it stops the current session and starts a fresh one in the same worktree/CWD without `--continue`, bypassing auto-restart rate limits. Shows in both in-progress and review columns; for review cards, moves the card back to in-progress before restarting (`fc49c7f3`, `5e9bb2b2`).

## Single-writer rule for board state (2026-04-06)

Eliminated the dual-writer race between server and UI for board state. When the browser UI is connected, it is now the single writer via `saveWorkspaceState` with optimistic concurrency (`expectedRevision`). Server-side `mutateWorkspaceState` calls that ran while the UI was connected were replaced with lightweight WebSocket broadcasts — title generation broadcasts `task_title_updated` instead of writing to disk, and `deleteWorktree` no longer clears `workingDirectory` server-side. The pattern is documented in AGENTS.md (`3ef66fd1`).

## --no-optional-locks for polling git commands (2026-04-07)

Added `--no-optional-locks` flag to all polling git commands in `src/workspace/git-sync.ts` to prevent `index.lock` contention. Without this flag, concurrent git status/diff polling from the runtime could create transient lock files that blocked agent git operations (`c743a296`).

## Prefer default branch for new task base ref (2026-04-06)

New tasks now base their worktree off the project's default branch (e.g. `main`) instead of whatever branch HEAD happens to point to. Updated both the CLI `task create` command and the frontend branch options hook (`f6c1b19c`).

## Await agent process exit before worktree cleanup (2026-04-06)

When trashing a task, `stopTaskSession` previously sent SIGTERM and returned immediately. The subsequent worktree deletion could race with the agent's shutdown handler (which persists conversation state), causing `--continue` on restore to find no conversation. The trash flow now passes `waitForExit: true` to `stopTaskSession`, waiting up to 5 seconds for the agent to finish saving before removing the worktree (`5260f641`).

## Recover cards stuck in running after user interrupts (2026-04-06)

Two recovery mechanisms for cards stuck in "running" after Ctrl+C or Escape: an interrupt recovery timer (5s) detects the keypress in terminal input, suppresses auto-restart, and transitions the card to "awaiting_review" if still running after 5 seconds; a stale process watchdog (30s) polls running cards for dead PIDs and synthetically fires process exit for missed events (`ae8a8aad`).

## Preserve detail terminal session across task switches (2026-04-06)

Fixed the popup dev terminal killing and restarting the shell session when switching between tasks and returning. The selection tracking ref was unconditionally cleared on any card change; now it only clears when `selectedCard` becomes null (leaving the detail view entirely), not when switching between tasks (`7d2e85cf`).

## Clear stale hook activity on review transitions (2026-04-06)

Fixed stale "Waiting for approval" badges persisting after a task transitioned to review. The `transitionToReview` path was not clearing `latestHookActivity`, so when a `to_review` hook carried no `hookEventName`/`notificationType`, the `isNewEvent` check was false and stale permission fields leaked through. The fix clears `latestHookActivity` on review transition (`ddc0a528`).

## Prevent stale permission fields from persisting across hook events (2026-04-06)

When a new hook event arrives with a `hookEventName` or `notificationType`, event-identity fields (`activityText`, `finalMessage`, `hookEventName`, `notificationType`) are now reset instead of being carried forward from the previous activity. This fixes cards showing "Waiting for approval" after a permission prompt was approved and the agent completed normally (`28d283b5`).

## Dialog sizing guardrails (2026-04-06)

Added sizing guardrails across settings, task create, and alert dialogs. Task create dialog uses a 400px min-width floor instead of 20vw to prevent unusably narrow dialogs on small screens or manual resize-down. Settings dialog gets an explicit `maxWidth: 34vw` so the base 32rem default no longer silently clamps the intended width. Dialog component's `contentStyle` prop documented with JSDoc (`a6835337`).

## Terminal improvements: Nerd Font, font readiness, DPR, reset button (2026-04-06 through 2026-04-07)

Switched the terminal font to Nerd Font Mono variant / JetBrains Mono NL (no ligatures) for crisper rendering that matches native terminal apps (`b0383534`). Terminal `open()` is now deferred until the primary font is loaded (3s timeout fallback) so xterm measures character cells correctly (`98279309`). A `matchMedia` listener for DPR changes triggers `fitAddon.fit()` when windows move between monitors with different device pixel ratios (`b89edddb`). A reset terminal rendering button in the settings dialog disposes and recreates the WebGL addon on all terminals, giving a clean renderer with fresh texture atlas — useful as a debug escape hatch for GPU texture corruption after monitor changes (`326e183d`).

## Decouple detail sidebar from task selection (2026-04-08, prev #13)

The detail sidebar (toolbar, panels, resize layout) no longer requires a task selection to render. Refactored into an always-visible 4-tab sidebar with Board, Terminal, Changes, and Files panels. The sidebar renders independently of card selection — when no task is selected, panels show workspace-level content or empty states. This is the enabling work for the git management view and project switcher.

## Session state reconciliation for stale UI badges (2026-04-08, prev #7)

Added periodic reconciliation that polls actual agent/session state and corrects stale UI badges (permission prompts, approval indicators). A 10-second interval job compares displayed status against live session data and auto-corrects mismatches. Also removed a flawed output-after-review reconciliation that was incorrectly bouncing tasks back to running state.

## Fix: branch display desync on task cards (2026-04-08)

Fixed branch name shown on task cards getting out of sync with the actual branch. Root cause was a different precedence for the branch field vs other live metadata — prioritized live metadata from the runtime over stale persisted state.

## Fix: chunky terminal rendering on low-DPR monitors (2026-04-08)

Switched to light font weight for terminal rendering to reduce overly bold/chunky text on low-DPI displays.

## Fix: LLM display summary lost across consecutive hook events (2026-04-08)

Fixed `displaySummary` being wiped when consecutive hook events (e.g. to_review followed by stop) overwrote the task card state. The summary is now preserved across hook event processing.

## Fix: output-after-review reconciliation bouncing tasks (2026-04-08)

Removed reconciliation logic that detected terminal output after a task entered review and incorrectly moved it back to running. Terminal output (spinners, ANSI redraws) doesn't indicate the agent resumed work — the hook system is the authoritative source for state transitions.

## Chore: dead code and unused dependency cleanup (2026-04-08)

Removed dead code, unused exports, and unused dependencies across the codebase.

## Fix: slight lag on audible notifications (2026-04-08)

Settle window reduced from 1500ms to 500ms for hook-based transitions, and non-hook transitions (exit, error, attention, failed) fire immediately at 0ms. Priority-based event upgrading ensures high-priority sounds aren't delayed by lower-priority pending events.

## Fix: branch name cleared on trashed task cards (2026-04-08)

Fixed `moveTaskToColumn` to only clear `workingDirectory` (not `branch`) when trashing. Branch field is preserved through the spread operator. Dedicated test coverage added.

## Cross-workspace audible notifications (2026-04-08)

Audible notifications now fire for tasks in all projects, not just the currently viewed one. Previously, switching projects silenced notifications from the previous project. Added a `task_notification` WebSocket message type that broadcasts session summaries to all connected clients (not workspace-scoped), with a separate `notificationSessions` map on the client that persists across project switches.

## Auto-restart shell terminals on unexpected exit (2026-04-08)

Non-agent shell terminals (home and detail) now automatically restart when they exit unexpectedly (non-zero or null exit code). Entirely frontend-driven with per-terminal crash-loop rate limiting (max 3 restarts per 30s window), a 1-second restart delay, and a `shellAutoRestartEnabled` settings toggle (default: true).

## Move prompt shortcut button from task cards to TopBar (2026-04-08, #27)

Prompt shortcut split button moved from per-card rendering in `BoardCard` to a single `TopBar` instance gated on task selection. Eliminated a 6-prop threading chain through CardDetailView -> ColumnContextPanel -> ColumnSection -> BoardCard.

## Unify LLM generation UI and disabled states (2026-04-08, #20)

Standardized all LLM-powered generation features (titles, branch names, summaries) with a unified Sparkles icon, proper disabled states when LLM is not configured, and a dedicated settings section explaining the env var requirements. Split summary character limits (LLM prompt budget vs display limit) to reduce mid-word truncation.

## Shared config test fixtures (2026-04-08, #28)

Consolidated ~10 duplicated config mock factories across test files into 2 shared factory files (`test/utilities/runtime-config-factory.ts` and `web-ui/src/test-utils/runtime-config-factory.ts`). Adding a config field now touches 1-2 files instead of 12, eliminating the #1 merge conflict source.

## Configurable prompt shortcuts for review cards (2026-04-07)

Replaced hardcoded commit/PR prompt injection buttons with a user-managed shortcuts system — dropdown selector, editor dialog, and localStorage persistence. Global config with task context interpolation.

## Fix: feature branch toggle default (2026-04-08, #29)

Reset the "Use feature branch" toggle to unchecked each time the create task dialog opens.

## Fix: trash worktree notice setting not respected (2026-04-08, #25)

Fixed stale project config causing the informational toast to always show. Refresh config after dismissing the toast.

## Fix: dragging tasks out of trash restores wrong task (2026-04-08, #21)

Fixed card ID mismatch in drag-and-drop handler when columns were sorted.

## Configurable audible notifications (#14)

Web Audio API with per-event toggles (permission, review, failure, completion), volume control, and "only when tab hidden" option in settings.

## Task conversation summaries and improved title generation (#17)

Transcript parsing on Stop hook, LLM-powered display summaries (<80 chars), hover tooltips on cards, staleness-checked regeneration.

## Create task dialog: shortcut remap (#7)

Shortcuts remapped: Cmd+Enter -> Start task, Cmd+Shift+Enter -> Start and open, Cmd+Alt+Enter -> Create only.

## Remove commit and PR prompt injection buttons (#5)

Buttons removed from all UI surfaces, prompt templates removed from config. `use-git-actions.ts` and `build-task-git-action-prompt.ts` retained for auto-review path only.

## Branch persistence on cards (#3)

Cards now persist their branch name through the task lifecycle.

## Trash confirmation and worktree notice (#2)

Confirmation dialog before trashing tasks with active worktrees, plus informational toast about worktree cleanup.

## Configurable prompt shortcuts (original #16 / Quick actions menu)

User-configurable prompt shortcuts dropdown replacing the hardcoded commit/PR buttons. Dropdown in review cards with editor dialog and localStorage persistence.
