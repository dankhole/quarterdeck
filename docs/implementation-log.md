# Implementation Log

Detailed implementation notes for completed features and fixes. Listed in reverse chronological order. Each entry records what changed, why, and what files were touched — useful for understanding past decisions and debugging regressions.

For the concise, user-facing summary of each release, see [CHANGELOG.md](../CHANGELOG.md).

## Fix: file browser shows deleted files (2026-04-10)

**Problem**: The file browser and file search used `git ls-files --cached --others --exclude-standard` to build the file tree. The `--cached` flag lists all files in the git index, which includes files that were deleted from the working tree but not yet committed. Agents that delete files would leave ghost entries in the file browser.

**Root cause**: `parsePorcelainChangedPaths` already ran `git status --porcelain=v1` but only extracted changed paths for sort-priority boosting — it didn't distinguish deleted files from other changes, so they were never filtered from the file list.

**Fix**: Renamed `parsePorcelainChangedPaths` to `parsePorcelainStatus` and split the return into `changed` and `deleted` sets (mutually exclusive — `D` in either porcelain column routes to `deleted`, everything else to `changed`). `loadFileIndex` now filters `deleted` paths from the `ls-files` output before caching. Also consolidated two separate cache-lookup functions (`getCachedFileIndex`/`getCachedChangedPaths`) into a single inline check, and removed `deletedPaths` from the return type since it's only needed internally for filtering.

**Files**: `src/workspace/search-workspace-files.ts`

**Commit**: `82a35561`

## Fix: always open to agent view when selecting a task from home (2026-04-10)

**Problem**: Clicking a task card from the home board restored the last active task tab from localStorage (`lastTaskTab`). If the user's last tab was "files," the file browser would open instead of the agent terminal — unintuitive when you want to see agent output first.

**Fix**: In the `useCardDetailLayout` effect that auto-switches tabs on task selection, changed the `currentTab === "home" || currentTab === null` branch to always set `activeTab` to `null` (collapsed side panel, agent terminal full-width) instead of restoring `lastTaskTab`. Task-to-task switching is unaffected — it stays on whatever tab was already open. Removed the now-unused `lastTaskTabRef`.

**Files**: `web-ui/src/resize/use-card-detail-layout.ts`

**Commit**: `329a66c0`

## Fix: file browser folders start collapsed by default (2026-04-10)

**Problem**: The file browser tree panel auto-expanded directories to depth 2 on initial load, which was noisy for worktrees with many top-level directories.

**Fix**: Changed `INITIAL_EXPANSION_DEPTH` from `2` to `0`. The `collectDirectoryPaths(tree, 0)` call now returns an empty set on initialization, so all folders start collapsed. Search-triggered expansion (fully opens tree while filtering) and expand/collapse-all buttons are unaffected.

**Files**: `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx`

**Commit**: `819ee36c`

## Config field registry — single source of truth for settings (2026-04-10)

**Problem**: Adding a new boolean config setting (like `behindBaseIndicatorEnabled`) required threading the field through ~12 files and ~44 individual code locations: type definitions, normalization, serialization, merge logic, dirty checks, Zod schemas, test fixtures, and frontend type signatures. The earlier `config-defaults.ts` refactor (commit `f0c85b32`) centralized default *values* but didn't address the structural duplication.

**Fix**: Created `src/config/global-config-fields.ts` with a field registry pattern. Each "regular" field (booleans, numbers, poll intervals, volume) is defined once with its default and normalizer. Generic helpers (`normalizeGlobalConfigFields`, `buildSparseGlobalConfigPayload`, `mergeGlobalConfigFields`, `hasGlobalConfigFieldChanges`, `extractGlobalConfigFields`) replace the per-field boilerplate in runtime-config.ts. Special fields with custom logic (selectedAgentId, selectedShortcutLabel, audibleNotificationEvents, promptShortcuts, prompt templates) retain explicit handling. `config-defaults.ts` now derives `CONFIG_DEFAULTS` from the registry via `getGlobalConfigDefaults()`. `agent-registry.ts` uses `extractGlobalConfigFields` spread instead of per-field mapping.

**Result**: runtime-config.ts reduced from 1167 to 683 lines (42% smaller). Adding a new boolean setting now requires: 1 line in the field registry, 2 lines in api-contract.ts Zod schemas, UI toggle, and consumption. The normalize/serialize/merge/dirty plumbing is automatic.

**Files**: `src/config/global-config-fields.ts` (new), `src/config/config-defaults.ts`, `src/config/runtime-config.ts`, `src/terminal/agent-registry.ts`

**Commit**: `5afb2a91`

## Configurable behind-base indicator on Files tab (2026-04-10)

**Problem**: The blue badge on the Files toolbar icon (indicating the base branch advanced since the task branched off) was always on with no way to disable it. Unlike the Changes tab badge which has `unmergedChangesIndicatorEnabled`, the Files tab badge had no corresponding setting.

**Fix**: Added `behindBaseIndicatorEnabled` (default: `true`) following the same config pipeline pattern as `unmergedChangesIndicatorEnabled`. The setting gates the `isBehindBase` prop passed to `DetailToolbar` in `App.tsx`. A toggle was added to the Settings dialog under the existing "Changes" section.

**Files**: `src/config/config-defaults.ts`, `src/config/runtime-config.ts`, `src/core/api-contract.ts`, `src/terminal/agent-registry.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/runtime/runtime-config-query.ts`, `web-ui/src/runtime/use-runtime-config.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`, `test/runtime/config/runtime-config.test.ts`

**Commit**: `f94cf563`

## Fix diff tab badge false positive when worktree is only behind base (2026-04-09)

**Problem**: The blue "unmerged changes" notification badge on the Changes toolbar tab appeared when a task worktree was behind its base ref (i.e. `main` had advanced), even though the worktree itself had no new code changes to land. This was distinct from the earlier cache-staleness fix (commit `9d4eb8c9`) — even with correct cache invalidation, the underlying diff command produced a false positive.

**Root cause**: The unmerged-changes check used `git diff --quiet baseRef HEAD` (two-dot), which is a symmetric tree comparison. It flags any difference between the two trees — including changes on the baseRef side that the worktree hasn't merged yet. For a worktree that's only behind (baseRef advanced, no worktree commits), the two trees differ and the check incorrectly reports unmerged changes.

**Fix**: Changed to three-dot diff syntax: `git diff --quiet baseRef...HEAD`. Three-dot diff compares HEAD against the merge-base of baseRef and HEAD, so it only detects changes the worktree introduced since diverging. A worktree that's only behind (no new commits) produces an empty diff and `hasUnmergedChanges` stays false.

**Files**: `src/server/workspace-metadata-monitor.ts` (line 278 — `pathInfo.baseRef, "HEAD"` → `` `${pathInfo.baseRef}...HEAD` ``)

**Commit**: `87639770`

## Scope bar, branch selector, and context-aware file browser (2026-04-09)

**Problem**: The Files tab in the detail view was hard-coded to show the focused task's worktree. Users had no way to browse the home repo's files, view a different branch's contents, or switch a worktree's checked-out branch from the UI.

**Design**: A three-layer architecture — scope context determines *what* to show, the scope bar renders *where* you are, and the file browser derives its data source from the resolved scope.

1. **`useScopeContext` hook**: Manages a `scopeMode` state machine (`contextual` → `home` → `branch_view`). The `resolvedScope` output provides the file path, branch, and base ref for whichever context is active. Switching modes resets the file browser selection.

2. **`ScopeBar` component**: Renders in the Files tab toolbar. Shows the current context (task name + branch pill, or "Home" badge). The branch pill is a `BranchSelectorPopover` trigger that lists all worktree branches. Behind-base count is shown as a warning badge. Actions: "Switch to Home" (house icon), "Return to contextual" (when in home/branch_view mode).

3. **`useBranchActions` hook**: Orchestrates branch selection and checkout. Selecting a branch opens a read-only `branch_view` (file tree populated via `git ls-tree`, file content via `git show`). The "Checkout" button opens a `CheckoutConfirmationDialog` that warns about agent disruption. Checkout calls the existing `workspace.checkoutBranch` tRPC mutation. On success, scope returns to contextual mode. "Don't show again" preference persists to runtime config.

4. **`useFileBrowserData` hook**: Unified data source — fetches file tree from either the worktree path (for task/home scopes) or `git ls-tree` (for branch_view scope). File content similarly reads from disk or `git show` depending on scope.

5. **File browser split**: The monolithic `FileBrowserPanel` was replaced by `FileBrowserTreePanel` (tree sidebar) + `FileContentViewer` (content pane), allowing each to be independently wired to scope-derived data.

**Key fixes during development**:
- Nested Radix `asChild` bug — `Tooltip > PopoverTrigger > button` caused React to render `<button><button>`. Fixed by removing the redundant Tooltip wrapper around the popover trigger.
- Stale `performCheckout` closure — the checkout handler captured an outdated `resolvedScope` ref. Fixed by reading scope from `useBranchActions`'s own state rather than a captured closure.
- Reserved `ref` prop — React's `ref` was being used as a git ref prop name, causing silent prop forwarding issues. Renamed to `gitRef` throughout.
- Checkout from `branch_view` scope — was targeting the home repo instead of the task worktree. Fixed by using `taskId` to resolve the correct worktree path.
- Headless worktree display — detached HEAD worktrees showed "unknown" for the branch name. Now shows abbreviated commit hash via `headCommit?.substring(0, 7)`.
- Trash column was included in the worktree branch list. Added a filter to exclude trashed tasks.

**New files**: `web-ui/src/components/detail-panels/scope-bar.tsx`, `web-ui/src/components/detail-panels/branch-selector-popover.tsx`, `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx`, `web-ui/src/hooks/use-scope-context.ts`, `web-ui/src/hooks/use-branch-actions.ts`, `web-ui/src/hooks/use-file-browser-data.ts`, `docs/specs/2026-04-09-scope-bar-file-browser-rework.md`, `docs/specs/2026-04-09-scope-bar-file-browser-rework-tasks.md`, `docs/specs/2026-04-09-scope-bar-handoff.md`

**Modified files**: `web-ui/src/components/card-detail-view.tsx` (scope bar integration, file browser rewiring), `web-ui/src/App.tsx` (checkout confirmation state, skip-confirmation config props), `web-ui/src/components/detail-panels/detail-toolbar.tsx` (scope bar slot), `web-ui/src/components/runtime-settings-dialog.tsx` (checkout confirmation toggle), `web-ui/src/resize/use-card-detail-layout.ts` (files tab layout), `src/trpc/workspace-api.ts` (checkoutBranch, listBranches, gitShow, lsTree mutations/queries), `src/workspace/git-utils.ts` (checkout, ls-tree, git-show helpers), `src/config/runtime-config.ts` + `src/config/config-defaults.ts` (skip-confirmation config fields), `src/core/api-contract.ts` (new Zod schemas for checkout/branch APIs)

**Deleted files**: `web-ui/src/components/detail-panels/file-browser-panel.tsx` (replaced by split architecture)

**Commit**: `16c33bef`

## Fix stale hasUnmergedChanges badge after baseRef advances (2026-04-09)

**Problem**: The blue "unmerged changes" notification dot on the Changes toolbar tab persisted after a task branch was merged to main. Users saw the badge even when `git diff main HEAD` showed zero differences.

**Root cause**: `loadTaskWorkspaceMetadata` in the workspace metadata monitor uses a cache keyed on `probe.stateToken` (which captures the worktree's HEAD commit, branch, working-tree status, and path fingerprints). When a task branch gets merged to main, `main` advances to a new commit, but the worktree's own state is unchanged — same HEAD, same branch, same working tree. The `stateToken` matched, so the cache returned the previously computed `hasUnmergedChanges: true` without re-running `git diff --quiet main HEAD`.

**Fix**: Added a parallel `git rev-parse --verify <baseRef>` call (runs alongside the existing `probeGitWorkspaceState` — no serial latency added) and stored the resolved commit hash as `baseRefCommit` in the cache entry. The cache invalidation check now requires `current.baseRefCommit === baseRefCommit` in addition to the existing `stateToken` match. When `main` advances, `baseRefCommit` changes, the cache misses, and the diff is correctly re-evaluated.

**Files**: `src/server/workspace-metadata-monitor.ts` (added `baseRefCommit` to `CachedTaskWorkspaceMetadata`, parallel `rev-parse` in `loadTaskWorkspaceMetadata`, cache key comparison)

**Commit**: 9d4eb8c9

## Fix stuck "waiting for approval" state — 3 root causes (2026-04-09)

**Problem**: Task cards would get stuck showing "Waiting for approval" after the agent had already resumed working. Three independent root causes all presented identically, which is why previous fix attempts failed — each attempt addressed only one cause.

**Root causes identified**:
1. **RC1 — Stop hook clobbering permission metadata**: When a PermissionRequest hook fired `to_review` (transitioning to `awaiting_review`), a subsequent Stop hook on the non-transition path called `applyHookActivity` unconditionally. Stop's metadata had `hookEventName: "Stop"` which triggered `isNewEvent=true`, clearing the permission-related `notificationType` and `activityText` fields. The UI's `isApprovalState()` then returned false.
2. **RC3 — Auto-review trashing permission-waiting cards**: `use-review-auto-actions.ts` had no `isApprovalState` guard. Cards in the review column with `autoReviewEnabled=true` were trashed 500ms after arriving, even during a permission prompt.
3. **RC4 — Null-window flash**: `transitionToReview` cleared `latestHookActivity` to null before `applyHookActivity` repopulated it. This created a window where the UI briefly showed "Ready for review" before correcting to "Waiting for approval".

Natural recovery for missed `to_in_progress` hooks was also investigated (RC2) but not implemented — PostToolUse and UserPromptSubmit hooks provide natural recovery when the agent resumes after permission approval/denial. A 30s reconciliation check was prototyped but removed because it introduced new behavior (permission badge timeout) rather than purely fixing bugs.

**Implementation**:
- **Phase 1** (RC1 + RC4): Added a permission metadata guard on the non-transition path in `hooks-api.ts`. When the task is in `awaiting_review` with permission-related `latestHookActivity`, non-permission hooks skip `applyHookActivity` (but conversation summaries are still captured). Permission-on-permission is allowed through. Removed the preemptive `latestHookActivity = null` clear from `transitionToReview` — the caller's `applyHookActivity` call handles replacement atomically in the same synchronous tick. Added RC4 invariant comment.
- **Phase 3** (RC3): Added `sessions` prop to `UseReviewAutoActionsOptions`, threaded from `use-board-interactions.ts`. Added `isApprovalState(sessionsRef.current[taskId] ?? null)` guard in the evaluation loop. Uses `sessionsRef` pattern (matching existing `boardRef`) to avoid stale closures.

**Architectural decisions**:
- No third `isPermissionHookMetadata` function — incoming partial metadata is null-filled to a full `RuntimeTaskHookActivity` and passed to existing `isPermissionActivity`.
- RC2 (30s reconciliation) was designed and spec'd but intentionally omitted from the final implementation to avoid introducing new behavior. The `checkStaleAwaitingReview` function exists in the spec artifacts if needed later.

**Files**: `src/trpc/hooks-api.ts` (permission guard + null-fill pattern), `src/terminal/session-manager.ts` (removed preemptive clear, added RC4 invariant comment), `web-ui/src/hooks/use-review-auto-actions.ts` (sessions prop, sessionsRef, isApprovalState guard), `web-ui/src/hooks/use-board-interactions.ts` (thread sessions), `test/runtime/trpc/hooks-api.test.ts` (+15 tests), `test/runtime/terminal/session-manager.test.ts` (updated RC4 test), `web-ui/src/hooks/use-review-auto-actions.test.tsx` (+4 tests)

**Spec**: `docs/specs/2026-04-09-fix-stuck-approval-state.md` (3 adversarial review passes)

**Commit**: `0e94fef2`

## Dead code audit and cleanup (2026-04-09)

**Problem**: Todo #13 called for a systematic dead code sweep across the entire codebase — unused exports, orphan files, dead hooks, stale CSS, unused config fields, dead CLI paths, and leftover upstream code.

**Audit results**: The codebase was remarkably clean across most categories. All 30 custom hooks are actively used, all exports are imported, all 19 config fields are read/written, all CLI commands are reachable, and no functional kanban remnants exist. The only dead code found was:

1. `web-ui/src/components/ui/text-shimmer.tsx` — an orphan component never imported by any file. It was the sole consumer of the `motion` (Framer Motion v12) dependency, which was also removed from `web-ui/package.json`.
2. Six stale CSS classes in `globals.css` — `kb-home-layout`, `kb-status-banner`, `kb-project-count-tag`, `kb-task-preview-pane`, `kb-task-preview-text`, `kb-markdown` — all upstream kanban remnants superseded by Tailwind utilities or never wired up.

A second-pass investigation also identified unused Zod schemas in `api-contract.ts` (slash command schemas, entire chat API contract, conflict response schema) and one dead tRPC route (`workspace.getGitSummary`), but these were left for a separate cleanup pass.

**Files**: `web-ui/src/components/ui/text-shimmer.tsx` (deleted), `web-ui/package.json` (removed `motion`), `web-ui/src/styles/globals.css` (removed 6 classes)

**Commit**: `1fb0589b`

## Drag-and-drop reordering for prompt shortcuts (2026-04-09)

**Problem**: Prompt shortcuts in the editor dialog could only be added or removed — there was no way to reorder them. The order matters because the first shortcut is the default active one in the sidebar.

**Implementation**: Wrapped the shortcut list in `DragDropContext` > `Droppable` > `Draggable` from `@hello-pangea/dnd` (already used for board cards). Added a `GripVertical` drag handle to each row. The `handleDragEnd` callback splices the moved item into its new position; the reordered array is persisted on save through the existing config flow — no backend changes needed.

**Dialog centering fix**: Dragged items were offset to the right because the dialog used `transform: translate(-50%, -50%)` for centering, which creates a new CSS containing block that shifts `@hello-pangea/dnd`'s viewport-relative position calculations. Switched all dialogs (`Dialog` and `AlertDialog`) to `fixed inset-0` + `m-auto` + `height: fit-content` centering, which avoids the containing block issue. Updated the `kb-dialog-show` animation keyframes to remove the now-unnecessary `translate(-50%, -50%)`.

**Files**: `web-ui/src/components/prompt-shortcut-editor-dialog.tsx` (drag-and-drop wrapping, handle, reorder logic), `web-ui/src/components/ui/dialog.tsx` (centering fix for Dialog + AlertDialog), `web-ui/src/styles/globals.css` (animation keyframes)

**Commit**: `9b0e54b7`

## Add close button to file content viewer (2026-04-09)

**Problem**: The file browser's content viewer panel had no way to close/deselect the currently open file. Users had to select a different file or collapse the entire file browser to dismiss the preview.

**Implementation**: Added an optional `onClose` callback prop to `FileContentViewer`. When provided, renders an X button (lucide `X` icon, 13px) in the breadcrumb header bar, alongside the existing copy-path and word-wrap toggle buttons. `FileBrowserPanel` passes `onClose={() => onSelectPath(null)}`, which clears the selection — the content panel hides and the tree expands to fill the space via the existing conditional flex layout.

**Files**: `web-ui/src/components/detail-panels/file-content-viewer.tsx` (new `onClose` prop + X button), `web-ui/src/components/detail-panels/file-browser-panel.tsx` (wire `onClose`)

**Commit**: `36dbd99a`

## Remove debug logging toggle from settings, fix log panel word wrap (2026-04-09)

**Problem**: The debug logging toggle in the Settings dialog fired immediately via a dedicated tRPC call (`setDebugLogging`) without going through the save flow. This meant toggling it didn't enable the Save button, which was confusing since every other setting in the dialog requires Save. Separately, the debug log panel's flex layout with `shrink-0` on metadata columns and `truncate` on the data span caused long log entries to overflow horizontally instead of wrapping.

**Implementation**: Removed the `RadixSwitch` toggle and its `debugLoggingEnabled`/`onToggleDebugLogging` props from the settings dialog. Replaced with a static text hint reminding users of the `Cmd+Shift+D` shortcut. The shortcut already auto-enables debug logging when opening the panel (via `toggleDebugLogPanel` in `use-debug-logging.ts`), so no functionality was lost. For the width fix, added `min-w-0` and `overflow-hidden` to the panel root, added `min-w-0` to each log entry row, and replaced the separate message/data spans with a single `break-words min-w-0` span containing both.

**Files**: `web-ui/src/components/runtime-settings-dialog.tsx` (removed toggle, props, added shortcut hint), `web-ui/src/components/debug-log-panel.tsx` (word wrap fix), `web-ui/src/App.tsx` (removed prop pass-through)

**Commit**: `f0be3d62`

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
