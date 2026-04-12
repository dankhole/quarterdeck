# Implementation Log

Detailed implementation notes for completed features and fixes. Listed in reverse chronological order. Each entry records what changed, why, and what files were touched — useful for understanding past decisions and debugging regressions.

For the concise, user-facing summary of each release, see [CHANGELOG.md](../CHANGELOG.md).

## Statusline: fix token throughput glyph and color (2026-04-11)

The token throughput segment in the Claude Code statusline (`549↓ 1.7k↑`) used `nf-mdi-function` (U+F0865) — a supplementary-plane MDI glyph that rendered as `??` in terminal fonts missing that codepoint. Replaced with `nf-md-file-document` (U+F0219), which is in the same Nerd Font set as other working glyphs in the statusline. Also changed the segment's color from `brightYellow` to `dimWhite` — it was identical to the adjacent duration segment, making three different metrics (cost/duration/tokens) visually indistinguishable.

**Files touched**: `src/commands/statusline.ts` (GLYPH.tokens codepoint, `renderMetricsLine` color).

## Default prompt shortcuts with merge system (2026-04-11)

Added "Squash Merge" as a second default prompt shortcut and built a merge system so defaults persist across user customizations.

**Problem**: Previously, `DEFAULT_PROMPT_SHORTCUTS` was only used when the user had zero saved shortcuts. The moment a user customized anything, all defaults disappeared and new defaults added in code would never reach existing users.

**Solution**: `normalizePromptShortcuts` now merges defaults into user shortcuts on every config load. A new `hiddenDefaultPromptShortcuts: string[]` field tracks defaults the user explicitly removed. The merge logic: user shortcuts first (preserving order), then any non-hidden defaults the user doesn't already have (by case-insensitive trimmed label match) are appended. When the user has no shortcuts and all defaults are hidden, an empty list is returned (not the fallback defaults).

**Squash merge prompt**: Extracted from the squash-merge Claude skill with project-specific release hygiene removed. Step 0 asks the user for the target branch (default: `main`) with an explanation of what `commit-tree` + `update-ref` does, so the user can bail out if it's not what they want. The prompt doesn't auto-detect — it asks first.

**Editor dialog rewrite**: The prompt shortcut editor now knows about defaults. Each shortcut shows a badge ("Default" for unmodified, "Modified" for overrides). Delete on a default shows an AlertDialog: "Revert to default" / "Delete entirely" for overrides, or "Hide default" for unmodified defaults. A RotateCcw button on overridden defaults reverts to the original text inline. `onSave` now takes two args: `(shortcuts, hiddenDefaults)`.

**Settings restore**: A "Restore defaults" section appears in Settings > Suppressed Dialogs only when defaults are hidden or overridden. Clicking "Restore defaults" opens an AlertDialog, then clears `hiddenDefaultPromptShortcuts` and strips default-label entries from the user's saved list, letting the merge logic restore originals.

**Template extraction**: All three prompt templates (`DEFAULT_COMMIT_PROMPT_TEMPLATE`, `DEFAULT_OPEN_PR_PROMPT_TEMPLATE`, `DEFAULT_SQUASH_MERGE_PROMPT_TEMPLATE`) moved from inline string constants in `config-defaults.ts` to `src/prompts/prompt-templates.ts`. `config-defaults.ts` imports and re-exports them.

**Config pipeline**: `hiddenDefaultPromptShortcuts` threaded through `RuntimeGlobalConfigFileShape`, `RuntimeConfigState`, `RuntimeConfigUpdateInput`, `runtimeConfigResponseSchema`, `runtimeConfigSaveRequestSchema`, `writeRuntimeGlobalConfigFile`, `buildRuntimeConfigResponse`, `toRuntimeConfigState`, `createRuntimeConfigStateFromValues`, `applyConfigUpdates`, `saveRuntimeConfig`, and `toGlobalRuntimeConfigState`. On-disk persistence uses sparse serialization (empty array not written).

**Files touched**: `src/prompts/prompt-templates.ts` (new), `src/config/config-defaults.ts`, `src/config/runtime-config.ts`, `src/core/api-contract.ts`, `src/config/agent-registry.ts`, `web-ui/src/components/prompt-shortcut-editor-dialog.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/hooks/use-prompt-shortcuts.ts`, `web-ui/src/App.tsx`, `web-ui/src/runtime/runtime-config-query.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`, `test/runtime/config/runtime-config.test.ts`, `web-ui/src/components/prompt-shortcut-editor-dialog.test.tsx`, `web-ui/src/hooks/use-prompt-shortcuts.test.tsx`.

## Double-click task in sidebar to open agent chat (2026-04-11)

Added `onDoubleClick` support to the task sidebar so double-clicking a task card selects it and switches the main view to the agent terminal. The change threads an `onDoubleClick` prop through four layers: `BoardCard` (event handler on the card div, guarded against non-interactive/drag/modifier states) → `ColumnSection` → `ColumnContextPanel` → `CardDetailView`. `App.tsx` provides the handler via `handleCardDoubleClick`, which calls `handleCardSelect` then `setMainView("terminal")`. Backlog cards are excluded since they use single-click to open the inline editor. A hint line at the bottom of the `ColumnContextPanel` tells users about the gesture.

**Files touched**: `web-ui/src/components/board-card.tsx`, `web-ui/src/components/detail-panels/column-context-panel.tsx`, `web-ui/src/components/card-detail-view.tsx`, `web-ui/src/App.tsx`.

## Harden session state transition system (2026-04-11)

Four structural fixes to the hook-based state transition pipeline, plus diagnostic logging to support root-cause investigation of todo #9 (permission prompts) and #21 (compact doesn't transition).

**Dead state fix** (`session-state-machine.ts`): `canReturnToRunning()` now accepts `"exit"` in addition to `"attention"`, `"hook"`, and `"error"`. Previously, a task that exited cleanly (code 0) entered `awaiting_review` with `reviewReason: "exit"` — a permanent dead state that no hook could escape. Note: `"interrupted"` was considered but maps to `state: "interrupted"` (not `"awaiting_review"`), so it's a different code path and wasn't added. The duplicated inline check in `hooks-api.ts` (`canTransitionTaskForHookEvent`) now imports and delegates to the shared `canReturnToRunning` function.

**Interrupt timer leak** (`session-manager.ts`): `applySessionEventWithSideEffects` now calls `clearInterruptRecoveryTimer(entry.active)` when transitioning to `state: "running"`. The bug: user presses Escape → 5s timer scheduled → agent fires `to_in_progress` hook → state goes back to running → timer fires anyway → bounces session to `awaiting_review/attention`. The fix clears the timer on any return-to-running transition.

**Hook delivery retry** (`hooks.ts`): `ingestHookEvent` now retries once after a 1s delay if the initial attempt (3s timeout) fails. The tRPC client is created once and reused across both attempts. On retry failure, the original error is re-thrown. This is the simplest reliability improvement for the only channel that drives state transitions.

**Reconciliation through reducer** (`session-manager.ts`): The `mark_processless_error` reconciliation action now calls `applySessionEventWithSideEffects(entry, { type: "process.exit", exitCode: null, interrupted: false })` instead of directly writing `{ state: "awaiting_review", reviewReason: "error" }` via `store.update`. The outcome is identical (`exitCode: null` maps to `reviewReason: "error"`) but the transition is now validated by the state machine and triggers side effects (interrupt timer clearing, attention buffer reset).

**Diagnostic logging**: Two layers for diagnosing stuck-state root causes. CLI-side: `process.stderr.write` in `runHooksIngest` emits a structured `[hooks:cli]` line on every hook invocation, showing event type, hookEventName, toolName, notificationType, and truncated activityText. Server-side: four `log.debug` calls in `hooks-api.ts` at the key decision points — hook received (full metadata), hook blocked (state mismatch), hook blocked (permission guard), and hook transitioning (before/after state). Server logs go through the existing `createTaggedLogger("hooks")` and are visible in the UI's debug log panel when enabled.

**Files touched**: `session-state-machine.ts` (canReturnToRunning), `hooks-api.ts` (shared import + 4 debug logs), `session-manager.ts` (timer clearing + reconciliation routing), `hooks.ts` (retry + CLI logging), `session-reconciliation.test.ts` (updated exit-reason test + removed unreachable interrupted-reason test).

## Agent directory access from worktrees (2026-04-11)

Two new global config fields — `worktreeAddParentRepoDir` (default true) and `worktreeAddQuarterdeckDir` (default false) — control whether Claude Code agents in task worktrees receive `--add-dir` flags for the parent repository and the `~/.quarterdeck` state directory respectively.

The core logic lives in `claudeAdapter.prepare()` in `agent-session-adapters.ts`. It compares `resolve(input.cwd)` against `resolve(input.workspacePath)` — when they differ (agent is in a worktree), it conditionally pushes `--add-dir <path>` args. When the agent runs directly in the parent repo, the block is skipped entirely. The `workspacePath` field was already available on `StartTaskSessionRequest` but wasn't forwarded to `AgentAdapterLaunchInput` — this change threads it through.

The `~/.quarterdeck` path is resolved via the existing `getRuntimeHomePath()` (already imported in the adapter file). The quarterdeck dir setting defaults to false because `--add-dir` grants full read/write access, and rogue writes to `board.json` or `meta.json` would break the revision-based optimistic concurrency model (single-writer rule in AGENTS.md).

Settings UI adds two Radix Switch toggles in the "Git & Worktrees" section of the settings dialog, with description text noting the Claude Code-only scope and a risk warning for the quarterdeck dir toggle. Dirty detection (`hasUnsavedChanges` memo) tracks both fields with initial-value comparisons.

**Files touched**: `src/config/global-config-fields.ts`, `src/core/api-contract.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-manager.ts`, `src/trpc/runtime-api.ts`, `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/runtime/runtime-config-query.ts`, `web-ui/src/runtime/use-runtime-config.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`, `test/runtime/config/runtime-config.test.ts`.

## Fix: project pills double-counting needs-input tasks as review (2026-04-11)

The project navigation sidebar shows small status pills (R, NI, IP, B) with task counts. When a task's session was `awaiting_review` with `reviewReason: "attention"` (or a permission-request hook), `applyLiveSessionStateToProjectTaskCounts` counted it in **both** `review` and `needs_input`. Two separate `if` blocks fired independently: the first moved the count from `in_progress` → `review`, and the second added to `needs_input` — resulting in pills showing R:1 and NI:1 for a single task.

**Root cause**: The `needs_input` increment (lines 182-189) was a standalone `if` block that never subtracted from `review`. It was additive on top of the earlier `in_progress → review` move (lines 173-176), with no coordination between them.

**Fix**: Merged both blocks into a single `if (summary.state === "awaiting_review")` block. A `const isNeedsInput` boolean is computed once, then used to route the count to either `needs_input` (with decrements from `in_progress` or `review` as appropriate) or `review` (for normal non-attention reviews). The `interrupted` handling is unchanged and remains a separate block.

**Files touched**: `src/server/workspace-registry.ts` (lines 168-194, the `applyLiveSessionStateToProjectTaskCounts` loop body).

## Fix: git index lock contention from workspace metadata polling (2026-04-11)

The workspace-metadata-monitor polls git on all active worktrees every 2–10 seconds (focused: 2s, background: 5s, home: 10s) to derive uncommitted-changes dots, behind-base counts, and sync indicators. Most git commands already passed `--no-optional-locks` to avoid acquiring the index lock, but `getCommitsBehindBase()` in `git-utils.ts` was missing the flag on all 4 of its calls (2× `merge-base`, 2× `rev-list --count`). These run on every task poll cycle via `loadTaskWorkspaceMetadata` in `workspace-metadata-monitor.ts:286`, so with multiple active tasks the index lock was held almost continuously on each worktree — blocking manual commits, staging, and any other write operation.

Additionally, `git-history.ts` had 3 `rev-list` calls without the flag (1× total count query, 2× ahead/behind divergence). These aren't on the polling hot path (triggered by UI navigation to git history) but could transiently block.

**Root cause**: Incomplete application of `--no-optional-locks` when the behind-base feature was added. The existing test suite (`git-sync-no-optional-locks.test.ts`) only covered `git-sync.ts` functions (status, rev-parse, diff) and didn't test `git-utils.ts` or `git-history.ts`.

**Fix**: Added `--no-optional-locks` as the first argument to all 7 affected `runGit` calls. Added a test case verifying all `merge-base` and `rev-list` calls from `getCommitsBehindBase` include the flag.

**Files touched**: `src/workspace/git-utils.ts` (4 calls), `src/workspace/git-history.ts` (3 calls), `test/runtime/git-sync-no-optional-locks.test.ts` (new test case).

## Emergency stop/restart actions for stuck running tasks (2026-04-11)

Added a settings-gated escape hatch for tasks stuck in "running" state. When `showRunningTaskEmergencyActions` is enabled in Settings > Session Recovery, hovering an in-progress card with an active (non-dead) session shows two extra buttons: force-restart (orange RotateCw — stops then restarts the session) and force-trash (red Trash2 — moves the card to trash). Both only appear on hover to keep the default UI clean.

The root problem: when a task is in "running" state in the in_progress column, the UI doesn't show restart or trash buttons — those only appear in the review column. If the session is alive but useless (failed resume, permission prompt hang, agent stuck in compact), the user has no way to recover without dragging the card or restarting the server. This feature doesn't fix the root causes (todo #9, #20) but provides an immediate workaround.

Also updated `handleMoveReviewCardToTrash` to detect the card's actual column instead of hardcoding `"review"` as the source column, so the trash action works correctly from in_progress.

Added a "Session reconciliation" section to AGENTS.md and a header comment to `session-reconciliation.ts` directing future developers to register cleanup for new dynamic UI state in the reconciliation sweep.

**Config pipeline** (4 files): `global-config-fields.ts` (field definition), `api-contract.ts` (response + save request schemas), `runtime-config-query.ts` and `use-runtime-config.ts` (manual type lists).

**UI pipeline** (7 files): `card-actions-context.tsx` (reactive state type), `runtime-settings-dialog.tsx` (toggle UI + state + dirty check + sync + save), `board-card.tsx` (conditional button rendering), `board-column.tsx` and `column-context-panel.tsx` (prop threading), `App.tsx` (wiring reactive state), `use-board-interactions.ts` (trash handler column detection).

**Test fixtures** (3 files): `runtime-config.test.ts`, `runtime-config-factory.ts`, `card-detail-view.test.tsx`, `column-context-panel.test.tsx`.

## Right-click context menu on branch selector items (2026-04-11)

Added a Radix `ContextMenu` to each `BranchItem` inside `BranchSelectorPopover`. Three actions: Checkout (reuses existing `onCheckoutBranch` callback with confirmation dialogs), Compare with local tree (navigates to git view Compare tab via `openGitCompare`), and Copy branch name (clipboard + toast).

Both `onCheckoutBranch` and `onCompareWithBranch` are now optional props on `BranchSelectorPopover`. Menu items render conditionally — same pattern used for both. This fixed a pre-existing issue where the git view Compare tab passed `onCheckoutBranch={() => {}}` (a silent no-op); now it simply omits the prop and no checkout affordance renders.

Extracted `CONTEXT_MENU_ITEM_CLASS` and `copyToClipboard` from `file-browser-tree-panel.tsx` into a shared `context-menu-utils.ts` module to avoid duplication. Both context menu consumers now import from the shared module.

The `openGitCompare` callback (previously `_openGitCompare`, unused) is now threaded from `App.tsx` through `CardDetailView` to the task scope bar's `BranchSelectorPopover`. It sets `pendingCompareNavigation` and switches to the git main view, where `useGitViewCompare` picks up the navigation and pre-selects the target ref.

**Files touched**: `branch-selector-popover.tsx` (main implementation), `context-menu-utils.ts` (new shared module), `file-browser-tree-panel.tsx` (imports shared utils), `App.tsx` (renamed callback, wired props), `card-detail-view.tsx` (accepts/forwards `onOpenGitCompare`), `git-view.tsx` (removed no-op `onCheckoutBranch`), `branch-select-dropdown.tsx` (doc comment).

## Perf: faster project switching — server-side latency optimizations (2026-04-11)

Three changes to reduce the wall-clock time between clicking a project and seeing the board:

**1. Decouple workspace metadata from the initial snapshot** (`runtime-state-hub.ts`): Previously, `workspaceMetadataMonitor.connectWorkspace()` was awaited before the snapshot was sent to the client. This function runs git probes on the home repo and every tracked task worktree (up to ~35 git subprocess spawns with 5 active tasks, limited to concurrency 3). Now the snapshot is sent immediately with `workspaceMetadata: null`, and `connectWorkspace` fires as a fire-and-forget after the client is registered in the workspace client maps. The existing `onMetadataUpdated` callback delivers metadata via the `workspace_metadata_updated` message type — no new protocol or message types needed. The `workspace_metadata_updated` handler on the frontend already existed for incremental updates; it now also delivers the first metadata load. The `isWorkspaceMetadataPending` flag (which gates the loading spinner) tracks board state hydration, not metadata arrival, so the spinner clears as soon as the board data is applied.

**2. Parallelize file reads** (`workspace-state.ts`): `loadWorkspaceState` previously called `readWorkspaceBoard`, `readWorkspaceSessions`, `readWorkspaceMeta` sequentially. All three read independent JSON files and none acquire locks, so they now run via `Promise.all` after `loadWorkspaceContext` resolves the workspace ID.

**3. Cache inactive project task counts** (`workspace-registry.ts`): `summarizeProjectTaskCounts` was reading the board JSON from disk for every project on every call to `buildProjectsPayload` (triggered every 150ms during active sessions via `flushTaskSessionSummaries`). Now, for workspaces without a terminal manager (no active agent sessions), cached counts are served directly from the existing `projectTaskCountsByWorkspaceId` map. Active workspaces still recompute with live session overlay. Cache is cleared on workspace disposal.

Files touched: `src/server/runtime-state-hub.ts`, `src/server/workspace-registry.ts`, `src/state/workspace-state.ts`, `test/integration/runtime-state-stream.integration.test.ts`.

## Toolbar highlight style swap and sidebar sync fixes (2026-04-11)

Swapped the active-state styles between the two toolbar button groups: main view buttons now get the blue left-border accent (`text-accent border-l-2 border-accent`), sidebar buttons now get the gray filled background (`bg-surface-3 text-text-primary`). This gives the primary selection (main view) the more prominent visual treatment.

Simplified `visualSidebar` in the layout hook from a multi-condition ternary to just `sidebar`. The old logic suppressed the sidebar highlight when `mainView === "git"` (because the git view has an integrated file tree), but the sidebar panel can still be open alongside the git view — suppressing the highlight made the toolbar disagree with what was actually visible. The old logic also showed a "hint" highlight when the sidebar was collapsed (previewing which tab would reopen), but this violated the principle of highlighting only what's currently visible.

Fixed a sidebar orphan bug: when a task is deselected, `task_column` now unconditionally falls back to `projects` regardless of the current main view or pin state. Previously this only happened inside the `currentMainView === "terminal"` branch of the task-deselection effect. If the user was on Files or Git with the Board sidebar and deselected the task, the sidebar state would stay stuck on `task_column` — but since Board is disabled without a task, neither sidebar button would be highlighted, and the ProjectNavigationPanel would render as a fallback via the `sidebar !== null && !selectedCard` condition in App.tsx.

Files touched: `web-ui/src/components/detail-panels/detail-toolbar.tsx`, `web-ui/src/resize/use-card-detail-layout.ts`, `docs/ui-layout-architecture.md`, `CHANGELOG.md`.

## Fix: chat view showing duplicate copies of the conversation (2026-04-11)

The HTML chat view (`ChatOutputView`) showed the entire conversation repeated many times when scrolling up.

**Root cause**: `readBufferLines()` in `PersistentTerminal` iterated from line 0 to `buffer.length` — the full xterm scrollback (10,000 lines) plus viewport. The terminal options include `scrollOnEraseInDisplay: true`, which causes xterm.js to push the current viewport into scrollback every time a TUI agent sends an ED2 (erase-in-display) clear-screen sequence. Claude Code and similar full-screen TUIs clear and redraw frequently (status bar updates, prompt redraws, tool call transitions), so the scrollback accumulated many progressively-longer copies of the conversation. The prior ANSI-accumulator approach didn't have this problem because it built lines incrementally, but it was replaced in `044d3e1f` because it couldn't handle Claude Code's cursor-positioning output.

**Fix**: Changed `readBufferLines()` to read only the viewport region (`buffer.baseY` to `baseY + terminal.rows`). For TUI agents, the viewport is the authoritative current state — the TUI manages its own display within it. Scrollback is accumulated redraw artifacts, not useful history. Also trims trailing empty lines since TUIs often don't fill the full viewport height.

Also deleted the dead `chat-output-accumulator.ts` file (no imports anywhere, superseded in `044d3e1f`).

Files touched: `web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/terminal/chat-output-accumulator.ts` (deleted).

## Move branch status from top bar to git view tab bar (2026-04-11)

Relocated the branch pill (with git history toggle), file change stats, and fetch/pull/push sync buttons from the main top bar (`TopBar` → `TopBarGitStatusSection`) into the git view's tab bar via a `branchStatusSlot` prop on `GitView`.

**Why**: The branch pill was occupying top bar space that's shared across all views. Since it toggles git history (a git-specific feature), it belongs in the git view. This also makes the top bar less cluttered and sets up for future branch management features in the git view (todo #5).

**Architecture**:
- `GitView` gained two new props: `branchStatusSlot` (rendered in the tab bar, right-aligned before the file-tree toggle) and `gitHistoryPanel` (rendered as the content area, replacing the diff viewer when present).
- `GitBranchStatusControl` was exported from `top-bar.tsx` for reuse. `TopBarGitStatusSection` was deleted as dead code.
- Two new local components compose the slot content: `HomeBranchStatus` in `App.tsx` (branch pill + fetch/pull/push buttons) and `TaskBranchStatus` in `card-detail-view.tsx` (branch pill + "based on" label for detached worktrees).
- `handleToggleGitHistory` stays in App.tsx unchanged, but a new `useEffect` auto-switches to the git main view whenever `isGitHistoryOpen` becomes true. This ensures `Cmd+G` from any view navigates to the git tab and opens history.
- In `card-detail-view.tsx`, the `gitHistoryPanel ? ... : mainView === "git"` conditional was simplified — `gitHistoryPanel` is now passed through to `GitView` instead of rendering as a standalone replacement panel.
- The compare bar is hidden when `gitHistoryPanel` is active to avoid showing branch pickers below the tab bar when the content area shows history.

Files touched: `web-ui/src/App.tsx`, `web-ui/src/components/top-bar.tsx`, `web-ui/src/components/git-view.tsx`, `web-ui/src/components/card-detail-view.tsx`.

## Auto-collapse sidebar when opening Files or Git view (2026-04-11)

Added auto-coupling rule to `setMainView` in `use-card-detail-layout.ts`: when switching to `"files"` or `"git"`, the sidebar collapses (sets to `null`) unless `sidebarPinned` is true. Both views have integrated file trees that functionally replace the sidebar, so leaving it open wastes horizontal space. The git view already suppressed the sidebar toolbar highlight (`visualSidebar` returned `null`), but the panel itself remained rendered — now it actually collapses.

Files touched: `web-ui/src/resize/use-card-detail-layout.ts`, `CHANGELOG.md`, `docs/implementation-log.md`.

## "Copy file contents" in file browser context menu (2026-04-11)

Added a "Copy file contents" action to the file browser right-click context menu, completing the copy action set (name, path, contents).

**Data flow**: The `useFileBrowserData` hook already manages workspace/task context for file content fetching. Added a `getFileContent(path)` method to its return interface that makes the same `workspace.getFileContent` tRPC call used by the file viewer. The tree panel receives this as a prop and calls it when the menu item is selected. Binary files are rejected with an error toast; fetch failures show a generic error toast; successful copies show a success toast.

The menu item only appears on files (not directories) and only when `getFileContent` is provided (always true in the current two `FilesView` call sites).

Files touched: `web-ui/src/hooks/use-file-browser-data.ts`, `web-ui/src/components/files-view.tsx`, `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx`.

## Fix: font weight settings input — text input instead of number spinner (2026-04-11)

Replaced the native `type="number"` input for terminal font weight in the settings dialog with a `type="text"` + `inputMode="numeric"` input backed by local draft state.

**Problem**: The native number input was unusable for manual entry. The `onChange` handler clamped values immediately (`Math.max(100, Math.min(900, value))`), so typing "350" would clamp after the first keystroke "3" → 100, making it impossible to enter values by typing. The step arrows (previously 25, then 10) also produced jumpy behavior that wasn't intuitive.

**Fix**: Extracted a `FontWeightInput` component that maintains a local `draft` string state. The user types freely into a plain text field. On blur or Enter, the draft is parsed and validated (100–900 range); invalid input reverts to the current value. A `useEffect` syncs the draft from the parent value when the input isn't focused (e.g. config load). Input width narrowed from `w-20` to `w-14` with `tabular-nums` for stable digit widths.

Files touched: `web-ui/src/components/runtime-settings-dialog.tsx`.

## Uncommitted changes indicator color: orange → red (2026-04-11)

Changed the uncommitted-changes dot on task cards from `bg-status-orange` to `bg-status-red` for stronger visual contrast against the orange "cwd diverged" warning icon that sits in the same indicator row. Updated the settings description text to match.

Files touched: `web-ui/src/components/board-card.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, `CHANGELOG.md`.

## Terminal rendering options — WebGL toggle and experimental HTML chat view (2026-04-11)

Two new settings to address the longstanding font rendering gap between the xterm.js terminal canvas and native HTML text (e.g. the Claude Code status bar).

**WebGL renderer toggle** (`terminalWebGLRenderer`, default `true`): Added a boolean config field that gates whether the `@xterm/addon-webgl` is loaded. When disabled, xterm.js falls back to its built-in canvas 2D renderer which uses the browser's `fillText()` API instead of a WebGL texture atlas. The module-level `currentTerminalWebGLRenderer` flag is checked in `attachWebglAddon()`, and `setTerminalWebGLRenderer()` live-toggles all existing terminals by disposing/recreating the addon. Applied via `useEffect` in App.tsx on config change.

**Experimental HTML chat view** (`terminalChatViewEnabled`, default `false`): When enabled, the main agent terminal panel renders a `ChatOutputView` component instead of the xterm.js canvas. The pipeline: `PersistentTerminal.subscribe({ onOutputText })` → `ChatOutputAccumulator.push()` (filters cursor-save/restore blocks used by Claude Code's status bar, strips all ANSI sequences, collapses carriage-return overwrites, normalizes line endings) → `useChatOutput` hook (batches state updates at 60ms) → `ChatOutputView` (scrollable `<div>` with `pre-wrap`, same JetBrains Mono font, auto-scroll with 40px threshold). The xterm.js terminal stays mounted at `height: 0` and continues receiving all WebSocket data so scroll-back is preserved. Accumulator caps at 10,000 lines.

The chat view is driven by a global settings toggle (not a per-panel toggle) because the main agent terminal has no toolbar of its own — the per-panel approach only appeared on shell terminals where it wasn't useful.

Files touched: `src/config/global-config-fields.ts`, `src/core/api-contract.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/card-detail-view.tsx`, `web-ui/src/components/chat-output-view.tsx` (new), `web-ui/src/components/detail-panels/agent-terminal-panel.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/hooks/use-chat-output.ts` (new), `web-ui/src/runtime/use-runtime-config.ts`, `web-ui/src/terminal/chat-output-accumulator.ts` (new), `web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`, `test/runtime/config/runtime-config.test.ts`.
## Fix: behind-base indicator not detecting local branch advancement (2026-04-11)

Fixed a bug where the "behind base" indicator on headless worktrees always showed 0 when local `main` advanced but `origin/main` was stale (no `git fetch` had occurred).

**Root cause**: `getCommitsBehindBase` in `git-utils.ts` tried `origin/{baseRef}` first via `git merge-base HEAD origin/main`. If this succeeded (which it always does when the remote ref exists, even if stale), it computed the behind count against the stale `origin/main` and returned immediately — never falling through to check local `main`. So when another agent's branch was merged into local `main`, the behind count stayed at 0.

**Secondary issue**: The metadata cache in `workspace-metadata-monitor.ts` only tracked `baseRefCommit` (the local ref's commit hash) for cache invalidation. After a `git fetch` that advanced `origin/main`, the cache wouldn't invalidate for a headless worktree because the local `main` ref and the worktree's `stateToken` were both unchanged.

**Fix 1 — check both refs**: `getCommitsBehindBase` now runs `merge-base` for both `origin/{baseRef}` and `{baseRef}` in parallel, computes the behind count for each, and returns whichever is higher. This handles the common cases: local `main` advanced (local wins), `git fetch` ran (origin wins), or both (max wins).

**Fix 2 — dual cache key**: Added `originBaseRefCommit` to `CachedTaskWorkspaceMetadata`. The cache now resolves both `rev-parse {baseRef}` and `rev-parse origin/{baseRef}` on every poll cycle. If either changes, the cache invalidates and triggers a full recomputation.

Files touched: `src/workspace/git-utils.ts`, `src/server/workspace-metadata-monitor.ts`.

## Fix: terminal scroll glitch and duplicate chat on task switch (2026-04-11)

Fixed two related bugs in `persistent-terminal-manager.ts` that shared the same root cause — the RAF-delayed resize in `mount()` combined with no deduplication of resize messages to the PTY.

**Bug #27 (laggy scroll)**: When switching tasks, the cached `PersistentTerminal` was moved from the off-screen parking root to the visible container, but `requestResize()` was deferred to the next animation frame via `requestAnimationFrame`. For one frame, the terminal was visible with stale dimensions/scroll position. When `fitAddon.fit()` fired in the next frame, xterm.js reflowed the buffer and adjusted the viewport — producing a visible scroll animation from an incorrect position to the bottom.

**Bug #28 (duplicate chat at different widths)**: On every mount, two resize messages were sent to the server — one from the RAF callback (~16ms after mount) and another from the ResizeObserver's initial fire (~50ms after mount). The server forwarded each to `pty.resize()` with no deduplication, sending `SIGWINCH` twice. Agents like Claude Code redraw their entire chat display on resize, so two redraws at slightly different column widths left the old rendering in scrollback while the new one painted on top.

**Fix 1 — synchronous fit**: Replaced the `requestAnimationFrame` wrapper in `mount()` with a direct synchronous call to `requestResize()`. The container is in the DOM (React `useEffect` guarantees this), so `getComputedStyle` returns correct dimensions. Terminal gets the right size before the browser ever paints a frame.

**Fix 2 — resize dedup**: Added `lastSentCols`/`lastSentRows` tracking to `PersistentTerminal`. After `fitAddon.fit()` computes dimensions, the resize message is only sent if cols/rows differ from what was last sent. The ResizeObserver's follow-up fire sees the same dimensions and is silently skipped. Real container resizes (window resize, panel drag) produce different dimensions and still go through.

**Fix 3 — restore reset**: `applyRestore()` resets `lastSentCols`/`lastSentRows` to 0 so the post-restore `requestResize()` always sends to the server, since a fresh/reconnected connection doesn't know the terminal size.

Files touched: `web-ui/src/terminal/persistent-terminal-manager.ts`. Closes todo #27, #28.

## File browser right-click context menu (2026-04-11)

Added a right-click context menu to every row (files and directories) in the file browser tree panel. Two actions: "Copy name" (copies `node.name` — just the filename/folder name) and "Copy path" (copies full absolute path by joining the worktree root with the relative file path).

**Package**: Added `@radix-ui/react-context-menu` to web-ui dependencies. It mirrors the `@radix-ui/react-dropdown-menu` API already in use.

**Context menu implementation**: Each virtualized row wraps in `ContextMenu.Root` > `ContextMenu.Trigger asChild` (on the existing button) > `ContextMenu.Portal` > `ContextMenu.Content`. The `asChild` pattern merges Radix's `onContextMenu` handler onto the button without replacing the existing `onClick`. Styling uses `bg-surface-1 border-border-bright` to match the existing dropdown pattern in `project-navigation-panel.tsx`.

**rootPath plumbing**: New optional `rootPath?: string | null` prop on `FileBrowserTreePanel`. When provided, "Copy path" concatenates `${rootPath}/${node.path}` for the full absolute path; falls back to the relative path when null. `rootPath` flows through `FilesView` (new prop) from two call sites: `App.tsx` passes `workspacePath` (home view), `card-detail-view.tsx` passes `taskWorkspaceInfo?.path ?? selection.card.workingDirectory` (task view).

**Clipboard + feedback**: Reuses the same `navigator.clipboard.writeText` + `toast` from `sonner` pattern already in `file-content-viewer.tsx`.

Files touched: `web-ui/package.json`, `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx`, `web-ui/src/components/files-view.tsx`, `web-ui/src/App.tsx`, `web-ui/src/components/card-detail-view.tsx`. Todo #23 updated to cover branch pill context menu. Todo #28 added for "Copy file" (copy full contents).

## Sidebar pin toggle — prevent auto-switching on task click (2026-04-11)

Added a pin toggle button to the sidebar toolbar that prevents the sidebar from auto-switching when selecting or deselecting a task. Previously, clicking a task card while on the home view unconditionally switched both the main view to terminal AND the sidebar to `task_column`, which was disruptive when actively using the project switcher.

**State management**: New `sidebarPinned` boolean state in `useCardDetailLayout` with `toggleSidebarPinned` callback. A `sidebarPinnedRef` keeps the value fresh for the auto-switch `useEffect` (avoids stale closures). Pin state persists to `LocalStorageKey.SidebarPinned` (`"quarterdeck.sidebar-pinned"`) via `readLocalStorageItem`/`writeLocalStorageItem`.

**Auto-switch guard**: The `useEffect` watching `selectedTaskId` now reads `sidebarPinnedRef.current`. When pinned: selecting a task still switches `mainView` from `"home"` to `"terminal"` (the terminal needs a task), but skips `setSidebarPersist("task_column")`. Deselecting a task still switches `mainView` from `"terminal"` to `"home"`, but only skips `setSidebarPersist("projects")` when the current sidebar is NOT `"task_column"` — because `task_column` fundamentally requires a task to function, so it always falls back to `"projects"` on deselect regardless of pin state.

**Explicit actions bypass pin**: `setMainView("home")` (clicking Home) and `toggleSidebar()` (manually clicking sidebar buttons) are unaffected by pin state. The pin only guards automatic sidebar switches triggered by task selection changes.

**Toolbar UI**: Small pin button (6×6 px) below the Board sidebar button. When pinned: `Pin` icon in accent color. When unpinned: `PinOff` icon at 40% opacity, full opacity on hover. Tooltip shows "Pin sidebar" / "Unpin sidebar". `aria-pressed` reflects state.

Files touched: `web-ui/src/resize/use-card-detail-layout.ts`, `web-ui/src/components/detail-panels/detail-toolbar.tsx`, `web-ui/src/App.tsx`, `web-ui/src/storage/local-storage-store.ts`. Closes todo #25.

## Terminal WebGL renderer toggle (2026-04-11)

Added a configurable toggle (`terminalWebGLRenderer`, default `true`) to enable or disable xterm.js's WebGL renderer. When disabled, terminals fall back to the browser's built-in canvas 2D renderer, which produces crisper text on some displays at the cost of GPU acceleration. The toggle applies live — enabling attaches a new `WebglAddon`, disabling disposes it and lets xterm fall back automatically.

**Config pipeline**: New `terminalWebGLRenderer` boolean field added to `global-config-fields.ts` → `api-contract.ts` (response + save schemas) → `use-runtime-config.ts` (save payload type) → `runtime-settings-dialog.tsx` (Radix Switch in the Terminal section) → `App.tsx` (syncs config to terminal manager via `useEffect`) → `persistent-terminal-manager.ts` (module-level `setTerminalWebGLRenderer()` iterates all terminals, per-instance `setWebGLRenderer()` attaches/disposes the addon).

**Guard in `attachWebglAddon()`**: The existing method now early-returns when `currentTerminalWebGLRenderer` is `false`, which also correctly handles the `onContextLoss` recovery path — if the user disabled WebGL while a context loss was pending, the re-attach no-ops.

Files touched: `src/config/global-config-fields.ts`, `src/core/api-contract.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/runtime/use-runtime-config.ts`, `web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`, `test/runtime/config/runtime-config.test.ts`.

## Files view — Board sidebar can coexist (2026-04-11)

The Files main view (`mainView === "files"`) previously rendered its `ScopeBar` + `FileBrowserTreePanel` in the sidebar slot, which displaced the Board sidebar (`ColumnContextPanel`). The Git view didn't have this problem because its `FileTreePanel` was embedded inside the `GitView` component itself. This inconsistency meant you could have the Board sidebar open alongside the Git view, but not alongside the Files view.

**Fix**: Created a `FilesView` component (`web-ui/src/components/files-view.tsx`) modeled after `GitView` — a self-contained component that internally manages a `ScopeBar` slot, `FileBrowserTreePanel` with resize handle and visibility toggle, and `FileContentViewer`. The file tree ratio persists to `LocalStorageKey.DetailFileBrowserTreePanelRatio`. Internal state (`expandedDirs`, `hasInitializedExpansion`) resets via React key prop when the parent context changes (task ID or project ID).

**Layout changes**: `isTaskSidePanelOpen` in `CardDetailView` changed from `mainView === "files" || sidebar === "task_column"` to just `sidebar === "task_column"`. The sidebar rendering no longer has a `mainView === "files"` branch — it only renders `ColumnContextPanel`. The `visualSidebar` computation in `useCardDetailLayout` was updated to only suppress sidebar highlight for `"git"`, not `"files"`. Dead code removed: `isFileBrowserExpanded` parameter, `COLLAPSED/EXPANDED_FILE_BROWSER_TREE_RATIO_PREFERENCE` constants, `detailFileBrowserTreeRatio`/`setDetailFileBrowserTreeRatio` from hook return, `DetailExpandedFileBrowserTreePanelRatio` localStorage key.

Files touched: `web-ui/src/components/files-view.tsx` (new), `web-ui/src/components/card-detail-view.tsx`, `web-ui/src/App.tsx`, `web-ui/src/resize/use-card-detail-layout.ts`, `web-ui/src/storage/local-storage-store.ts`, `docs/ui-layout-architecture.md`.

## Uncommitted changes indicator on task cards (2026-04-11)

Added a configurable orange dot indicator on board cards that shows when the task's worktree has uncommitted file changes (`changedFiles > 0`). The feature reuses the existing `workspace-metadata-monitor` polling infrastructure and `workspace-metadata-store` hooks — no new polling, detection, or WebSocket broadcast code was needed.

**Config pipeline**: New `uncommittedChangesOnCardsEnabled` boolean field (default `true`) added to `global-config-fields.ts` → `api-contract.ts` (response + save schemas) → `runtime-settings-dialog.tsx` (toggle in "Git & Worktrees" section with full state/sync/dirty/save wiring) → `card-actions-context.tsx` (`ReactiveCardState` interface) → `App.tsx` (reads from `runtimeProjectConfig`, passes via context memo) → `board-column.tsx` + `column-context-panel.tsx` (destructure from context, pass as prop) → `board-card.tsx` (renders the dot).

**Rendering**: Small 6px orange dot (`bg-status-orange`) in the card title row alongside existing status markers (spinner, pin, shared badge). Wrapped in a `Tooltip` showing "N uncommitted change(s)" with correct singular/plural. Gated on `uncommittedChangesOnCardsEnabled && showWorkspaceStatus && !isTrashCard && changedFiles > 0` — appears only on in_progress and review cards, excluded from backlog (no workspace status) and trash (explicitly excluded).

Files touched: `src/config/global-config-fields.ts`, `src/core/api-contract.ts`, `web-ui/src/components/board-card.tsx`, `web-ui/src/components/board-column.tsx`, `web-ui/src/components/detail-panels/column-context-panel.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/App.tsx`, `web-ui/src/runtime/use-runtime-config.ts`, `web-ui/src/runtime/runtime-config-query.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`, `test/runtime/config/runtime-config.test.ts`, plus 2 test files. Closes todo #29 (originally #33).

## Centralize status colors and sync card/project/column color coding (2026-04-11)

The status color system was inconsistent: running badges on task cards were green while the In Progress column indicator was blue, review badges were blue while the Review column was green, and project sidebar pill colors were hardcoded inline rather than referencing the same source as card badges.

**Centralized color module** (`web-ui/src/data/column-colors.ts`): Expanded from just `columnIndicatorColors` to also export `statusBadgeColors` (card/terminal badges with 15% bg opacity) and `statusPillColors` (project sidebar count pills with 20% bg opacity). Changing a status color now requires updating one place.

**Session status mapping** (`web-ui/src/utils/session-status.ts`): Renamed `getSessionStatusTagStyle` to `getSessionStatusBadgeStyle`, removed `SessionStatusTagStyle` and `sessionStatusTagColors` (moved to centralized module, re-exported for backward-compatible import paths). Running now maps to `"running"` (accent blue), all review states map to `"review"` (green), approval maps to `"needs_input"` (orange), error/failed maps to `"error"` (red).

**Project navigation panel** (`web-ui/src/components/project-navigation-panel.tsx`): Removed `hasApproval` prop and the orange approval dot next to project names. Removed the trash (T) pill. Added orange "NI" (Needs Input) pill sourced from `project.taskCounts.needs_input`. All pill colors now reference `statusPillColors` from the centralized module.

**Backend needs_input computation** (`src/core/api-contract.ts`, `src/server/workspace-registry.ts`): Added `needs_input: z.number()` to `runtimeProjectTaskCountsSchema`. `applyLiveSessionStateToProjectTaskCounts` counts sessions with `state === "awaiting_review"` and either `reviewReason === "attention"` or permission-request hook activity. New `isPermissionRequestSession` helper mirrors the frontend's `isPermissionRequest` logic.

**Frontend preservation** (`web-ui/src/hooks/use-project-ui-state.ts`): When overriding the current project's task counts with local board state, the server-provided `needs_input` value is preserved (column counts come from the board, but `needs_input` is session-derived and only the server has that data).

**App.tsx cleanup**: Removed `projectIdsWithApprovals` useMemo (no longer needed — the NI pill replaces the per-project approval dot). The toolbar badge (`projectsBadgeColor`) still works independently via `isApprovalState`.

Files touched: `web-ui/src/data/column-colors.ts`, `web-ui/src/utils/session-status.ts`, `web-ui/src/components/board-card.tsx`, `web-ui/src/components/detail-panels/agent-terminal-panel.tsx`, `web-ui/src/components/project-navigation-panel.tsx`, `web-ui/src/App.tsx`, `web-ui/src/hooks/app-utils.tsx`, `web-ui/src/hooks/use-project-ui-state.ts`, `src/core/api-contract.ts`, `src/server/workspace-registry.ts`, plus 2 test files.

## Show target branch when creating non-isolated task (2026-04-11)

When "Use isolated worktree" is unchecked in the task create dialog, the warning previously said "the task runs directly in your main checkout" with no indication of which branch that checkout is on. Now it displays the actual current branch name from `workspaceGit.currentBranch` inline in a monospace `<code>` tag (e.g. "runs directly on `feature/xyz`"), falling back to "detached HEAD" when `currentBranch` is null. Closes todo #29 (originally #32).

Files touched: `web-ui/src/components/task-create-dialog.tsx` (new `currentBranch` prop, updated warning JSX), `web-ui/src/App.tsx` (passes `workspaceGit?.currentBranch ?? null`), `docs/todo.md` (removed #29, renumbered), `CHANGELOG.md`, `docs/implementation-log.md`.

## README refresh (2026-04-11)

Updated the README to close the gap between the documented feature set and reality. The README still had the original fork-era descriptions — the git view section described clicking a branch name in the navbar (replaced months ago by a full main view with three tabs), no mention of multi-project management, file browser, settings, or which agents are actually supported. Changes: named Claude Code and Codex CLI as supported agents, added experimental Windows note, described multi-project workflow in step 2, added file browser and settings mentions in the review step, rewrote the git view section to cover Uncommitted/Last Turn/Compare tabs and the integrated file tree.

Files touched: `README.md`, `docs/todo.md` (removed #29, renumbered), `CHANGELOG.md`, `docs/implementation-log.md`. Closes todo #29 (originally #31).

## Suppressed Dialogs section in settings (2026-04-11)

Moved the three dialog suppression toggles (`showTrashWorktreeNotice`, `skipTaskCheckoutConfirmation`, `skipHomeCheckoutConfirmation`) out of the "Git & Worktrees" section in the settings dialog into a new dedicated "Suppressed Dialogs" section placed after "Layout & Debug" at the bottom of Global settings. This gives users a single, discoverable place to re-enable any dialog they've previously dismissed.

The checkout confirmation toggles were also flipped from negative phrasing ("Skip X confirmation") to positive ("Show X confirmation") with inverted binding logic (`checked={!skipTaskCheckoutConfirmation}`, `onCheckedChange={(checked) => setSkipTaskCheckoutConfirmation(!checked)}`), so the toggle-on state means "show the dialog" — consistent with the trash worktree notice toggle which was already positive-phrased.

Added a "Dialog suppression" convention to AGENTS.md requiring that every future "don't show again" checkbox use a config field in `global-config-fields.ts` and have a re-enable toggle in this section. Closes todo #29.

Files touched: `AGENTS.md`, `web-ui/src/components/runtime-settings-dialog.tsx`, `CHANGELOG.md`, `docs/todo.md`, `docs/implementation-log.md`.

## Fix: LLM title/summary prompts hardened against non-content responses (2026-04-11)

Addresses todo #30. The LLM prompts used for generating task titles, branch names, and display summaries could occasionally return questions, clarifications, refusals, or responses prefixed with preamble like `"Title: ..."` or `"Here's a title: ..."` instead of the raw content. A bad title displayed on a card is preferable to a non-title response that looks broken.

**Two-layer fix**:

1. **Prompt hardening**: Added a `CRITICAL RULES` block to all three system prompts (`TITLE_SYSTEM_PROMPT`, `BRANCH_NAME_SYSTEM_PROMPT`, `SUMMARY_SYSTEM_PROMPT`) explicitly forbidding questions, refusals, preamble prefixes, and clarification requests. Instructs the model that a bad guess is always preferable to a non-content response.

2. **Response sanitizer** (`sanitizeLlmResponse()` in `llm-client.ts`): Defense-in-depth post-processing applied inside `callLlm()` so all callers benefit. Strips: outer quotes (single/double), known preamble patterns (`Title:`, `Here's a title:`, `Sure,`, `Certainly!`), and trailing conversational noise (`let me know...`, `would you like...`). Rejects responses that start with question or refusal patterns (`I can't...`, `What kind of...`, `Could you provide...`) by returning `null`, which all callers already handle gracefully.

Files touched: `src/title/llm-client.ts`, `src/title/title-generator.ts`, `src/title/summary-generator.ts`, `test/runtime/title/llm-client.test.ts` (17 new sanitizer tests). Commit `b2acee7a`.

## Fix: Compare tab branch pill dropdowns not opening (2026-04-11)

`BranchPillTrigger` was a plain function component that only accepted `{ label }`. When used as a child of `<RadixPopover.Trigger asChild>`, Radix's internal Slot called `cloneElement` to inject `onClick`, `aria-expanded`, `data-state`, and a `ref` — but since the component didn't spread rest props or forward refs, those were silently dropped. The pills rendered correctly but never opened the popover on click.

Fix: converted `BranchPillTrigger` to use `React.forwardRef` and spread `...rest` props onto the root `<button>`, placed before hardcoded `type="button"` and `aria-label` so those can't be overridden. Added the `asChild` + `forwardRef` requirement to AGENTS.md tribal knowledge.

Files touched: `web-ui/src/components/detail-panels/branch-selector-popover.tsx`, `AGENTS.md`. Commit `15fe9379`.

## Git view rework — promote diff viewer to full main view (2026-04-11)

Promoted the diff viewer from the "Changes" sidebar panel to a full main view called "Git" with three internal tabs. Addresses todo #4 (diffing portion) and todo #12 (interactive base ref switcher). The remaining branch management scope from #4 is now tracked as #21 (branch management in git view). Follow-up items #22 (commit sidebar tab) and #23 ("compare against" context action) were created.

**Frontend changes**:
- `use-card-detail-layout.ts`: Added `"git"` to `MainViewId`, removed `"changes"` from `SidebarId`. Migration maps old `"changes"` localStorage value to `"git"`. Auto-coupling keeps git view active when task is deselected (unlike terminal, which falls back to home).
- `git-view.tsx` (new): Top-level component with tab bar (Uncommitted / Last Turn / Compare), integrated file tree panel (toggleable, resizable, width persisted to `GitViewFileTreeRatio`), and diff content area using existing `DiffViewerPanel` and `FileTreePanel`. Tab persistence via `GitViewActiveTab` localStorage key. Resets all state on project switch.
- `use-git-view-compare.ts` (new): Manages Compare tab state — default refs from task context or home git summary, source/target pill state, browsing indicator (only when source ref differs from default), override detection for "Return to context" button, git refs fetching via `workspace.getGitRefs`. Accepts `pendingNavigation` for external callers to open Compare with pre-set refs.
- `detail-toolbar.tsx`: Git button (`GitCompareArrows` icon) added above divider as `MainViewButton`. "Changes" sidebar button removed. Badge prop changed from `hasUncommittedChanges`/`hasUnmergedChanges` booleans to `gitBadgeColor: "red" | "blue" | undefined`.
- `App.tsx`: Computes `gitBadgeColor` for both task context (from `selectedTaskWorkspaceSnapshot`) and home context (from `homeGitSummary`). Renders `GitView` in both no-task (home) and task (`CardDetailView` passthrough) contexts. `openGitCompare` callback + `pendingCompareNavigation` state provide external navigation API.
- `card-detail-view.tsx`: Removed all diff/changes rendering. Now renders `GitView` when `mainView === "git"`, passing through compare navigation props.
- `use-runtime-workspace-changes.ts`: Extended with `fromRef`/`toRef` optional parameters, included in request key for cache invalidation.
- `local-storage-store.ts`: Added `GitViewFileTreeRatio` and `GitViewActiveTab` keys.

**Backend changes**:
- `api-contract.ts`: `runtimeWorkspaceChangesRequestSchema` now accepts `taskId: z.string().nullable()` (was required string) and optional `fromRef`/`toRef` strings.
- `workspace-api.ts` `loadChanges()`: Four routing paths — (A) `fromRef`+`toRef` set → `getWorkspaceChangesBetweenRefs` against task CWD or home repo; (B) no `taskId` → `getWorkspaceChanges(workspacePath)` for home uncommitted; (C/D) `taskId` set → existing task-scoped behavior.
- `get-workspace-changes.ts`: Added `validateRef()` — rejects refs starting with `-` or containing `..` (same validation as file browser's `listFilesAtRef`).

Files touched: 16 files (4 new, 12 modified). Spec at `docs/specs/2026-04-11-git-view-rework.md`. Plan at `docs/plans/2026-04-11-git-view-rework.md`.

## Refactor: extract SessionSummaryStore from TerminalSessionManager (2026-04-11)

Decoupled session summary state management from terminal process lifecycle to address todo #16 (formerly #17). `TerminalSessionManager` was a 1348-line god object owning both summary data and PTY process lifecycle. External code (7+ files) reached into the manager for summary reads and mutations, creating tight coupling.

**Approach**: Extracted a `SessionSummaryStore` interface + `InMemorySessionSummaryStore` class that owns the `Map<taskId, RuntimeTaskSessionSummary>`, all pure-data mutations (state machine transitions, hook activity merging, conversation summaries, turn checkpoints), and change subscriptions. The manager takes the store via constructor injection and delegates all summary operations to it. A constructor `store.onChange()` subscription relays summary changes to per-task terminal listeners, ensuring hook-driven mutations from external callers (hooks-api, runtime-api) still reach the browser terminal panels synchronously.

**Key design decisions**:
- Store is synchronous with no process-specific logic — maps 1:1 to a Go interface for the backend rewrite (#1).
- Store exposed as `manager.store` (public readonly) — simplest path, avoids a parallel store registry.
- `hydrateFromRecord` stays on the manager (coordinates both store + process entry map).
- Constructor subscription handles per-task listener relay for all store mutations, replacing scattered `notifyListeners` calls.

Files touched: `src/terminal/session-summary-store.ts` (new, 431 lines), `src/terminal/session-manager.ts` (net -260 lines), `src/server/workspace-registry.ts`, `src/server/runtime-state-hub.ts`, `src/server/shutdown-coordinator.ts`, `src/trpc/workspace-api.ts`, `src/trpc/hooks-api.ts`, `src/trpc/runtime-api.ts`, 8 test files updated, `docs/plans/2026-04-11-session-summary-store-extraction.md` (implementation plan).

## Fix: stale review sessions recover instead of dropping to idle (2026-04-11)

When an agent process exited while a task was in `awaiting_review` and no WebSocket listeners were attached (user not viewing that task), the `shouldAutoRestart` check in `onExit` returned false (0 listeners). The session stayed in `awaiting_review` with `entry.active = null`. When the user later clicked the card and the terminal WebSocket connected, `recoverStaleSession` saw `active === null` + `isActiveState(state) === true` and unconditionally reset to `idle` — losing review context and confusing the user.

**Root cause**: `recoverStaleSession` couldn't distinguish "process launched this server lifetime and exited" (recoverable) from "entry hydrated from persisted state after server restart" (genuinely gone). Both had `entry.active === null` with an active state.

**Fix**: Use `entry.restartRequest` as the discriminator — set when `startTaskSession` is called, null on hydration. Three paths:
- `restartRequest.kind === "task"` + `reviewReason !== "exit"`: transition to `awaiting_review/error` and call `scheduleAutoRestart` (agent relaunches)
- `restartRequest.kind === "task"` + `reviewReason === "exit"`: return summary as-is (agent completed normally)
- `restartRequest === null`: reset to idle (hydrated entry, unchanged behavior)

Also added `checkProcesslessActiveSession` reconciliation check that proactively detects tasks in active states (`running`, `awaiting_review/hook`, `awaiting_review/attention`) with no process and `restartRequest` set. Transitions to `awaiting_review/error` so the card shows "Error" instead of a stale status badge — even before the user clicks. Skips already-classified exits (`error`, `exit`, `interrupted`) to avoid double-handling.

Files touched: `src/terminal/session-manager.ts` (recoverStaleSession, applyReconciliationAction), `src/terminal/session-reconciliation.ts` (ReconciliationEntry, checkProcesslessActiveSession, reconciliationChecks), `test/runtime/terminal/session-manager-interrupt-recovery.test.ts`, `test/runtime/terminal/session-reconciliation.test.ts`.

Commit: `61b64e2d`.

## Project switcher drag-and-drop reorder (2026-04-11)

Added drag-and-drop reordering for projects in the sidebar. The workspace index file (`~/.quarterdeck/workspaces/index.json`) gained a `projectOrder: string[]` field — an ordered array of workspace IDs. The Zod schema uses `.optional().default([])` for backward compatibility with existing index files. When `projectOrder` is empty, `listWorkspaceIndexEntries()` falls back to the previous alphabetical-by-path sort. When populated, entries sort by position in the array, with unmatched entries appended alphabetically.

**Backend**: New `projects.reorder` tRPC mutation calls `updateProjectOrder()` which acquires the index file lock, validates IDs against existing entries, preserves concurrently-added projects (appends any entry IDs not in the caller's list), and writes. `ensureWorkspaceEntry()` appends new projects to the end of `projectOrder`. `removeWorkspaceIndexEntry()` filters the removed ID. After reorder, the server broadcasts `projects_updated` so all connected clients see the new order.

**Frontend**: `ProjectNavigationPanel` wraps the project list in `DragDropContext`/`Droppable`/`Draggable` from `@hello-pangea/dnd` (already a dependency for board cards). Each `ProjectRow` gets a `GripVertical` drag handle (visible on hover via `group`/`group-hover`, hidden with ≤1 project). Drag initiates only from the handle — row clicks still navigate. Dragged items portal to `document.body` to avoid scroll container clipping. Optimistic local state (`optimisticOrder` + `prevProjectIdsRef`) prevents visual snap-back during the server roundtrip — cleared when the `projects` prop changes (server broadcast arrived).

Files touched: `src/core/api-contract.ts`, `src/core/api-validation.ts`, `src/state/workspace-state.ts`, `src/trpc/app-router.ts`, `src/trpc/projects-api.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/project-navigation-panel.tsx`, `web-ui/src/hooks/use-project-navigation.ts`.

Closes todo #24.

## Settings dialog section reorder (2026-04-11)

Reorganized the settings dialog (`runtime-settings-dialog.tsx`) to put frequently used settings near the top and group related items under fewer headings. No logic, state, or behavior changes — purely JSX reordering and heading renames.

**New section order under Global**: Agent → LLM Generation → Sound notifications (moved up from #8) → Terminal (merged with Terminal rendering — reset button now lives under font weight) → Git & Worktrees (merged from Changes + Trash + Git, sub-headings removed, `mt-3` spacing added between items) → Git Polling (demoted from `h5` to `h6`, moved from bottom of dialog) → Layout & Debug (merged from Layout + Debug). Project and Script shortcuts unchanged.

Section count reduced from 14 to 9. No new state variables, no config schema changes, no test changes needed (tests don't reference section headings).

Files touched: `web-ui/src/components/runtime-settings-dialog.tsx`.

Commit: `30c7b106`.

## Immediate running transition on prompt submit (2026-04-11)

When a user submitted review comments to an agent (Claude Code), the task card stayed in `awaiting_review` for 500ms–2s while waiting for the agent's plugin to fire a `to_in_progress` hook via `quarterdeck hooks ingest`. The delay was architectural: `writeInput()` wrote to the PTY and returned the unchanged summary — no state transition fired until the agent's event bus callback ran asynchronously.

**Fix**: Added an eager transition in `writeInput()` that detects CR/LF bytes while the session is in `awaiting_review` with an eligible `reviewReason` (attention, hook, or error) and immediately calls `applyTransitionToRunning()`. This is the same method the hook system uses, so behavior is identical — the agent's hook arrives later as a no-op since the state is already `"running"`. The `canReturnToRunning()` guard (from the state machine) prevents transitions from `exit` or `interrupted` states. Codex is excluded because it has its own prompt-ready detection via `detectOutputTransition`.

The change is safe for all input paths: review comment paste (no CR/LF, no transition), review comment submit (CR triggers transition), direct terminal typing (CR triggers transition), and interrupt after submit (interrupt recovery still fires because state is now `"running"`).

Files touched: `src/terminal/session-manager.ts` (import + 10-line guard in `writeInput()`).

Closes todo #25. Commit: `268cf001`.

## Error boundary disconnection detection (2026-04-10)

When the Quarterdeck server shuts down, two things happen simultaneously: the WebSocket `onclose` fires (dispatching a React state update) and components depending on server data throw during their next render cycle. The `AppErrorBoundary` (wrapping the entire tree in `main.tsx`) caught those render errors before `isRuntimeDisconnected` state propagated to the check in `App.tsx`, so users saw a confusing minified React error #300 instead of the clean "Disconnected from Quarterdeck" fallback.

**Fix**: A module-level boolean flag (`runtime-connection-state.ts`) is set synchronously in the WebSocket `onclose`/`onerror` handlers, before any React re-render. The `AppErrorFallback` component checks `isRuntimeDisconnected()` first — if true, it renders `RuntimeDisconnectedFallback` instead of the generic crash card. The flag is cleared on `onopen` so reconnection works correctly.

Also upgraded `RuntimeDisconnectedFallback` from plain centered text to a polished card (rounded border, `Unplug` icon, descriptive message, Reload button) matching the error boundary's card style. Both the error-boundary path and the `App.tsx` state-check path now share the same component.

Files touched: `web-ui/src/runtime/runtime-connection-state.ts` (new), `web-ui/src/runtime/use-runtime-state-stream.ts`, `web-ui/src/components/app-error-boundary.tsx`, `web-ui/src/hooks/runtime-disconnected-fallback.tsx`, `test/integration/runtime-state-stream.integration.test.ts`.

Commit: `90835014`.

## Dual-selection sidebar rework (2026-04-10)

Split the sidebar toolbar from a single `SidebarTabId` state into two independent dimensions: `mainView` ("home" | "terminal" | "files") and `sidebar` ("projects" | "task_column" | "changes" | null). The toolbar is visually split by a divider — main view buttons above with filled-bg highlight, sidebar buttons below with left-border accent highlight.

**State management** (`use-card-detail-layout.ts`): Full rewrite. `MainViewId` + `SidebarId` types replace the old `SidebarTabId`. `setMainView()` handles auto-coupling (Home → projects + deselect, Files/Terminal → no side effects). `toggleSidebar()` handles collapse-on-reclick. Auto-coupling `useEffect` fires on `selectedTaskId` changes with an initial-mount guard to avoid overwriting state on first render. `visualSidebar` returns null when `mainView === "files"` since the file tree overrides the sidebar panel. State always initializes to home+projects — localStorage is written for within-session use but not read on mount (view state is transient).

**Toolbar** (`detail-toolbar.tsx`): Split into `MainViewButton` (filled bg) and `SidebarButton` (left-border accent). Disabled state priority fix: `disabled` branch renders first in `cn()` chain, and `isActive` gates on `!disabled` so previously-active-now-disabled buttons don't flash their highlight.

**Files view with selected task** (`card-detail-view.tsx`): Restored file browser handling that was initially removed during the rework. When `mainView === "files"` with a selected task, CardDetailView renders `ScopeBar` + `FileBrowserTreePanel` in the sidebar panel and `FileContentViewer` in the main content area, using the task's worktree scope (`useFileBrowserData`, `useScopeContext`).

**Per-project approval indicators** (`use-runtime-state-stream.ts`, `App.tsx`, `project-navigation-panel.tsx`): The `task_notification` wire message already included `workspaceId` but the frontend was dropping it. Now preserved in a `notificationWorkspaceIds: Record<taskId, workspaceId>` map. `projectsBadgeColor` and `projectIdsWithApprovals` both exclude the current project (its approvals are visible on the board). Orange dot rendered next to project names in the sidebar.

**New localStorage keys** (`local-storage-store.ts`): `DetailMainView`, `DetailSidebar`, `DetailLastSidebarTab` — with migration from the old `DetailActivePanel` key.

Files touched: `use-card-detail-layout.ts`, `use-card-detail-layout.test.ts`, `detail-toolbar.tsx`, `App.tsx`, `card-detail-view.tsx`, `card-detail-view.test.tsx`, `project-navigation-panel.tsx`, `use-project-navigation.ts`, `use-runtime-state-stream.ts`, `local-storage-store.ts`.

Closes todo #5. Commits: `cce4e782`, `95f29f09`, `c9a8bcd8`.

## Configurable terminal font weight (2026-04-10)

Terminal font weight was hardcoded at 350 in `terminal-options.ts`. Made it configurable through the standard settings pipeline.

**Config layer**: Added `terminalFontWeight: numField(325)` to the global config field registry. The registry's generic spread (`extractGlobalConfigFields`) auto-includes it in API responses. Added to Zod schemas: `z.number()` on response, `z.number().min(100).max(900).optional()` on save request. Default lowered from 350 to 325 for thinner terminal text.

**Terminal rendering**: `createQuarterdeckTerminalOptions` now requires a `fontWeight: number` parameter (no default — single-sourced from config). Module-level `currentTerminalFontWeight` in `persistent-terminal-manager.ts` is initialized from `CONFIG_DEFAULTS.terminalFontWeight` and updated via `setTerminalFontWeight()`, which iterates all live terminals and sets `terminal.options.fontWeight`. This pattern follows the existing `resetAllTerminalRenderers` module-level approach.

**Settings UI**: Number input (100–900, step 25) in the Terminal section of the settings dialog, following the standard state/dirty-check/sync/save pattern.

**App wiring**: `useEffect` in `App.tsx` calls `setTerminalFontWeight(terminalFontWeight)` when the config value changes, applying to all live terminals without restart.

**Files**: `src/config/global-config-fields.ts`, `src/core/api-contract.ts`, `web-ui/src/terminal/terminal-options.ts`, `web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, `web-ui/src/runtime/use-runtime-config.ts`, `web-ui/src/terminal/terminal-options.test.ts`, `test/runtime/config/runtime-config.test.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`

## Statusline headless worktree display + pulse cleanup (2026-04-10)

The CLI statusline (`quarterdeck statusline`) showed no git info at all for detached HEAD worktrees — `getGitBranch` returned null for HEAD and the entire git section was skipped. Headless worktrees (quarterdeck's default isolation mode) appeared as just the directory name with no branch/hash context.

**Fix**: Replaced `getGitBranch` with `getGitHead` that returns a discriminated union: `{type: "branch", label}` or `{type: "detached", label: shortHash}`. For detached HEAD, resolves the short hash via `git rev-parse --short HEAD` and reads `QUARTERDECK_BASE_REF` from the environment to display "based on {baseRef}". The env var is set by the runtime when spawning agent sessions — added to both `startTaskSession` (initial launch) and `buildRestartRequest` (migration restart) in `runtime-api.ts`.

Also added "based on {baseRef}" to the web UI top bar (`TopBarGitStatusSection`) for consistency with the scope bar, which already showed this info.

**Pulse cleanup**: Removed the `pulse/` Rust reference source directory and `docs/plans/pulse-statusline-integration.md` (completed plan) from the repo. The port to TypeScript was already complete. Removed via rebase amend on the statusline commit to keep pulse out of git history entirely (not yet pushed). Removed todo #6 (Pulse integration) — completed.

**Files**: `src/commands/statusline.ts`, `src/trpc/runtime-api.ts`, `web-ui/src/components/top-bar.tsx`, `docs/todo.md`, `CHANGELOG.md`


## Project switcher sidebar tab (2026-04-10)

Added a dedicated "Projects" tab to the sidebar toolbar so users can switch projects from any context without clicking Home (which deselects the current task). This addresses todo #6 (project switcher in detail toolbar) and #16 (notification badges on project sidebar).

**What changed:**
- `web-ui/src/resize/use-card-detail-layout.ts`: Added `"projects"` to `SidebarTabId` union type. `handleTabChange("projects")` opens the sidebar without calling `setSelectedTaskId(null)` — the key behavioral difference from "home". Auto-switch `useEffect` preserves "projects" tab on task deselect (added to the stay-put list alongside "files").
- `web-ui/src/components/detail-panels/detail-toolbar.tsx`: Added FolderKanban Projects button between Home and divider, always enabled. Extended `badgeColor` type to include `"orange"` mapping to `bg-status-orange`. New `projectsBadgeColor` prop on `DetailToolbarProps`.
- `web-ui/src/App.tsx`: Sidebar rendering condition expanded from `activeTab === "home"` to `activeTab === "home" || activeTab === "projects"` — both render the same `ProjectNavigationPanel` with identical props. Badge computed as `Object.values(notificationSessions).some(isApprovalState) ? "orange" : undefined`. Note: `notificationSessions` is seeded from the current project only on initial load; cross-project entries arrive incrementally via `task_notification` messages.

**What didn't change:**
- `card-detail-view.tsx`: No changes needed — `isTaskSidePanelOpen` only matches `task_column | changes | files`, so "projects" falls through to no-sidebar correctly.
- `project-navigation-panel.tsx`: Reused as-is, no visual changes.
- Backend: No changes. Task count sync (todo #19) investigated — `broadcastRuntimeProjectsUpdated` is already called on every session flush, and `displayedProjects` in `use-project-ui-state.ts` correctly overrides the current project's counts from `countTasksByColumn(board)`.

**Design decision:** The "projects" tab is a separate toolbar icon from "home" rather than replacing it. Home stays for deselecting tasks and returning to the board overview. Projects is for quick project switching without disrupting the current task context. A future dual-selection rework (new todo #5, spec at `docs/specs/2026-04-10-dual-selection-sidebar-rework.md`) will split the toolbar into independent main-view and sidebar dimensions.

Commit: ea1ec7fc

## Native Claude Code statusline (2026-04-10)

Ported the `pulse` Rust CLI statusline tool to TypeScript as a native quarterdeck feature. Pulse used Starship (an external binary) to render a two-line prompt — line 1 from Starship's shell context modules (`$all`), line 2 from Claude session metrics formatted as environment variables. The port drops both the Rust binary and the Starship dependency, rendering directly with ANSI escape codes.

**Line 1 (shell context)**: Directory basename with folder icon (bright cyan), `on` keyword (default grey), git branch with icon (purple), git status indicators `[+!?]` (yellow), battery percentage with icon and color tiers (green/yellow/red). Git branch via `execFileSync("git", ["rev-parse", ...])`, status via `git status --porcelain`, battery via `pmset -g batt` (macOS) or `/sys/class/power_supply/BAT0/capacity` (Linux). All subprocess calls have 2-second timeouts since Claude Code polls the statusline frequently.

**Line 2 (Claude metrics)**: Session ID (last 8 chars, dim white), model with Nerd Font icon — brain for Opus, hubot for Sonnet, bolt for others (cyan), context window usage with tier coloring — OK green <50%, WARN yellow 50-80%, CRIT red >80%, cost (yellow, glyph only — no literal `$` to avoid double-dollar with the Nerd Font dollar glyph), duration in top-2 units (bright yellow), cumulative tokens in/out (bright yellow), lines added (green), lines removed (red).

**Agent integration**: The Claude adapter in `agent-session-adapters.ts` already writes a settings JSON for hooks and passes it via `--settings`. Added `statusLine: { type: "command", command: "quarterdeck statusline" }` to this same object. Claude Code merges `--settings` with global config, so this overrides any user-configured statusline (e.g., standalone pulse) for quarterdeck-managed sessions only — standalone sessions keep their own config.

**Config toggle**: Added `statuslineEnabled` boolean (defaults `true`) to the global config field registry in `global-config-fields.ts`. Threaded through `api-contract.ts` (response + save request schemas), `runtime-api.ts` (passed to `startTaskSession`), `session-manager.ts` (forwarded to `prepareAgentLaunch`), and `agent-session-adapters.ts` (conditionally includes `statusLine` in settings). When disabled, the statusline key is omitted entirely.

**Input validation**: Added Zod schema matching Claude Code's statusline JSON contract. Uses `safeParse` with structured error output to stderr on validation failure, plus a defense-in-depth try/catch around the render call. Shell quoting via `quoteShellArg` on command parts to handle paths with spaces.

**Intentional divergences from Rust original**: Token formatting adds `>= 1M` tier (Rust only had `>= 1k`), lines changed show `+`/`-` prefix (Rust showed bare numbers), directory shows basename only (Rust delegated to Starship's full path rendering).

**Files**: `src/commands/statusline.ts` (new, 428 lines), `src/cli.ts`, `src/config/global-config-fields.ts`, `src/core/api-contract.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-manager.ts`, `src/trpc/runtime-api.ts`, `test/runtime/config/runtime-config.test.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`

**Commits**: `e94d6e4c`, `f19843e0`

## Fix: unmerged-changes badge false positive after squash merge (2026-04-10)

Third fix in the `hasUnmergedChanges` detection chain. History: original feature used two-dot diff (`baseRef HEAD`), which showed false positives when main advanced ahead (behind-base commits appeared as unmerged). Commit `87639770` switched to three-dot (`baseRef...HEAD`) to only detect branch-introduced changes. But three-dot still reports changes when the branch's work has already landed via squash merge or commit-tree — the commit graphs diverge even though the trees are identical.

**Fix**: Added a parallel two-dot tree comparison (`git diff --quiet baseRef HEAD`) as a guard. When the three-dot diff reports unmerged changes (exit 1), the two-dot check verifies the trees actually differ. If trees are identical (exit 0), the badge is suppressed. This doesn't regress the behind-base case because when a worktree is only behind (no changes of its own), the three-dot already returns exit 0 and the two-dot guard is never consulted.

**Edge case**: If changes landed via squash AND main advanced further, the two-dot diff shows differences (from main's additional commits), so `hasUnmergedChanges` stays `true`. This is a minor false positive but the behind-base indicator on the Files icon would also be showing, giving correct overall signal.

**Files**: `src/server/workspace-metadata-monitor.ts`

**Commits**: `8be33dcd`, `dc847cc8`

## Debug log panel — right-side push layout, stop button, global error capture (2026-04-10)

Converted the debug log panel from a bottom overlay (220px height, `border-t`) to a right-side push panel (420px width, `border-l`, `shrink-0`) within the main flex row. The panel pushes the board content rather than overlapping it.

**Panel header rework**: Split the header into two rows — top row has title, entry count, and action buttons (Clear, Stop, Close); bottom row has level filter, source filter, search input, and a "Console" toggle checkbox. The Stop button (Power icon) disables server-side logging AND closes the panel, as opposed to Close (X) which only hides it.

**Stop-logging timing fix**: `stopLogging` immediately calls `setClientLoggingEnabled(false)`, `registerClientLogCallback(null)`, and `setGlobalErrorCallback(null)` before the async tRPC round-trip to the server. This prevents entries from accumulating invisibly during the server acknowledgment gap.

**Global error capture** (`web-ui/src/utils/global-error-capture.ts`, new): Module installed once at app startup in `main.tsx`. Captures three categories: (1) uncaught errors via `window.addEventListener("error")`, tagged "uncaught"; (2) unhandled promise rejections via `window.addEventListener("unhandledrejection")`, tagged "unhandled-rejection"; (3) intercepted `console.error`/`console.warn`, tagged "console". The patched console methods have an early bail (`if (!callback || isEmitting) return`) so there's zero overhead when logging is off, and no string formatting happens unnecessarily.

**Duplicate entry prevention**: `client-logger.ts` calls `console[level]()` which would be re-captured by the patched console methods. Fixed by sharing an `isEmitting` flag — `client-logger.emit()` sets `setIsEmitting(true)` around its console call, and the patched console methods bail when the flag is set. This is a cross-module coupling documented in both files' header comments.

**Console noise opt-in**: Console-intercepted entries (React dev warnings, xterm.js canvas errors, library deprecation notices) are hidden by default. The `filteredEntries` memo in `useDebugLogging` excludes entries with `tag === "console"` unless `showConsoleCapture` state is true. A "Console" checkbox in the filter bar toggles this. Uncaught errors and unhandled rejections always show since they have different tags.

**Error surfaces wired to debug panel**: `notifyError` in `app-toaster.ts` now calls `createClientLogger("toast").error()` before showing the toast. `use-runtime-state-stream.ts` added a `createClientLogger("ws-stream")` for WebSocket connection failures and malformed message warnings.

**Files**: `web-ui/src/utils/global-error-capture.ts` (new), `web-ui/src/utils/client-logger.ts`, `web-ui/src/components/debug-log-panel.tsx`, `web-ui/src/hooks/use-debug-logging.ts`, `web-ui/src/components/app-toaster.ts`, `web-ui/src/runtime/use-runtime-state-stream.ts`, `web-ui/src/main.tsx`, `web-ui/src/App.tsx`

**Commits**: `1bb3b6e8`, `352106c5`, `250f0b62`

## Fix: prevent orphaned processes when parent exits without signaling (2026-04-10)

Addresses todo #5. Four zombie processes from `.cline/worktrees/` were found running days after their parent tasks ended (see `docs/research/2026-04-08-orphaned-process-investigation.md`). Three root causes identified and fixed:

**Stdin pipe EOF detection** (`src/cli.ts`): Added parent liveness detection for child-process launches. When quarterdeck is spawned by Cline, an agent, or another process, stdin is a pipe (`net.Socket`). If the parent exits without sending SIGTERM/SIGINT, the pipe closes — now detected via `process.stdin.on("end", ...)` which sends SIGHUP to self, funneling through the existing graceful shutdown handler. Guard uses `process.stdin instanceof NetSocket && !process.stdin.isTTY` to correctly distinguish pipes from TTY (direct terminal, where SIGHUP already handles close) and `/dev/null` (`stdio: "ignore"` in test harnesses). The `!isTTY` check is necessary because `tty.ReadStream` extends `net.Socket`, so `instanceof` alone would match TTY stdin and cause Ctrl-D to unexpectedly kill the server.

**Shutdown coordinator cleanup timeout** (`src/server/shutdown-coordinator.ts`): The parallel `Promise.all` that persists workspace state and deletes worktrees had no timeout. If any operation hung (e.g., `git worktree remove` on a corrupted worktree, `saveWorkspaceState` on a locked file), the entire shutdown stalled until the 10s hard process timeout killed it mid-I/O — skipping `closeRuntimeServer()` entirely. Added a 7s internal timeout via `Promise.race` so the server close always runs orderly within the 10s window.

**Codex wrapper cleanup timeout** (`src/commands/hooks.ts`): The `cleanup()` function in `runCodexWrapperSubcommand` awaited `watcherStartPromise` + `stopWatcher()` with no timeout. If either stalled, the wrapper process hung forever. Added a 3s timeout via `Promise.race`.

**Test**: New `test/runtime/shutdown-coordinator-timeout.test.ts` — mocks `saveWorkspaceState` to never resolve (simulating hung filesystem I/O), verifies `closeRuntimeServer` is still called after the 7s timeout. Also verifies the normal path (cleanup within timeout) works without warnings.

**Files**: `src/cli.ts`, `src/commands/hooks.ts`, `src/server/shutdown-coordinator.ts`, `test/runtime/shutdown-coordinator-timeout.test.ts`

## Terminal font weight and ligature tuning (2026-04-10)

Previous commits went from Regular (400) weight → Light (300) to combat chunky WebGL rendering on low-DPR monitors. 300 turned out to be too thin. Set `fontWeight: 350` as a numeric value (xterm's `FontWeight` type accepts `number`) — the browser snaps to an intermediate rendering between Light and Regular discrete font files. `fontWeightBold` set to `"500"` (Medium) for subtle emphasis without the heaviness of 700.

Also reverted the NL (No Ligatures) font variant switch from `df2cd2d0`. The original rationale was that skipping ligature table processing might reduce visual weight in the WebGL renderer, but the commit itself noted it was "marginal." Ligatures (`=>`, `!=`, etc.) are useful and the NL variant wasn't pulling its weight as a rendering fix.

**Files**: `web-ui/src/terminal/terminal-options.ts`

## Backend domain boundary cleanup (2026-04-10)

Improved domain segregation in the backend to create cleaner boundaries for the eventual Go rewrite.

**Agent registry relocation**: Moved `agent-registry.ts` from `src/terminal/` to `src/config/`. The file builds `RuntimeConfigResponse` objects and imports config types (`RuntimeConfigState`, `extractGlobalConfigFields`), so it naturally belongs in the config domain. The terminal layer now has zero imports from config. Also moved `command-discovery.ts` (pure PATH inspection utility) from `src/terminal/` to `src/core/` since it was used by both `config/agent-registry.ts` and `server/browser.ts` — keeping it in terminal would have created a backwards dependency from config→terminal.

**Working directory resolution consolidation**: The pattern "check persisted directory → verify it exists on disk → fall back to resolveTaskCwd → handle legacy non-worktree tasks" was implemented three times:
1. `resolveTaskWorkingDirectory()` in `workspace-api.ts` (the good abstraction)
2. Inline in `startShellSession` in `runtime-api.ts`
3. Inline in `migrateTaskWorkingDirectory` in `runtime-api.ts`

Moved `resolveTaskWorkingDirectory` and `isMissingTaskWorktreeError` from `workspace-api.ts` to `workspace/task-worktree.ts` (where the primitive `resolveTaskCwd` lives). Added `ensure` and `branch` parameters. Updated `startShellSession` to call the shared function. Left `startTaskSession` and `migrateTaskWorkingDirectory` with their inline logic — `startTaskSession` has the home-session bypass, body.useWorktree flag, and branch threading that make it different enough; `migrateTaskWorkingDirectory` doesn't check if the persisted path exists on disk (intentional, since it's about to change it).

**Session summary dual-sourcing**: Documented the remaining coupling hotspot (terminal ↔ state read-back pattern) in `docs/research/2026-04-10-session-summary-dual-sourcing.md` and added TODO #22 with three decoupling options. Recommendation: design it right in the Go rewrite rather than refactoring TypeScript.

**Files moved**: `src/terminal/agent-registry.ts` → `src/config/agent-registry.ts`, `src/terminal/command-discovery.ts` → `src/core/command-discovery.ts`, `test/runtime/terminal/agent-registry.test.ts` → `test/runtime/config/agent-registry.test.ts`

**Files modified**: `src/config/runtime-config.ts` (import path), `src/trpc/runtime-api.ts` (import paths + startShellSession refactor), `src/trpc/workspace-api.ts` (removed local functions, updated imports and call sites), `src/server/browser.ts` (import path), `src/workspace/task-worktree.ts` (added resolveTaskWorkingDirectory + isMissingTaskWorktreeError + resolve/loadWorkspaceState imports), `test/runtime/trpc/runtime-api.test.ts` (mock paths + shell session test rewrite), `test/runtime/trpc/workspace-api.test.ts` (added new mocks, updated test setup), `docs/todo.md` (added #22, renumbered #23), `CHANGELOG.md`, `docs/research/2026-04-10-session-summary-dual-sourcing.md` (new)

## Board sidebar opens when clicking task from board view (2026-04-10)

Changed the `useCardDetailLayout` effect that fires on `selectedTaskId` changes. Previously, selecting a task from the home/board view (`currentTab === "home"`) collapsed the sidebar (`setActiveTab(null)`), giving a full-width terminal. Now it opens the `task_column` tab so the user sees the board column context alongside the terminal. The `currentTab === null` (manually collapsed) case is handled separately and stays collapsed, respecting the user's explicit preference.

Also added `setLastTaskTab("task_column")` so the tab is remembered as the last-used task tab, and added `setLastTaskTab` to the effect dependency array.

**Files**: `web-ui/src/resize/use-card-detail-layout.ts`

## Per-card hard delete in trash column (2026-04-10)

Added a permanent delete button (red `Trash2` icon) next to the existing restore button on each trash card. Previously, the only way to permanently delete a single trashed card was to clear all trash.

**Implementation**: Added `onHardDeleteTrashTask` to `StableCardActions` interface and `handleHardDeleteTrashTask` handler in `useBoardInteractions`. The handler uses `removeTask()` from `board-state.ts` (which already existed for bulk clear), then cleans up the session and workspace. The trash-column guard runs inside the `setBoard` updater callback (using fresh `currentBoard`) to avoid a TOCTOU race where a concurrent state update could move the card out of trash between the guard check and the irreversible delete. This also eliminates `board` from the callback's dependency array, reducing unnecessary re-renders of `StableCardActions` consumers.

The button is wired through `board-column.tsx` and `column-context-panel.tsx` (both trash card render sites) via the existing `CardActionsProvider` context pattern.

**Files**: `web-ui/src/hooks/use-board-interactions.ts`, `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/App.tsx`, `web-ui/src/components/board-card.tsx`, `web-ui/src/components/board-column.tsx`, `web-ui/src/components/detail-panels/column-context-panel.tsx`

**Closes**: todo #17

## Upstream sync tracker, browser nav, onboarding tips, dev:full (2026-04-10)

**Upstream sync tracker**: Replaced `docs/upstream-sync-2026-04-08.md` with a living `docs/upstream-sync.md`. Comprehensively reviewed all 22 upstream cline/kanban commits since fork point (`255e940d`). Categorized into Adopted (5 — incremental diff expand cherry-picked, editable titles / diff mode fix / plan mode / trash restore independently implemented), Backlog (2 — mobile responsive foundations, HTTPS+passcode auth), and Decided against (11 — Cline SDK/billing, color themes, etc.). Updated `docs/todo.md` items #9 and #24 to be recurring.

**Browser back/forward**: Created `web-ui/src/hooks/use-detail-task-navigation.ts` — manages `selectedTaskId` with URL search param `?task=<id>`. Uses `pushState` when opening a task (so browser back closes it), `replaceState` when clearing, and `popstate` listener for back/forward. Replaces raw `useState` + `useMemo` for `selectedTaskId`/`selectedCard` in `App.tsx`. Added `isBoardHydrated` guard to prevent URL task ID from being cleared before the board loads from the server. Added `parseTaskIdFromSearch` and `buildTaskSearchParam` utilities to `app-utils.tsx`.

**Onboarding tips**: Added `OnboardingTips` component in `project-navigation-panel.tsx` — 3 Quarterdeck-specific tips (create tasks, run in parallel, review changes), dismissible with X button, "Show tips" restore link. Uses `useBooleanLocalStorageValue` with new `OnboardingTipsDismissed` localStorage key. Positioned between project list and keyboard shortcuts card.

**Combined dev script**: Created `scripts/dev-full.mjs` — spawns `tsx watch src/cli.ts` and `npm --prefix web-ui run dev` as child processes, prefixes output with `[runtime]`/`[web-ui]`, kills both on exit. Added `dev:full` to `package.json` scripts and `CLAUDE.md` quick reference.

**Files**: `docs/upstream-sync.md` (new), `docs/upstream-sync-2026-04-08.md` (deleted), `docs/todo.md`, `web-ui/src/hooks/use-detail-task-navigation.ts` (new), `web-ui/src/hooks/app-utils.tsx`, `web-ui/src/App.tsx`, `web-ui/src/components/project-navigation-panel.tsx`, `web-ui/src/storage/local-storage-store.ts`, `scripts/dev-full.mjs` (new), `package.json`, `CLAUDE.md`, `CHANGELOG.md`

**Commit**: `48049bcb`

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
