# Implementation Log

> Prior entries through 2026-04-12 in `implementation-log-through-2026-04-12.md`.

## Feature: editable worktree system prompt (2026-04-14)

The hardcoded worktree context in `worktree-context.ts` is now a user-editable template stored in global config. The default template matches the previous hardcoded text exactly, so existing behavior is preserved.

**Template system**: `buildWorktreeContextPrompt` now accepts an optional `template` parameter. When provided, it renders the template by replacing `{{cwd}}`, `{{workspace_path}}`, and `{{detached_head_note}}` placeholders with runtime values. Falls back to the built-in default when omitted (backwards compatible with all existing call sites and tests).

**Config plumbing**: Follows the `commitPromptTemplate` pattern — `worktreeSystemPromptTemplate` is a special-cased string field with a `*Default` companion for the frontend reset button. Sparse persistence only writes to `config.json` when the value differs from the default.

**Launch pipeline**: Threaded through `runtime-api.ts` → `session-manager-types.ts` → `session-manager.ts` → `agent-session-adapters.ts` → `buildWorktreeContextPrompt`. Both `startTaskSession` call sites in `runtime-api.ts` (initial start and worktree migration restart) pass the template.

**Frontend**: Added `worktreeSystemPromptTemplate` to `SettingsFormValues` and `resolveInitialValues` in `use-settings-form.ts`. The Agent section in `runtime-settings-dialog.tsx` has a collapsible "Worktree system prompt" editor with a textarea, placeholder documentation, and a "Reset to default" link (visible only when customized). Flows through the standard Save button.

**Files**: `src/prompts/prompt-templates.ts`, `src/config/config-defaults.ts`, `src/config/runtime-config.ts`, `src/core/api/config.ts`, `src/config/agent-registry.ts`, `src/terminal/worktree-context.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-manager-types.ts`, `src/terminal/session-manager.ts`, `src/trpc/runtime-api.ts`, `web-ui/src/hooks/use-settings-form.ts`, `web-ui/src/components/settings/agent-section.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/test-utils/runtime-config-factory.ts`, `test/runtime/terminal/worktree-context.test.ts`.

## Docs: todo roadmap updates (2026-04-14)

Replaced todo #1 (Go backend rewrite) with a standalone desktop app todo (Electron/Tauri). The Go rewrite was motivated by performance and single-binary distribution, but the browser-tab problem is a more pressing architectural limitation — duplicate WebSocket connections from multiple tabs, no window lifecycle control, no OS integration (notifications, deep links, system tray), and the two-process launch experience (server + open URL). The new todo captures the motivation, approach options (Electron vs Tauri), and key design decisions (sidecar vs embedded backend, multi-project windowing model).

**Files**: `docs/todo.md`

## Fix: compare/uncommitted diff tabs flashing on every poll tick (2026-04-13)

**Root cause:** The lazy diff loading commit (717c6a8d) introduced `useFileDiffContent` with a `changesGeneratedAt` cache invalidation mechanism — when the server response's `generatedAt` changes, the hook deletes the cached content, sets `isLoading: true`, and re-fetches. This works when `generatedAt` is stable across polls (as with `getWorkspaceChanges`, which has fingerprint-based caching). But `getWorkspaceChangesFromRef` had no caching — every 1s poll returned `generatedAt: Date.now()`, triggering a cache invalidation → skeleton flash → re-fetch cycle even when nothing changed. Affected the Compare tab (with "Include uncommitted" checked) and Last Turn tab during running sessions.

**Server fix** (`src/workspace/get-workspace-changes.ts`): Added fingerprint-based LRU cache to `getWorkspaceChangesFromRef`, matching the existing `getWorkspaceChanges` pattern. The cache key is `${repoRoot}::${resolvedFromHash}`, and the state key includes the resolved ref hash, tracked changes output, untracked files output, and file fingerprints (mtime/ctime/size). On cache hit, the same response object (same `generatedAt`) is returned, skipping the numstat computation.

**Frontend fix** (`web-ui/src/runtime/use-file-diff-content.ts`): Added `isBackgroundRefetchRef` — when the `changesGeneratedAt` effect triggers a refetch, it sets the ref to `true` so `fetchContent` skips the `setResult({ isLoading: true })` call. The skeleton only shows on initial load or file switch (no prior content). Stale content stays visible during the ~20ms refetch window (stale-while-revalidate).

Files: `src/workspace/get-workspace-changes.ts`, `web-ui/src/runtime/use-file-diff-content.ts`.

## Fix: top bar branch context menu missing push/pull actions (2026-04-13)

The `BranchSelectorPopover` in the top bar (`App.tsx:1098`) was not receiving `onPull` or `onPush` props, so right-clicking any branch only showed checkout, compare, merge, create, delete, pin, and copy — but not "Pull from remote" or "Push to remote". The home scope bar (`App.tsx:1476`) and card detail view (`card-detail-view.tsx:458-459`) already passed these handlers.

**Fix**: Added `onPull` and `onPush` to the top bar instance, using `runGitAction("pull"|"push", gitSyncTaskScope ?? null, branch)` — the same pattern as the adjacent fetch/pull/push icon buttons. `gitSyncTaskScope` ensures the action targets the task worktree when a task is selected, or home when nothing is selected.

**Files**: `web-ui/src/App.tsx`

## Perf: lazy diff content loading — metadata-only polling, on-demand file content (2026-04-13)

The git view tabs (Uncommitted, Last Turn, Compare) polled `getChanges` every 1 second, which loaded full file content (`oldText`/`newText` via `git show` + disk reads) for every changed file. With 20 files, that was 40-60 git process spawns per second plus large JSON payloads — the root cause of the slow loading.

**Fix: two-phase approach** — separate the file list (fast polling) from file content (on-demand for the selected file).

**Backend** (`src/workspace/get-workspace-changes.ts`):
- All three `getWorkspaceChanges*` functions now return `oldText: null, newText: null` via `buildFileMetadata()`. File stats come from batch `git diff --numstat` via `batchReadNumstat()` → `parseNumstatPerFile()` (new function in `git-utils.ts` that handles normal lines, binary files, and rename `{old => new}` paths). Untracked files still read the file for line counting but don't include content.
- New `getWorkspaceFileDiff()` loads content for a single file — reuses existing `readHeadFile`, `readFileAtRef`, `readWorkingTreeFile` helpers. Three modes: HEAD vs working tree, ref vs working tree, ref vs ref.
- `getWorkspaceChangesBetweenRefs` gained a ref-resolved LRU cache (64 entries) — resolves branch names to commit hashes via `git rev-parse` before caching so branch advances don't serve stale data.

**API** (`src/core/api/workspace-files.ts`, `src/trpc/workspace-procedures.ts`, `src/trpc/workspace-api.ts`, `src/trpc/app-router-context.ts`):
- New `getFileDiff` tRPC query with `runtimeFileDiffRequestSchema` / `runtimeFileDiffResponseSchema`. The `loadFileDiff` handler mirrors `loadChanges` for cwd/ref resolution (including `last_turn` checkpoint lookup). Path traversal guard via `validateGitPath`.

**Frontend** (`web-ui/src/runtime/use-file-diff-content.ts` [new], `web-ui/src/components/git-view.tsx`):
- `useFileDiffContent` hook fetches content for the selected file via `getFileDiff`. Content cache (`Map` keyed by `path::mode::fromRef::toRef`) makes revisiting instant. Race protection via `requestIdRef`. Cache invalidates on context change or `changesGeneratedAt` bump.
- `git-view.tsx` merges fetched content into `enrichedFiles` for `DiffViewerPanel`. `FileTreePanel` still gets metadata-only `activeFiles`.

**DiffViewerPanel** (`web-ui/src/components/detail-panels/diff-viewer-panel.tsx`):
- New `isContentLoading` prop shows skeleton bars while content loads for the selected file.

**Git history** (`web-ui/src/components/git-history-view.tsx`, `web-ui/src/components/git-history/git-commit-diff-panel.tsx`):
- `git-history-view.tsx` uses `useFileDiffContent` for working-copy view, enriches selected file in `enrichedDiffSource`.
- `git-commit-diff-panel.tsx` detects pending working-copy content via `isWorkingCopyFileContentPending()` — shows skeleton for selected file, "Select file to view diff" for others.

**Cleanup**: Removed dead `parseNumstatLine` from `git-utils.ts` (replaced by `parseNumstatPerFile`).

Files: `src/workspace/get-workspace-changes.ts`, `src/workspace/git-utils.ts`, `src/core/api/workspace-files.ts`, `src/trpc/workspace-api.ts`, `src/trpc/workspace-procedures.ts`, `src/trpc/app-router-context.ts`, `web-ui/src/runtime/use-file-diff-content.ts`, `web-ui/src/components/git-view.tsx`, `web-ui/src/components/detail-panels/diff-viewer-panel.tsx`, `web-ui/src/components/git-history-view.tsx`, `web-ui/src/components/git-history/git-commit-diff-panel.tsx`.

## Fix: restore terminal buffer on task switch, reduce spurious SIGWINCHs (2026-04-13)

**Root cause investigation:** Terminal rendering degraded while agents were active in parked terminals — status bar artifacts above the current position, off-by-one input bar. Manual resize or "re-sync terminal content" always fixed it, but task switch did not. Investigation revealed three issues:

1. The canvas repair (`repairRendererCanvas`) fixes rendering (texture atlas, canvas pixel dimensions) but not buffer content. The `forceResize()` sends a same-dimensions SIGWINCH, but TUI agents (Claude Code) treat same-dimensions SIGWINCH as a lightweight refresh — they query `TIOCGWINSZ`, see the same size, and skip the expensive tear-down/rebuild. Accumulated artifacts persist. Manual resize works because actual dimension changes trigger the full redraw path. Re-sync works because it atomically replaces the buffer from the server's headless mirror.

2. The canvas repair was RAF-deferred, causing one frame of stale rendering (wrong texture atlas, CSS-scaled canvas) between DOM move and repair.

3. The `forceResize()` on state transitions fired on every `running` ↔ `awaiting_review` transition. Each same-dimensions SIGWINCH could interrupt the agent's ink TUI mid-layout — e.g. during input prompt setup — causing off-by-one artifacts. This was intermittent and correlated with the force SIGWINCH machinery being added.

**Changes:**

- `mount()` now calls `requestRestore()` after canvas repair when the container changes. The server pauses live output, serializes the headless mirror state, and the client does `terminal.reset()` + writes the snapshot. On first mount (initial restore not yet complete) this is a no-op. (`persistent-terminal-manager.ts:714`)
- Canvas repair runs synchronously instead of in a RAF. `appendChild` updates the layout tree immediately and `fitAddon.fit()` forces synchronous reflow via `getBoundingClientRect()`. (`persistent-terminal-manager.ts:703`)
- State transition `forceResize()` now only fires when `previousState` is not `"running"` or `"awaiting_review"` — i.e. only on the first transition into an active state, not on transitions between active states. (`persistent-terminal-manager.ts:556-558`)
- Updated `docs/terminal-visual-bugs.md` with the buffer restoration analysis and marked the DPR bug as fixed.

Files: `web-ui/src/terminal/persistent-terminal-manager.ts`, `docs/terminal-visual-bugs.md`.

## Perf: commit sidebar — scoped metadata refresh, batched numstat, skip redundant probes (2026-04-13)

Three performance optimizations for the commit sidebar (closes todo #18):

**1. Scoped metadata refresh** — The biggest win. Previously, every git-only operation (commit, discard, stash) called `broadcastStateUpdate` which: built a full `RuntimeWorkspaceStateResponse` snapshot (disk I/O for board + sessions), sent it to all WebSocket clients, then called `workspaceMetadataMonitor.updateWorkspaceState` which ran `refreshWorkspace` — probing git state for the home repo AND every tracked task on the board. With N tasks, that's O(N) unnecessary git spawns per commit.

Now git-only operations call `refreshGitMetadata(scope, taskScope)` which routes to `requestTaskRefresh` (task-scoped) or `requestHomeRefresh` (home-scoped). These refresh only the affected metadata scope via the monitor's existing narrow-refresh API. The monitor's `onMetadataUpdated` callback sends `workspace_metadata_updated` to clients, which bumps `stateVersion` and triggers the file list refetch — same end result, far less work.

Added `requestHomeRefresh` to `WorkspaceMetadataMonitor` interface/impl, `RuntimeStateHub` interface/impl, and wired through `runtime-server.ts` to `workspace-api.ts` deps. Board-wide operations (checkout, merge, branch create/delete) still use the full `broadcastStateUpdate`.

Affected handlers: `commitSelectedFiles`, `discardGitChanges`, `discardFile`, `stashPush`, `stashPop`, `stashApply`, `stashDrop`.

**2. Batched numstat** — `getWorkspaceChanges` and its variants (`getWorkspaceChangesBetweenRefs`, `getWorkspaceChangesFromRef`) previously spawned a per-file `git diff --numstat HEAD -- <path>` for each changed file. With N files, that's N git process spawns. Now a single `batchDiffNumstat` call runs `git diff --numstat HEAD -- file1 file2 ...` and parses the multi-line output into a `Map<path, DiffStat>` lookup. Binary files (`-\t-\tpath`) parse to `{additions: 0, deletions: 0}`, matching prior behavior. Untracked files are excluded from the batch (they compute additions via `countLines`).

Removed the per-file `readDiffNumstat` helper and the `parseNumstatLine` import (no longer needed here — inline parsing is simpler for the batch case).

**3. Skip redundant initialSummary** — `runGitSyncAction` previously called `getGitSyncSummary` unconditionally before every git operation. This runs `probeGitWorkspaceState` (2 git commands + filesystem stats) + `git diff --numstat HEAD`. The summary was only needed for: (a) the dirty-tree guard (pull-only), and (b) `isOtherBranch` detection (needs `currentBranch` when an explicit branch is specified). For push/fetch without an explicit branch, neither applies. Now gated on `needsInitialProbe = action === "pull" || targetBranch !== null`.

**4. Commit+push path fix** — Previously fired `refreshGitMetadata` twice: once after commit (producing a transient aheadCount+1 state) and once after push. The first refresh is wasteful and could be dropped by the monitor's `homeRefreshInFlight` guard. Now refreshes once, after the push completes.

Files: `src/workspace/git-sync.ts`, `src/workspace/get-workspace-changes.ts`, `src/trpc/workspace-api.ts`, `src/server/runtime-state-hub.ts`, `src/server/workspace-metadata-monitor.ts`, `src/server/runtime-server.ts`, `test/runtime/trpc/workspace-api.test.ts`, `test/runtime/trpc/workspace-api-stash.test.ts`, `test/runtime/trpc/workspace-api-conflict.test.ts`.

## Fix: DPR change listener + remove dead scrollOnEraseInDisplay plumbing (2026-04-13)

**DPR listener fix:** The `listenForDprChange()` handler in `persistent-terminal-manager.ts` only called `requestResize()`, which sends correct dimensions to the server but doesn't invalidate xterm.js's stale glyph texture atlas. After a monitor move or zoom, text stayed blurry until the next task switch (which triggers `mount()` → `repairRendererCanvas()`). Changed the handler to call `repairRendererCanvas("dpr-change")` directly, which includes the full three-step repair: dimension bounce, `clearTextureAtlas()`, `refresh()`, plus a `forceResize()`. The `!this.visibleContainer` guard in `repairRendererCanvas` prevents work on parked terminals, and `unmount()` clears the DPR listener anyway, so the guard is belt-and-suspenders.

**scrollOnEraseInDisplay cleanup:** Removed the configurable `scrollOnEraseInDisplay` parameter from 8 files. History: it was set to `false` to prevent Claude Code's ED2 screen clears from pushing duplicate TUI frames into scrollback. That broke mouse-wheel scrolling (commit `c9f0c29a` reverted it). Since then the parameter has been `true` at every call site with no UI exposure — pure dead code. Hardcoded `true` in `terminal-options.ts` and `terminal-state-mirror.ts` to match upstream kanban.

Files: `web-ui/src/terminal/persistent-terminal-manager.ts` (DPR handler, removed constructor param, removed `setScrollOnEraseInDisplay()`, removed from `getBufferDebugInfo()`), `web-ui/src/terminal/terminal-options.ts` (removed from interface and function params), `web-ui/src/terminal/terminal-registry.ts` (removed from constructor call, cache-hit update, debug dump), `web-ui/src/terminal/use-persistent-terminal-session.ts` (removed from interface, destructuring, effect deps), `web-ui/src/components/detail-panels/agent-terminal-panel.tsx` (removed from props), `web-ui/src/components/card-detail-view.tsx` (removed prop), `src/terminal/terminal-state-mirror.ts` (removed from options interface, hardcoded `true`), `src/terminal/session-manager.ts` (removed from mirror constructor call).

## Refactor: complete code duplication cleanup — todo #24 (2026-04-13)

Closed out the final 3 items from the code duplication audit (`docs/code-duplication-audit.md`). Net reduction of ~280 lines across 19 files.

**ConfirmationDialog wrapper:** Created `web-ui/src/components/ui/confirmation-dialog.tsx` — a reusable AlertDialog-based component accepting `title`, `children`, `confirmLabel`, `confirmVariant`, `onCancel`/`onConfirm`, plus `isLoading` (shows spinner + disables) and `disabled` (disables without spinner). Includes the Radix `confirmFiredRef` double-fire guard internally so callers don't need it. Migrated 7 dialog files: `hard-delete-task-dialog`, `clear-trash-dialog`, `delete-branch-dialog`, `merge-branch-dialog`, `git-init-dialog`, `migrate-working-directory-dialog`, `task-trash-warning-dialog`. Each shrank from 57-92 lines to ~25-55 lines. Additionally replaced hand-written Tailwind button classes in `cherry-pick-confirmation-dialog.tsx` and `checkout-confirmation-dialog.tsx` with the `Button` component from `ui/button.tsx`.

**Cross-boundary ANSI stripping:** Added `@runtime-terminal-utils` path alias (in `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`) pointing to `src/terminal/output-utils.ts`. Updated `web-ui/src/terminal/terminal-prompt-heuristics.ts` to import `stripAnsi` from the alias instead of using its own regex-based `stripAnsiSequences()`. The regex implementation had a bug: its OSC pattern used `[^BEL|ESC]*` as a character class (matching individual chars B, E, L, |, S, C) instead of alternation, causing it to mishandle OSC payloads containing those characters. The runtime's state-machine implementation handles all edge cases correctly and has 12 test cases.

**Git error formatting round-trip:** Changed `runGit()` in `src/workspace/git-utils.ts` to return `stderr || message || "Unknown git error"` instead of wrapping in `"Failed to run Git Command:\n Command:\n git ... failed\n ..."`. Deleted `web-ui/src/utils/git-error.ts` (the `parseGitErrorForDisplay` regex that stripped the prefix) and its test file. Simplified `sanitizeErrorForToast()` in `app-toaster.ts` to just do truncation (removed the prefix-stripping stage). No consumer needed the verbose format — every path either stripped it (UI toasts) or passed it through (tRPC).

Files: `src/workspace/git-utils.ts`, `web-ui/src/components/ui/confirmation-dialog.tsx` (new), `web-ui/src/components/hard-delete-task-dialog.tsx`, `web-ui/src/components/clear-trash-dialog.tsx`, `web-ui/src/components/detail-panels/delete-branch-dialog.tsx`, `web-ui/src/components/detail-panels/merge-branch-dialog.tsx`, `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx`, `web-ui/src/components/git-history/cherry-pick-confirmation-dialog.tsx`, `web-ui/src/components/git-init-dialog.tsx`, `web-ui/src/components/migrate-working-directory-dialog.tsx`, `web-ui/src/components/task-trash-warning-dialog.tsx`, `web-ui/src/components/app-toaster.ts`, `web-ui/src/components/app-toaster.test.ts`, `web-ui/src/terminal/terminal-prompt-heuristics.ts`, `web-ui/src/utils/git-error.ts` (deleted), `web-ui/src/utils/git-error.test.ts` (deleted), `web-ui/tsconfig.json`, `web-ui/vite.config.ts`, `web-ui/vitest.config.ts`.

## Remove worktreeAddParentRepoDir — use git show for cross-branch file access (2026-04-13)

Removed the `worktreeAddParentRepoDir` config option entirely. This setting passed `--add-dir <parent-repo-path>` to Claude Code when launching agents in worktrees, giving agents full filesystem access to the home repo. The problem: agents could `cd` into the parent repo, and all task-scoped UI elements (status bar branch pill, card branch label, "shared" indicator) tracked the agent's actual working directory, so they'd desync and show the home repo state instead of the worktree's (todos #12, #13).

The replacement is a system prompt directive in the worktree context prompt (`worktree-context.ts`). Since git worktrees share the object database with the parent repo, agents can read any file from any branch via `git show <ref>:<path>` without leaving the worktree. The prompt now explains this with examples (`git show main:CLAUDE.md`, `git show main:docs/guide.md`) and instructs agents to prefer this over navigating to the parent directory.

The other two `--add-dir` options remain: `worktreeAddParentGitDir` (read-only git metadata access) and `worktreeAddQuarterdeckDir` (access to `~/.quarterdeck` state). The `.git` dir switch's `disabled` prop no longer depends on the removed field. The Advanced settings section description was updated accordingly.

Removed the field from: `global-config-fields.ts`, `api/config.ts` (response + save schemas), `session-manager-types.ts`, `agent-session-adapters.ts` (input type + `--add-dir` conditional), `session-manager.ts` (2 pass-through sites), `runtime-api.ts` (3 call sites), `workspace-registry.ts`, `use-settings-form.ts` (type + initializer), `general-sections.tsx` (switch + description), `runtime-config-factory.ts`, `runtime-config.test.ts` (3 test fixtures). Updated `todo.md`: removed todo #15, renumbered 16-24 → 15-21, updated #12 and #13 descriptions.

## Fix: force SIGWINCH on task switch to fix off-by-1 TUI rendering (2026-04-13)

The kernel only sends SIGWINCH when PTY dimensions actually change via the `TIOCSWINSZ` ioctl. On task switch, the client calls `forceResize()` which sends the current container dimensions to the server. If the PTY already has those dimensions (common — same container size), the ioctl is a no-op and no SIGWINCH is delivered. Claude Code doesn't redraw, leaving its TUI rendered for whatever dimensions it last drew at — producing the off-by-1 status bar, shifted input prompt, and cursor-in-bottom-left artifacts that manual window resize fixes.

Verified empirically: `pty.resize(80, 24)` on a PTY already at 80x24 produces no SIGWINCH. Only a different size triggers it.

**Fix:** Added a `force` boolean to the resize control message schema. The client sets `force: true` only from `forceResize()` (task switch, state transitions). The server checks `force && dimensionsUnchanged` and sends SIGWINCH directly via `process.kill(pid, 'SIGWINCH')`. Normal ResizeObserver resizes don't set the flag, avoiding spurious SIGWINCHs. Added `PtySession.sendSignal()` for delivering signals directly to the agent process.

Files: `src/core/api/streams.ts`, `src/terminal/pty-session.ts`, `src/terminal/session-manager.ts`, `src/terminal/terminal-session-service.ts`, `src/terminal/ws-server.ts`, `web-ui/src/terminal/persistent-terminal-manager.ts`.

## Docs: consolidated terminal architecture documentation (2026-04-13)

Replaced 5 fragmented investigation docs (written during iterative debugging) with 3 focused docs covering distinct concerns:

- `docs/terminal-visual-bugs.md` — off-by-1 root cause, canvas repair mechanics, resize epoch fix, DPR handling gap, WebGL vs canvas 2D
- `docs/terminal-scrollback-and-history.md` — how scrollback duplication occurs (ED2 mechanism + alternate screen transitions), Claude's output model (needs verification), dedup approaches (row-by-row erase, content-aware filtering)
- `docs/terminal-unfocused-task-strategy.md` — parking root resource costs, agent throttling from offscreen backpressure, visibility toggle design, IO socket management, hover prefetch idea

Old docs moved to `docs/archived/` with supersession notes. Architecture reference docs (`terminal-architecture.md`, `terminal-architecture-explained.md`) unchanged.

## Fix: truncated branch name tooltips — unreliable show/hide and missing coverage (2026-04-13)

`TruncateTooltip` (the conditional tooltip that only shows when text is CSS-truncated) used `open={isTruncated ? undefined : false}`, switching between Radix controlled mode (forced closed) and uncontrolled mode (Radix manages hover) on every render. This violates Radix's expectation that a component stays in one mode for its lifetime — when the pointer entered and `isTruncated` flipped to `true`, Radix transitioned to uncontrolled mode but had already missed the pointer-enter event, so the tooltip wouldn't show until a second hover. It could also get stuck open or flicker during rapid hovering.

Rewrote to fully controlled mode: `open={open}` state + `onOpenChange` callback that gates `nextOpen=true` on a `truncatedRef` (ref, not state — avoids unnecessary re-renders). `onPointerEnter` snapshots the truncation check into the ref before Radix's delay timer fires, so by the time `onOpenChange(true)` is called, the ref is guaranteed fresh.

Also added `TruncateTooltip` to three locations that previously had no tooltip or only a native `title` attribute for truncated branch names: board card branch labels (`board-card.tsx`), the branch pill trigger (`branch-selector-popover.tsx`), and the top bar branch button (`top-bar.tsx` — replaced native `title`).

Files: `web-ui/src/components/ui/tooltip.tsx`, `web-ui/src/components/board-card.tsx`, `web-ui/src/components/detail-panels/branch-selector-popover.tsx`, `web-ui/src/components/top-bar.tsx`.

## Feat: file browser remembers last viewed file per task (2026-04-13)

The file browser's `useFileBrowserData` hook already had a module-level `Map` (`lastSelectedPathByScope`) that remembered the last selected file per task within a session, but it was lost on page refresh. Added localStorage persistence: an IIFE at module load hydrates the Map from `quarterdeck.file-browser-last-selected-path`, and every selection change writes through to localStorage via `persistCacheToStorage()`. The scope key is the taskId (or `"__home__"` for the home view), so each task's file selection is independent. The existing stale-file validation effect (clears selection if the file no longer appears in the file list) works unchanged.

Files: `web-ui/src/hooks/use-file-browser-data.ts`, `web-ui/src/storage/local-storage-store.ts`.

## Fix: remove optimistic state transition, unblock permission approval flow (2026-04-13)

Two related state flow bugs — one caused tasks to get stuck in "running", the other in "awaiting_review".

**Bug 1 — Optimistic transition orphans tasks in running:** `writeInput` in `session-manager.ts` eagerly called `store.transitionToRunning(taskId)` on any Enter keypress (CR byte) when a non-Codex task was in `awaiting_review`. If the user typed something that didn't cause the agent to emit a `to_in_progress` hook (e.g., `/resume`, stale input, or a prompt during a permission block), the task stayed in "running" permanently — no hook arrived to move it back, and reconciliation didn't catch it because the PTY was still alive.

**Fix:** Removed the optimistic transition entirely. State transitions from `awaiting_review` to `running` are now driven exclusively by hooks (`to_in_progress` from `PostToolUse`/`UserPromptSubmit`) and the Codex `agent.prompt-ready` output detection. Removed the `canReturnToRunning` import that was only used by this block.

**Bug 2 — Permission approval stuck in review:** When Claude Code hit a permission prompt, `PermissionRequest` fired `to_review` and set `latestHookActivity` with permission metadata. After the user approved the permission (single keypress in the agent terminal), `PostToolUse` fired `to_in_progress`. But the permission-aware guard in `hooks-api.ts:194-220` blocked it because `isPermissionActivity(currentActivity)` was true and `hookEventName !== "UserPromptSubmit"`. The guard was designed to block stale `PostToolUse` from before the permission prompt, but it also blocked the legitimate one after approval. Reconciliation didn't clean it up because `checkStaleHookActivity` skips `awaiting_review` with `reviewReason === "hook"`.

**Fix:** Added a block in `writeInput` that clears `latestHookActivity` when the user sends input to a session in `awaiting_review` with active permission activity. User input to a permission prompt = permission being resolved. The stale `PostToolUse` race is still handled because the stale hook arrives before the user types anything (permission activity is still set at that point).

Files: `src/terminal/session-manager.ts`, `test/runtime/terminal/session-manager-ordering.test.ts`.

## Fix: restore agent terminal scrollback for mouse-wheel scrolling (2026-04-13)

The previous change (same day) reduced agent scrollback from 10,000 to 100 and set `scrollOnEraseInDisplay: false` to eliminate duplicate TUI frames. This had the unintended effect of killing mouse-wheel scrolling entirely — in a real terminal (e.g. Ghostty), Claude Code writes conversation history into the normal buffer via ED2 redraws, and users scroll through it with the mouse wheel. With `scrollOnEraseInDisplay: false`, that content never enters scrollback at all.

Reverted both settings to their defaults: `scrollOnEraseInDisplay: true`, `scrollback: 10_000`. This restores the scrollable history at the cost of duplicate frames from TUI redraws — the same tradeoff every terminal emulator makes. Proper deduplication would require intercepting the byte stream and diffing ED2-delimited frames, which is complex and fragile.

Files: `src/terminal/session-manager.ts`, `web-ui/src/components/card-detail-view.tsx`.

## Fix: startup session resume — stop auto-trashing, move resume to server (2026-04-13)

Three independent issues were compounding on startup: (1) `use-session-column-sync.ts` had two effects — column sync and crash recovery — and on startup `previousSessionsRef` was empty, so `previous?.state !== "interrupted"` was always true (undefined !== "interrupted"), causing all interrupted sessions to be auto-trashed before crash recovery could fire. (2) During normal operation, auto-restart raced with the UI's auto-trash — the UI saw the intermediate "interrupted" state and trashed the card before restart completed. (3) Auto-restart used `resumeConversation=false`, starting agents fresh with no context, and `awaitReview=false`, marking restarted agents as "running" even though `--continue` just opens the prompt.

**Fix:** Three layers of changes:

**State machine:** New `autorestart.denied` event transitions `interrupted → awaiting_review` with `reviewReason: "interrupted"`. No-op for any other state. This gives the server an explicit way to move interrupted sessions to review when auto-restart is denied (suppressed, rate-limited, no listeners) or fails.

**Auto-restart:** `awaitReview=true` on all restart paths (both `--continue` and fresh fallback). New `applyDenied` callback on `AutoRestartCallbacks` interface — when both restart attempts fail, the error handler fires `applyDenied()` immediately instead of relying on the 10s reconciliation sweep. `session-manager.ts` onExit handler fires `autorestart.denied` immediately when `shouldAutoRestart` returns false and the session is interrupted.

**Startup resume moved to server:** `resumeInterruptedSessions(workspaceId, workspacePath)` added to workspace registry. Loads board state, finds interrupted sessions in work columns, resolves agent config via `resolveAgentCommand`, and calls `startTaskSession(resumeConversation: true, awaitReview: true)` for each. On failure, transitions the session to `awaiting_review` with a `warningMessage` immediately. Called from `runtime-state-hub.ts` on first UI WebSocket connection per workspace (tracked via `resumeAttemptedWorkspaces` Set, cleared on workspace dispose).

**UI simplified:** `use-session-column-sync.ts` stripped from 150 lines to 77 — pure column sync only (`awaiting_review ↔ running`). Removed `isFirstSync`, `resumeAttemptedRef`, toast, async resume loop, `startTaskSession`/`stopTaskSession`/`currentProjectId` params. The hook no longer makes any session lifecycle decisions.

**Reconciliation safety net:** New `checkInterruptedNoRestart` check catches interrupted sessions with no `pendingAutoRestart` and returns `move_interrupted_to_review`, handled by applying `autorestart.denied`. Sweep filter expanded to include `"interrupted"` state.

Files: `src/server/workspace-registry.ts`, `src/server/runtime-state-hub.ts`, `src/terminal/session-auto-restart.ts`, `src/terminal/session-manager.ts`, `src/terminal/session-state-machine.ts`, `src/terminal/session-reconciliation.ts`, `src/terminal/session-reconciliation-sweep.ts`, `web-ui/src/hooks/use-session-column-sync.ts`, `web-ui/src/hooks/use-board-interactions.ts`, `test/runtime/terminal/session-reconciliation.test.ts`, `test/runtime/terminal/session-manager-auto-restart.test.ts`, `test/runtime/terminal/session-manager-interrupt-recovery.test.ts`.

## Perf: reduce agent terminal scrollback from 10,000 to 100 (2026-04-13)

Agent TUIs (Claude Code) run entirely in the alternate buffer — our normal-buffer scrollback contains only launch noise (a few lines before alternate mode, duplicate frames from screen transitions, `[quarterdeck] session exited`). We were maintaining 10,000 lines of this, serializing it into restore snapshots, and sending it over the wire on reconnect. Reduced to 100 lines (the minimum for the xterm.js 6.x circular-buffer crash workaround) on both client and server mirror. Shell terminals keep the 10,000 default.

Threaded `scrollback` as an optional parameter through the same path as `scrollOnEraseInDisplay`: `createQuarterdeckTerminalOptions` → `PersistentTerminal` constructor → `EnsurePersistentTerminalInput` → `terminal-registry` → `usePersistentTerminalSession` → `AgentTerminalPanel` → `card-detail-view.tsx` (passes `scrollback={100}` for agent terminals). Server side: `session-manager.ts` passes `scrollback: 100` to the agent `TerminalStateMirror`.

Files: `web-ui/src/terminal/terminal-options.ts`, `web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/terminal/terminal-registry.ts`, `web-ui/src/terminal/use-persistent-terminal-session.ts`, `web-ui/src/components/detail-panels/agent-terminal-panel.tsx`, `web-ui/src/components/card-detail-view.tsx`, `src/terminal/session-manager.ts`.

## Fix: terminal resize silently dropped when socket not open (2026-04-13)

`requestResize()` in `persistent-terminal-manager.ts` updated its dedup state (`lastSentCols`, `lastSentRows`, `lastSatisfiedResizeEpoch`) before calling `sendControlMessage()`. But `sendControlMessage` silently returns when the control socket isn't open (line 290). The system then thought it had sent the resize and future calls with the same dimensions hit the dedup check and returned early — leaving the PTY at stale dimensions.

This explains several long-standing symptoms: off-by-1 terminal sizing, Claude's status bar in the wrong position, Enter scrolling the status bar, cursor stuck in bottom-left. Manual window resize "fixed" it because it produced different dimensions that bypassed the dedup. The SIGWINCH hack removed in d72fedc5 had been masking this by forcing Claude to redraw on every task switch regardless.

**Fix:** Changed `sendControlMessage` to return `boolean` (true if actually sent). `requestResize` now only updates dedup state when the return value is true. Added a JSDoc comment explaining the contract so future callers don't repeat the pattern.

Files: `web-ui/src/terminal/persistent-terminal-manager.ts`.

## Fix: reset terminal rendering button was a no-op (2026-04-13)

The "Reset terminal rendering" settings button called `resetRenderer()` which did `refresh()` + `forceResize()` but was missing `clearTextureAtlas()` and the dimension bounce — the two steps that actually invalidate the WebGL texture cache. Extracted the 3-step canvas repair sequence into `repairRendererCanvas()`, used by both `mount()` (task switch) and `resetRenderer()` (settings button). Added a visibility guard so parked terminals skip the repair (the next `mount()` handles it). Added debug logging via `createClientLogger` to both repair paths and `requestRestore` bail-outs.

Files: `web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/terminal/terminal-registry.ts`.

## Fix: worktree context not propagated to subagents (2026-04-13)

Claude Code's `--append-system-prompt` flag only applies to the top-level agent session — subagents spawned via the Agent tool get their own independent system prompt and never see the worktree orientation context. This meant subagents didn't know they were in a worktree and wouldn't respect guardrails like "don't modify files outside the worktree" or "don't run destructive git operations."

Added one line to the worktree context prompt in `buildWorktreeContextPrompt()`: "When spawning subagents, include the above worktree context in their prompts." This instructs the parent agent to forward the worktree constraints when briefing subagents, rather than trying to structurally inject context (e.g. writing a CLAUDE.md into the worktree, which would pollute git diff).

Files: `src/terminal/worktree-context.ts`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Fix: behind-base indicator flaky due to shared poll lock (2026-04-13)

The behind-base indicator on task cards was unreliable — sometimes stale, sometimes flickering. Root cause: `workspace-metadata-monitor.ts` used a single `taskRefreshInFlight` boolean that was shared between the focused task poll (fast, ~2s) and the background task poll (slow, ~10s). When a background refresh was in flight (probing N tasks in parallel), the focused task's interval tick would see the guard and skip, delaying its update by up to an entire background cycle. With many tasks, this delay was long enough to be visible.

**Fix — split in-flight guards:** Replaced the single `refreshTasks(workspaceId, taskIds)` function and `taskRefreshInFlight` guard with two dedicated functions: `refreshFocusedTask` (guarded by `focusedRefreshInFlight`) and `refreshBackgroundTasks` (guarded by `backgroundRefreshInFlight`). The focused task refreshes a single task entry; the background function filters out the focused task and refreshes the rest. Neither blocks the other.

**Fix — post-fetch focused refresh:** After `performRemoteFetch` runs `git fetch --all --prune` and updates home metadata, it now fires `void refreshFocusedTask(workspaceId)` so the behind-base indicator picks up updated origin refs immediately instead of waiting for the next focused poll cycle.

**New API — `requestTaskRefresh`:** Added an imperative refresh path called after `checkoutGitBranch` and `mergeBranch` in `workspace-api.ts`. It invalidates the cached `stateToken` for the target task (so `loadTaskWorkspaceMetadata` doesn't short-circuit), then dispatches either `refreshFocusedTask` or an inline `taskProbeLimit` probe depending on whether the task is focused. This eliminates the delay between a git operation and the UI reflecting the new branch state.

Known race: if `requestTaskRefresh` fires while `refreshFocusedTask` is already in flight, the stateToken invalidation may be overwritten when the in-flight refresh completes. Documented with an inline comment — the window is narrow and the consequence is just waiting for the next poll cycle.

Files: `src/server/workspace-metadata-monitor.ts`, `src/server/runtime-state-hub.ts`, `src/server/runtime-server.ts`, `src/trpc/workspace-api.ts`, `test/runtime/trpc/workspace-api.test.ts`, `test/runtime/trpc/workspace-api-conflict.test.ts`, `test/runtime/trpc/workspace-api-stash.test.ts`.

## Feat: pull/push from remote for all local branches (2026-04-13)

Extended the branch dropdown context menu so "Pull from remote" and "Push to remote" appear on all local branches, not just the current one. Previously, the `onPull`/`onPush` callbacks were `() => void` and gated by `gitRef.name === currentBranch`. Now they accept a branch name `(branch: string) => void` and are passed to every local `BranchItem` unconditionally.

**Server-side:** Added optional `branch` field to the `runGitSyncAction` tRPC input and the underlying `git-sync.ts` function. When `branch` differs from the current branch (`isOtherBranch`), pull uses `git fetch origin <branch>:<branch>` (fast-forward update of a non-checked-out ref) and push uses `git push origin <branch>`. When `branch` is null or matches the current branch, behavior is identical to before (`git pull --ff-only` / `git push`). The dirty-tree guard correctly only applies to current-branch pulls since `fetch origin X:X` doesn't touch the working tree.

**Client-side:** `BranchSelectorPopover` props changed from `onPull?: () => void` to `onPull?: (branch: string) => void` (same for `onPush`). `BranchItem` invokes with `gitRef.name`. `useGitActions.runGitAction` gained an optional third `branch` parameter forwarded through the tRPC call. All call sites in `App.tsx` and `card-detail-view.tsx` updated to pass the branch name through.

Files: `src/workspace/git-sync.ts`, `src/trpc/workspace-procedures.ts`, `src/trpc/workspace-api.ts`, `src/trpc/app-router-context.ts`, `web-ui/src/components/detail-panels/branch-selector-popover.tsx`, `web-ui/src/hooks/use-git-actions.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/card-detail-view.tsx`.

## Fix: terminal task-switch rendering — client-side canvas fix + server resync (2026-04-13)

The previous fix (48aa0762) sent an intermediate `cols-1` resize to the server during task switch to trigger SIGWINCH, hoping the agent would redraw its TUI. This had two problems: (1) the two resizes were sent back-to-back in the same synchronous block, so the kernel coalesced the SIGWINCHs and the agent never saw a meaningful dimension change, and (2) when it did work, the agent re-output its entire TUI through the PTY stream, which xterm.js processed as new terminal output — duplicating the chat content.

**Root cause analysis:** There were actually two separate problems conflated into one fix:
1. **Canvas stale after DOM move** — when `appendChild` moves the terminal's host element between containers, the WebGL canvas dimensions and glyph texture cache become stale. This is a renderer problem requiring a renderer fix.
2. **Terminal content drift over time** — with many concurrent tasks, the xterm.js buffer can diverge from the server's headless mirror. This needs a full content resync.

**Fix for problem 1 (every task switch):** Client-side only in the mount() RAF callback: local `cols-1` bounce (forces `fitAddon.fit()` to actually call `terminal.resize()`), `clearTextureAtlas()` (regenerates WebGL glyph cache), `refresh(0, rows-1)` (repaints all rows from buffer), `forceResize()` (sends correct final dimensions to server). No intermediate resize sent to server, no SIGWINCH.

**Fix for problem 2 (on-demand):** New `request_restore` client→server WebSocket message. Server handler pauses live output (`viewerState.restoreComplete = false`), serializes the headless terminal mirror via `serializeAddon.serialize()`, sends the snapshot, client does `terminal.reset()` + `terminal.write(snapshot)` + `scrollToBottom()`, then sends `restore_complete` to resume output. Extracted duplicated snapshot-send logic into `sendRestoreSnapshot()` helper. Exposed as "Re-sync terminal content" button in Settings > Terminal via `restoreAllTerminals()` registry function.

Files: `src/core/api/streams.ts`, `src/terminal/ws-server.ts`, `web-ui/src/components/settings/display-sections.tsx`, `web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/terminal/terminal-registry.ts`.

## Fix: Shift+Enter in agent terminal triggers optimistic running transition (2026-04-13)

The optimistic running transition added in 03f08f81 ("fix: transition card to running immediately on prompt submit") checked for both CR (byte 13) and LF (byte 10) in `writeInput()`. Shift+Enter in the xterm terminal sends LF (`\n`) via the custom key event handler in `persistent-terminal-manager.ts`, which matched the LF check and moved the card from review to in_progress before the user actually submitted anything.

**Root cause:** The original commit assumed LF was equivalent to Enter for submission purposes, but in the quarterdeck terminal, LF is the Shift+Enter newline character — a multi-line editing action, not a submit.

**Fix:** Removed the `data.includes(10)` check from both the non-Codex optimistic transition and the Codex prompt-after-Enter flag. Only CR (byte 13) now triggers these code paths. Updated the test that asserted LF should trigger the transition — it now asserts the opposite.

Files: `src/terminal/session-manager.ts`, `test/runtime/terminal/session-manager-ordering.test.ts`.

## Move default base ref UX from settings to branch dropdown (2026-04-13)

Replaced the Settings > Git text input for `defaultBaseRef` with a pin icon inside the branch dropdown in the task creation dialog. The text input required users to know and type branch names — the pin icon lets them set the default right where they're already choosing branches.

**SearchSelectDropdown:** Added `renderOptionAction` render prop and `group/option` CSS class on option buttons. The action element is wrapped in a `<span>` with `stopPropagation`/`preventDefault` so clicking it doesn't trigger option selection or close the dropdown.

**BranchSelectDropdown:** New `defaultValue` and `onSetDefault` props. When `onSetDefault` is provided, each option renders a `<Pin>` icon (lucide) — filled with `fill-current` for the current default (always visible), outline with `opacity-0 group-hover/option:opacity-100` for others (hover-to-reveal). Wrapped in `<Tooltip>` for clarity.

**App.tsx:** New `handleSetDefaultBaseRef` callback does a targeted partial config save (`saveRuntimeConfig(currentProjectId, { defaultBaseRef })`) followed by `refreshRuntimeProjectConfig()` to update the pin icon state. Shows success/error toasts. Passed to both `TaskCreateDialog` and `TaskInlineCreateCard`.

**Settings cleanup:** Removed the `defaultBaseRef` text input from `GitSection` and the field from `SettingsFormValues`/`resolveInitialValues`. The config field still exists server-side — it's just managed from the dropdown now. Settings saves omit the field (it's optional in the Zod schema), so they don't clobber the pin-set value.

Files: `web-ui/src/App.tsx`, `web-ui/src/components/branch-select-dropdown.tsx`, `web-ui/src/components/search-select-dropdown.tsx`, `web-ui/src/components/settings/general-sections.tsx`, `web-ui/src/components/task-create-dialog.tsx`, `web-ui/src/components/task-inline-create-card.tsx`, `web-ui/src/hooks/use-settings-form.ts`.

## Feat: truncation-aware tooltip on branch dropdown items (2026-04-13)

Branch names in the `BranchSelectorPopover` dropdown had a native `title` attribute that was unreliable inside Radix wrappers and showed `shortName` instead of the full ref. Replaced with a new `TruncateTooltip` component that only activates when text overflows (`scrollWidth > clientWidth`), using a 150ms delay for fast scanning. Also widened the dropdown from `w-72` to `w-80`. Added optional `delayDuration` prop to the base `Tooltip` component.

Files: `web-ui/src/components/ui/tooltip.tsx`, `web-ui/src/components/detail-panels/branch-selector-popover.tsx`.

## UX: move task title to far left of top bar (2026-04-13)

Moved the task title from its previous position (after branch pill, separated by a middot) to immediately after the back arrow button — making it the first visible element in task scope. Wrapped in a `<Tooltip>` showing "Task name" on hover so the accent-colored text is self-explanatory.

Files: `web-ui/src/components/top-bar.tsx`.

## Combined feature landing: 6 branches merged (2026-04-13)

Landed 6 feature branches into main via an integration branch. All merges were clean — no conflicts.

**Refactor: move pinnedBranches to workspace directory:** Pinned branches were stored in the project's `.quarterdeck/config.json`, polluting user repos. Moved to `~/.quarterdeck/workspaces/<id>/pinned-branches.json`. Added `getWorkspacePinnedBranchesPath` helper to `workspace-state-utils.ts`. The `loadRuntimeConfig`/`updateRuntimeConfig`/`saveRuntimeConfig` functions now accept an optional `workspaceId` param for the pinned branches path. `writeRuntimeProjectConfigFile` simplified to only handle shortcuts. No migration — old entries silently ignored.
Files: `src/config/runtime-config.ts`, `src/server/workspace-registry.ts`, `src/state/workspace-state-utils.ts`, `src/trpc/runtime-api.ts`, `test/runtime/config/runtime-config.test.ts`.

**Fix: remove Open button and slim git sync buttons:** Removed the "Open in VS Code" dropdown from the top bar. Made fetch/pull/push buttons thinner (`h-6`, 24px) with smaller icons. Removed associated test expectations.
Files: `web-ui/src/App.tsx`, `web-ui/src/components/top-bar.tsx`, `web-ui/src/components/top-bar.test.tsx`.

**Feat: board sidebar needs-input badge:** Added orange badge to the Board (LayoutGrid) sidebar button when tasks in the current project need approval/input. Uses the same `isApprovalState` filter as the Projects badge but scoped to the current project via `===` instead of `!==`. Badge suppressed when no task selected (button disabled).
Files: `web-ui/src/App.tsx`, `web-ui/src/components/detail-panels/detail-toolbar.tsx`.

**Fix: settings/context-menu/diff cleanup:** (1) Removed duplicate Git Polling section from the settings dialog shell — it used bare variable names (`focusedTaskPollMs`) instead of `fields.*`, leftover from the decomposition refactor. (2) Fixed file tree directory rows suppressing native context menu — only file nodes get `ContextMenu.Root` now. (3) Moved `DiffLineGutter` and `DiffCommentCallbacks` from `diff-unified.tsx` to `diff-viewer-utils.tsx`, breaking the coupling where `diff-split` imported from `diff-unified`. (4) Unexported `CONTEXT_MENU_CONTENT_CLASS`.
Files: `context-menu-utils.tsx`, `diff-split.tsx`, `diff-unified.tsx`, `diff-viewer-utils.tsx`, `file-tree-panel.tsx`.

**Feat: worktree agent context injection:** Agents in worktrees had no awareness of isolation context — they'd try to checkout branches, cd to wrong dirs, or run destructive git ops that could wreck parallel tasks. Added `--append-system-prompt` injection to the Claude adapter when `cwd !== workspacePath`. The prompt covers: worktree identity, shell cwd reset, main repo location, parallel agent awareness, git guardrails (no checkout/push/destructive ops without explicit ask), detached HEAD note. Guarded by `hasCliOption` to avoid conflicts with explicit flags. New `worktree-context.ts` module with `buildWorktreeContextPrompt` and `readGitHeadInfo`.
Files: `src/terminal/agent-session-adapters.ts`, `src/terminal/worktree-context.ts` (new), `test/runtime/terminal/agent-session-adapters.test.ts`, `test/runtime/terminal/worktree-context.test.ts` (new).

**Feat: default base ref config:** New `defaultBaseRef` global config field. When set, always used as the initial base ref in the task creation dialog, overriding per-project "last used branch" memory. Validated against available branches — falls back to auto-detection if configured branch doesn't exist. Added to `global-config-fields.ts`, `api/config.ts`, `use-task-branch-options.ts`, `use-task-editor.ts`. *(Settings text input superseded same day — UX moved to branch dropdown pin icon, see entry above.)*
Files: `src/config/global-config-fields.ts`, `src/core/api/config.ts`, `test/runtime/config/runtime-config.test.ts`, `web-ui/src/App.tsx`, `web-ui/src/hooks/use-task-branch-options.ts`, `web-ui/src/hooks/use-task-editor.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`.

## Fix: terminal rendering artifacts and broken "Reset terminal rendering" button (2026-04-13)

Two issues in `PersistentTerminal` (`web-ui/src/terminal/persistent-terminal-manager.ts`):

**1. Agent TUI artifacts on task switch:** When switching to a previously viewed task, the terminal often showed rendering artifacts (misaligned lines, stale content from previous dimensions). Window resize fixed everything because it changed the actual PTY dimensions, triggering SIGWINCH → agent TUI redraw. The existing mount-time RAF did a `cols-1` → `cols` resize trick to force the local WebGL canvas to update, but the intermediate `cols-1` was never sent to the server. The server-side PTY dimensions never changed, so no SIGWINCH was delivered and the agent never redrew.

**Fix:** Added `this.sendControlMessage({ type: "resize", cols: cols - 1, rows })` after the local `terminal.resize(cols - 1, rows)` in the mount RAF. The server now sees `cols-1` → resizes the PTY → SIGWINCH → agent redraws. Then `forceResize()` sends the correct `cols` immediately after. The agent gets two rapid SIGWINCHs and debounces them into one redraw at the final dimensions. One extra WebSocket message per mount, dropped silently if no active session.

**2. "Reset terminal rendering" button was a no-op:** `resetRenderer()` disposed the WebGL addon and reattached it, but never told the new renderer to recalculate dimensions or repaint. When WebGL was disabled, `attachWebglAddon()` returned early and the method did literally nothing.

**Fix:** Added `terminal.refresh(0, rows - 1)` (forces repaint of all visible rows) and `forceResize()` (recalculates canvas dimensions and sends resize to server) after the addon swap. The `forceResize()` is guarded by `this.visibleContainer` to skip parked terminals.

**Files changed:** `web-ui/src/terminal/persistent-terminal-manager.ts`

## Combined feature landing: 7 branches merged (2026-04-13)

Landed 7 feature branches into main via a combined-features integration branch. One merge conflict in `runtime-settings-dialog.tsx` required manual resolution — `feat/git-action-success-toasts` diverged before the settings dialog decomposition and carried the old monolithic file, which was discarded in favor of main's decomposed structure. Also fixed a pre-existing bug where a duplicate "Git Polling" section in the dialog shell used bare variable names instead of `fields.*`, causing TypeScript errors. One integration test (`runtime-state-stream`) was updated to match the new preserve-tasks-on-shutdown behavior.

**Stalled tasks to review:** Added stalled session detection to the reconciliation sweep — sessions stuck in "running" without hook activity for 60+ seconds are marked "stalled" and shown in review with a green badge. Files: `session-state-machine.ts`, `session-reconciliation-sweep.ts`, `session-reconciliation.ts`, `task-session.ts`, `session-status.ts`.

**Preserve tasks on shutdown:** Graceful shutdown no longer trashes in-progress/review cards. Cards stay in place; sessions marked interrupted. On restart, crash-recovery auto-restart picks them up. Files: `shutdown-coordinator.ts`, `cli.ts`, `shutdown-coordinator.integration.test.ts`, `shutdown-coordinator-timeout.test.ts`.

**Pull latest context menu:** Added "Pull latest" to the right-click context menu on branch refs in git history panel and git refs sidebar. Wired through `onPullLatest` prop to `runGitAction("pull")`. Files: `git-refs-panel.tsx`, `git-history-view.tsx`, `App.tsx`.

**Diff viewer rollback:** Added "Rollback file" to the diff viewer file header context menu — restores the file to its base-ref version via `git checkout`. Only shown for modified files. Files: `diff-viewer-panel.tsx`, `git-view.tsx`.

**Git action success toasts:** Push/pull/fetch now show a brief success toast on completion. Files: `use-git-actions.ts`.

**Debug flag independent of emergency actions:** Debug flag icon on in-progress cards renders independently of the emergency actions setting. Files: `board-card.tsx`.

**Branch dropdown tooltip width:** Truncated branch names in the branch selector dropdown now show a tooltip with the full name. Dropdown width increased. Files: `branch-selector-popover.tsx`.

**Settings dialog fix:** Removed duplicate Git Polling section from the dialog shell (pre-existing bug from decomposition). Files: `runtime-settings-dialog.tsx`, `runtime-state-stream.integration.test.ts`.

## Fix: colored ahead/behind arrows on branch pill and dropdown + settings dialog type errors (2026-04-13)

**Branch indicator improvements:**
- `BranchPillTrigger` — changed the behind (down) arrow from `text-text-tertiary` to `text-status-blue` and the ahead (up) arrow to `text-status-green`. Previously both were muted gray and hard to notice.
- `BranchItem` — added ahead/behind count indicators (same colored arrows) to every local branch row in the `BranchSelectorPopover` dropdown. The data was already served from the backend via `git for-each-ref`'s `%(upstream:track)` and present on `RuntimeGitRef.ahead`/`.behind` — it just wasn't rendered in individual branch rows.

**Settings dialog fix:**
- The project-scoped "Git Polling" section (under the "Project" heading, below shortcuts) referenced bare variable names (`focusedTaskPollMs`, `setFocusedTaskPollMs`, `backgroundTaskPollMs`, `setBackgroundTaskPollMs`, `homeRepoPollMs`, `setHomeRepoPollMs`) — likely left over from before the settings form was consolidated into `useSettingsForm`. Changed all six references to use `fields.focusedTaskPollMs` / `setField("focusedTaskPollMs", ...)` etc., matching the pattern used by the identical controls in the Git section above.

Files touched: `web-ui/src/components/detail-panels/branch-selector-popover.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`

## Refactor: continued module decomposition — tier-2 and tier-3 files (2026-04-13)

Continued the large-file decomposition effort, targeting files in the 700–1,100 line range. Four separate passes, each splitting a different area of the codebase. Motivation: reduce agent context window consumption — agents investigating a single concern no longer need to read 800+ lines of unrelated logic.

**Pass 1 — codex-hook-events.ts (1,015 lines → 3 files):**
Split into `codex-session-parser.ts` (369 lines — session log line parsing, watcher state, shared `CodexMappedHookEvent` type), `codex-rollout-parser.ts` (350 lines — rollout JSONL file discovery/reading/parsing), and the slimmed `codex-hook-events.ts` (207 lines — watcher orchestration loop + barrel re-exports). The two parsers handle completely different file formats with no shared domain logic. Four trivial string/JSON helpers (`normalizeWhitespace`, `truncateText`, `asRecord`, `readStringField`) are duplicated rather than creating a shared utils file — each is 1–5 lines. The barrel preserves the original public API so `hooks.ts` and all test files are unchanged.

**Pass 2 — runtime-settings-dialog.tsx (913 lines → 5 files):**
Extracted four section components under `web-ui/src/components/settings/`: `agent-section.tsx` (agent defaults, model, mode), `display-sections.tsx` (theme, layout, terminal settings), `general-sections.tsx` (project paths, worktree options, misc toggles), `shortcuts-section.tsx` (project + prompt shortcut editors). Shared `SettingsSectionProps` interface in `settings-section-props.ts`. The dialog shell (open/close, tabs, save/reset) stays in the original file.

**Pass 3 — use-board-interactions.ts (1,027 lines → 5 hooks):**
Extracted `use-board-drag-handler.ts` (DnD column/card reordering), `use-session-column-sync.ts` (session state → column position reconciliation), `use-task-lifecycle.ts` (stop/restart/archive handlers), `use-task-start.ts` (agent launch + worktree setup), `use-trash-workflow.ts` (trash/untrash/hard-delete with dialog state). The original hook composes all five.

**Pass 4 — five tier-2 modules (700–999 lines each):**
- `hooks.ts` (919 → 3 files) — extracted `hook-metadata.ts` (metadata building, source inference, enrichment) and `codex-wrapper.ts` (Codex wrapper child process spawn). Core ingest/dispatch stays.
- `workspace-metadata-monitor.ts` (807 → 2 files) — extracted `workspace-metadata-loaders.ts` (git probe, task summary builder, file change detection). Monitor scheduling/lifecycle stays.
- `workspace-state.ts` (816 → 3 files) — extracted `workspace-state-index.ts` (workspace discovery, indexing, cleanup) and `workspace-state-utils.ts` (snapshot diffing, revision helpers). Core CRUD stays.
- `app-router.ts` (937 → 3 files) — extracted `app-router-context.ts` (context builder, auth middleware, dependency wiring) and `workspace-procedures.ts` (workspace CRUD tRPC procedures). Added `app-router-init.ts` for tRPC instance initialization. Route registration stays.
- `diff-renderer.tsx` (922 → 3 files) — extracted `diff-parser.ts` (unified diff → structured hunk parsing) and `diff-highlighting.ts` (syntax token highlighting, line-level rendering). React component stays.

Files touched: `src/commands/codex-hook-events.ts`, `src/commands/codex-rollout-parser.ts` (new), `src/commands/codex-session-parser.ts` (new), `src/commands/codex-wrapper.ts` (new), `src/commands/hook-metadata.ts` (new), `src/commands/hooks.ts`, `src/server/workspace-metadata-loaders.ts` (new), `src/server/workspace-metadata-monitor.ts`, `src/state/workspace-state-index.ts` (new), `src/state/workspace-state-utils.ts` (new), `src/state/workspace-state.ts`, `src/trpc/app-router-context.ts` (new), `src/trpc/app-router-init.ts` (new), `src/trpc/app-router.ts`, `src/trpc/workspace-procedures.ts` (new), `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/components/settings/agent-section.tsx` (new), `web-ui/src/components/settings/display-sections.tsx` (new), `web-ui/src/components/settings/general-sections.tsx` (new), `web-ui/src/components/settings/settings-section-props.ts` (new), `web-ui/src/components/settings/shortcuts-section.tsx` (new), `web-ui/src/components/shared/diff-highlighting.ts` (new), `web-ui/src/components/shared/diff-parser.ts` (new), `web-ui/src/components/shared/diff-renderer.tsx`, `web-ui/src/hooks/use-board-drag-handler.ts` (new), `web-ui/src/hooks/use-board-interactions.ts`, `web-ui/src/hooks/use-session-column-sync.ts` (new), `web-ui/src/hooks/use-task-lifecycle.ts` (new), `web-ui/src/hooks/use-task-start.ts` (new), `web-ui/src/hooks/use-trash-workflow.ts` (new), `CHANGELOG.md`, `docs/implementation-log.md`.

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
