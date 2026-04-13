# Changelog

## [Unreleased]

### Fix: Shift+Enter in agent terminal no longer moves task to running

- Pressing Shift+Enter to insert a newline in the agent terminal was triggering the optimistic "review → running" transition introduced in 03f08f81. The `writeInput()` CR/LF check treated LF (byte 10, sent by Shift+Enter) the same as CR (byte 13, sent by Enter). Now only CR triggers the optimistic transition.

### Feat: truncation-aware tooltip and wider branch dropdown

- Branch names in the `BranchSelectorPopover` dropdown now show a Radix tooltip with the full ref name (including `origin/` for remotes) when the text is truncated. Non-truncated names show no tooltip. Uses a fast 150ms delay instead of the global 400ms so it feels responsive when scanning a list.
- Branch dropdown widened from `w-72` (288px) to `w-80` (320px) to reduce truncation.
- New `TruncateTooltip` component in `tooltip.tsx` — checks `scrollWidth > clientWidth` on pointer enter and suppresses the tooltip when content fits. Reusable for any truncated text.
- Added optional `delayDuration` prop to the existing `Tooltip` component for per-instance delay override.

### UX: move task title to far left of top bar

- Task name now appears immediately after the back button instead of after the branch pill. Adds a "Task name" tooltip on hover for discoverability.

### Refactor: move pinnedBranches storage from project config to workspace directory

- Pinned branches are now stored in `~/.quarterdeck/workspaces/<id>/pinned-branches.json` instead of `<project>/.quarterdeck/config.json`. Prevents polluting user project repos with Quarterdeck state. No migration — existing pinned branches in project config are silently ignored; users will need to re-pin branches once.

### Fix: remove Open workspace dropdown and slim down git sync buttons

- Removed the "Open in VS Code" dropdown button from the top bar — it added clutter with minimal value. Fetch/pull/push buttons are now thinner (24px) with smaller icons for better toolbar density.

### Feat: orange badge on board sidebar icon when tasks need input

- The Board (LayoutGrid) sidebar button now shows an orange dot when any task in the current project is waiting for approval or needs user input. Mirrors the existing cross-project notification pattern on the Projects icon but scoped to the active project.

### Fix: remove duplicate settings controls, restore directory context menu, relocate shared diff components

- Removed leftover inline Git Polling controls from the settings dialog shell that duplicated the already-extracted `GitSection` component and caused TypeScript errors (undefined `clampPollInterval`).
- Fixed the file tree sidebar suppressing native right-click on directory rows — only file nodes are now wrapped in `ContextMenu.Root`, so directories get the browser's native context menu.
- Moved `DiffLineGutter` and `DiffCommentCallbacks` from `diff-unified.tsx` to `diff-viewer-utils.tsx` where other shared diff primitives live, eliminating the coupling where `diff-split` imported from `diff-unified`.

### Feat: inject worktree context into agent system prompt

- Claude Code agents launched in git worktrees now receive a system prompt injection that orients them about their isolation context — working directory identity, main repo location, parallel agent awareness, and git guardrails (no checkout/push/destructive ops unless explicitly asked). Detached HEAD state is noted when applicable. Guarded by CLI option checks to avoid conflicts with explicit `--append-system-prompt` flags.

### Feat: pin default base ref from branch dropdown

- The default base ref is now set directly from the branch dropdown in the task creation dialog via a pin icon on each branch option. Filled pin = current default (always visible), outline pin = appears on hover. Clicking the pin saves the config immediately and shows a toast confirmation. Clicking an already-pinned branch clears the default. Replaces the previous Settings > Git text input approach — more discoverable and doesn't require knowing branch names by heart.

### Fix: terminal rendering artifacts and stale canvas on task switch

- Switching to a task now triggers the agent to redraw its TUI — the mount-time cols-1 resize trick is sent to the server so the PTY sees an actual dimension change, delivers SIGWINCH, and the agent repaints cleanly. Previously the intermediate resize was local-only and the server never saw it.
- "Reset terminal rendering" button in settings now actually works — it calls `terminal.refresh()` + `forceResize()` after swapping the WebGL addon, and is no longer a no-op when WebGL is disabled.

### Feat: stalled tasks move to review column

- Sessions stuck in "running" without hook activity for 60+ seconds are now detected by the reconciliation sweep and marked as "stalled" instead of staying in the running state indefinitely. Stalled tasks appear in the review column with a green badge and explanatory tooltip. Auto-clears when hooks resume.

### Feat: preserve board state on graceful shutdown

- Graceful shutdown (Ctrl+C) no longer trashes all in-progress and review tasks. Cards stay in their columns; sessions are marked as "interrupted" with `pid: null`. On restart, the existing crash-recovery auto-restart infrastructure picks them up — same as after an unexpected crash. Eliminates the disruptive loss of board state on every restart.

### Feat: "Pull latest" in branch context menu

- Added a "Pull latest" action to the right-click context menu on branch refs in the git history panel and the git refs sidebar. Runs `git pull` scoped to the relevant task or home repo.

### Feat: rollback file from diff viewer context menu

- Right-clicking a file header in the diff viewer now includes a "Rollback file" action that restores the file to its base-ref version. Only shown for modified files (not new/deleted). Uses `git checkout <baseRef> -- <path>`.

### Feat: success toasts for git push/pull/fetch

- Push, pull, and fetch actions now show a brief success toast ("Pushed", "Pulled", "Fetched") on completion, matching the existing error toast pattern.

### Fix: debug flag icon shown independently of emergency actions

- The debug flag icon on in-progress cards was previously only visible when the "show emergency actions" setting was enabled. It now renders independently — the debug indicator is informational, not an emergency action.

### Fix: tooltip for truncated branch names in dropdown

- Branch names that overflow the dropdown width now show a tooltip with the full name on hover. Dropdown width also increased slightly to reduce truncation.

### Fix: duplicate Git Polling section in settings dialog

- Removed a duplicate inline "Git Polling" section from the settings dialog shell that was left over from the decomposition refactor. The section was already rendered by the extracted `GitSection` component. The duplicate used bare variable names (`focusedTaskPollMs` instead of `fields.focusedTaskPollMs`) causing TypeScript errors.

### Git view — file context menus

- Right-clicking a file name in the diff viewer (both file headers and the file tree sidebar) now shows a context menu with Copy name, Copy path, and Show in File Browser.
- Extracted shared `FileContextMenuItems` component in `context-menu-utils.tsx` — used by diff viewer, file tree, and file browser panels to eliminate duplicated context menu markup.

### Top bar scope indicator

- Added a colored left-edge accent to the top bar that mirrors the file browser scope bar — gray for home, blue for task, purple for branch view. When viewing a task, the task title is shown (truncated to 200px) so the current scope is always visible at a glance.

### Fix: pinned branches not shared across all branch dropdowns

- Git view compare bar's source and target branch selectors now receive pinned branches and pin/unpin callbacks, matching the top bar and file browser scope bar. Pinning a branch in any dropdown now appears everywhere.

### Refactor: continued module decomposition (tier-2 and tier-3 files)

- **codex-hook-events.ts** (1,015 → 3 files) — extracted `codex-session-parser.ts` (session log parsing + shared types), `codex-rollout-parser.ts` (rollout JSONL file I/O and parsing). The original file retains the watcher orchestration + barrel re-exports.
- **runtime-settings-dialog.tsx** (913 → 5 files) — extracted `agent-section.tsx`, `display-sections.tsx`, `general-sections.tsx`, `shortcuts-section.tsx` under `settings/`, with shared `settings-section-props.ts`. The dialog shell stays in the original file.
- **use-board-interactions.ts** (1,027 → 5 hooks) — extracted `use-board-drag-handler.ts`, `use-session-column-sync.ts`, `use-task-lifecycle.ts`, `use-task-start.ts`, `use-trash-workflow.ts`. The orchestrator hook composes them.
- **hooks.ts** (919 → 3 files) — extracted `hook-metadata.ts` (metadata building/enrichment) and `codex-wrapper.ts` (Codex wrapper spawn logic).
- **workspace-metadata-monitor.ts** (807 → 2 files) — extracted `workspace-metadata-loaders.ts` (git probe, task summary, file change loaders).
- **workspace-state.ts** (816 → 3 files) — extracted `workspace-state-index.ts` (workspace discovery/indexing) and `workspace-state-utils.ts` (snapshot helpers).
- **app-router.ts** (937 → 3 files) — extracted `app-router-context.ts` (context builder + middleware) and `workspace-procedures.ts` (workspace CRUD procedures). Added `app-router-init.ts` for tRPC initialization.
- **diff-renderer.tsx** (922 → 3 files) — extracted `diff-parser.ts` (unified diff parsing) and `diff-highlighting.ts` (syntax highlighting + line rendering).

### Refactor: split api-contract.ts into domain modules

- Split the 1,297-line monolithic `src/core/api-contract.ts` into 11 focused domain files under `src/core/api/`: `shared.ts`, `board.ts`, `workspace-files.ts`, `git-sync.ts`, `git-merge.ts`, `git-history.ts`, `task-session.ts`, `task-chat.ts`, `config.ts`, `workspace-state.ts`, `streams.ts`. Each file is 50–200 lines. The original `api-contract.ts` is now a 1-line barrel re-export — zero consumer changes needed.

### Refactor: code duplication cleanup across runtime and web-ui

- Consolidated duplicated git utilities into shared functions in `git-utils.ts`: `resolveRepoRoot`, `countLines`, `parseNumstatTotals`, `parseNumstatLine`, `runGitSync`. Eliminates duplicate implementations across `git-sync.ts`, `get-workspace-changes.ts`, and `workspace-state.ts`.
- Extracted shared `FileFingerprint` type and `buildFileFingerprints` builder to `file-fingerprint.ts` — was identically implemented in both `git-sync.ts` and `get-workspace-changes.ts`.
- Consolidated three near-identical `readDiffStat` / `readDiffStatBetweenRefs` / `readDiffStatFromRef` functions in `get-workspace-changes.ts` into a single `readDiffNumstat` helper.
- Extracted `isNodeError` to `src/fs/node-error.ts` — replaces ad-hoc ENOENT type-guard checks in `locked-file-system.ts`, `lock-cleanup.ts`, and `workspace-state.ts`.
- Removed duplicate `validateRef` from `get-workspace-changes.ts`, replaced with `assertValidGitRef` in `git-utils.ts`.
- Made `resolveTaskAutoReviewMode` and `getTaskAutoReviewCancelButtonLabel` in `web-ui/src/types/board.ts` functional — they previously ignored their input and always returned `"move_to_trash"` / `"Cancel Auto-trash"`.
- Extracted `toErrorMessage` utility to `web-ui/src/utils/to-error-message.ts` — replaces 42 inline `error instanceof Error ? error.message : String(error)` patterns across 18 web-ui files.
- Added `docs/code-duplication-audit.md` documenting all findings and remaining items.

### Refactor: extract 11 custom hooks from App.tsx

- Extracted inline state, callbacks, and effects from `App.tsx` into 11 focused custom hooks, reducing the file from 1,975 to 1,774 lines. The pre-JSX logic section shrinks by ~280 lines, replaced by hook calls. Effect-only hooks: `useStreamErrorHandler`, `useTaskTitleSync`, `useBoardMetadataSync`, `useTerminalConfigSync`, `useFocusedTaskNotification`. State+callback hooks: `useGitNavigation`, `useAppDialogs`, `useMigrateTaskDialog`. Cleanup/derived hooks: `useProjectSwitchCleanup`, `useEscapeHandler`, `useNavbarState`. All follow the existing single-options-object input / named-result-interface output convention. Zero behavior change.

### Refactor: extract session-manager.ts into focused modules

- Decomposed the 1,359-line monolithic `session-manager.ts` into 6 focused files: shared types/helpers (`session-manager-types.ts`), workspace trust auto-confirm (`session-workspace-trust.ts`), interrupt detection and recovery (`session-interrupt-recovery.ts`), auto-restart logic (`session-auto-restart.ts`), and reconciliation sweep orchestration (`session-reconciliation-sweep.ts`). The core lifecycle (start/stop/attach/write) stays in `session-manager.ts` at ~780 lines. Also deduplicated spawn-failure formatters, cols/rows normalization, active-state construction, and exit cleanup sequences. Zero behavior change.

### Refactor: large file decomposition — 8 modules split into focused units

- **git-sync.ts** (1,407 → ~240 lines) — extracted `git-probe.ts` (workspace probing, sync summary), `git-conflict.ts` (merge/rebase conflict resolution), `git-cherry-pick.ts` (cherry-pick via temp worktree), `git-stash.ts` (stash/pop/apply/drop). Core sync/checkout/commit/discard operations remain.
- **workspace-api.ts** — deduplicated error factories, extracted shared helpers, collapsed repetitive validation and response-building patterns. Net reduction of ~300 lines.
- **dependency-overlay.tsx** — extracted `dependency-geometry.ts` (path calculations, control points, arrow rendering), `use-dependency-layout.ts` (DOM measurement + layout), `use-side-transitions.ts` (animated opacity/scale transitions).
- **diff-viewer-panel.tsx** — extracted `diff-split.tsx` (side-by-side view), `diff-unified.tsx` (unified view), `diff-viewer-utils.tsx` (shared line rendering), `use-diff-comments.ts` (comment state), `use-diff-scroll-sync.ts` (scroll synchronization).
- **persistent-terminal-manager.ts** — extracted `terminal-registry.ts` (terminal instance lifecycle) and `terminal-socket-utils.ts` (WebSocket connection helpers).
- **task.ts** (CLI command) — extracted `task-board-helpers.ts` (board state queries), `task-lifecycle-handlers.ts` (start/stop/restart/trash handlers), `task-workspace.ts` (worktree operations).
- **Integration tests** — extracted shared utilities (`integration-server.ts`, `runtime-stream-client.ts`, `trpc-request.ts`, `temp-dir.ts`, `git-env.ts`) from 6 integration test files, eliminating ~220 lines of duplicated setup code.
- **runtime-settings-dialog.tsx** — extracted `SettingsSwitch` and `SettingsCheckbox` to `ui/settings-controls.tsx`, replacing ~80 inline Radix Switch/Checkbox + label patterns.

### Fix: terminal renders at half width after untrashing a task

- When a task was untrashed, the terminal canvas could render at the wrong width until the user manually resized the window. Root cause: the WebGL renderer initialized its canvas while the host element was in the offscreen parking root (1px × 1px), and xterm's FitAddon skips `terminal.resize()` when cols/rows match the current values, leaving the canvas stale. Added a deferred `requestAnimationFrame` in `PersistentTerminal.mount()` that forces the renderer to update its canvas dimensions after the browser settles layout in the new container.

### Fix: branch ahead/behind indicators now appear on the branch pill

- The up/down arrow indicators on the branch pill were always showing 0 due to two issues: (1) branches without explicit upstream tracking (never pushed with `-u`) had no `# branch.ab` line in `git status`, so counts stayed at 0 — added a fallback that computes ahead/behind against `origin/<branch>` via `git rev-list --left-right --count`, and (2) remote tracking refs went stale because no periodic fetch was happening — added a 60-second background `git fetch --all --prune` to the workspace metadata monitor, with an initial fetch on workspace connect. The fetch uses `GIT_TERMINAL_PROMPT=0` to prevent hanging on expired credentials.
- Colored the ahead/behind arrows on the branch pill — behind (down arrow) is blue, ahead (up arrow) is green, instead of both being muted tertiary text.
- Added ahead/behind indicators to every local branch row in the branch selector dropdown, not just the current branch pill. Uses the same colored arrows.

### Fix: settings dialog type errors in project git polling section

- The project-scoped "Git Polling" section in the settings dialog referenced bare variable names (`focusedTaskPollMs`, `setFocusedTaskPollMs`, etc.) instead of the consolidated `fields.` / `setField()` pattern used everywhere else. Caused TypeScript compilation failures.

## [0.7.2] — 2026-04-13

### Fix: remove orphaned process sweep that killed active agent sessions

- The startup sweep and periodic PID registry sweep introduced in 0.7.1 could kill agent processes that were still actively running — the sweep saw PIDs not in its own managed set and treated them as orphans. Removed both sweeps entirely. Shutdown is now the sole cleanup path: all managed sessions are stopped and the registry is cleared on graceful exit. The PID registry is still maintained (register on spawn, unregister on exit) for bookkeeping, but no automated killing occurs during normal operation.

## [0.7.1] — 2026-04-13

### Fix: crash recovery auto-restart

- Running sessions that survive a server crash are now automatically detected during hydration and marked as interrupted. When the UI reconnects, each crash-recovered session auto-restarts with `--continue` so the agent resumes its conversation. Tasks stay in their board columns instead of silently resetting to idle. A toast notifies the user that sessions are being resumed. Terminal scrollback from before the crash is still lost (in-memory only), but the agent picks up where it left off. The manual restart button on task cards continues to work as before.

### Feat: persistent PID registry for orphaned agent process cleanup

- Agent processes (Claude Code, Codex, shell sessions) are now tracked in `~/.quarterdeck/managed-pids.json` so orphaned processes can be found and killed after crashes or force-kills. PIDs are registered on spawn and unregistered on exit. A background sweep runs on startup to kill any survivors from a previous unclean exit, and a periodic sweep every 60 seconds catches stragglers during normal operation. Clean shutdowns clear the registry entirely.
- Kill escalation uses SIGTERM first (with 3-second grace period), then SIGKILL if the process doesn't exit. Process groups are also signaled to clean up PTY children.
- PID reuse detection prevents killing unrelated processes after reboots — compares the OS-reported process start time against the stored spawn timestamp.
- Registry writes use atomic temp-file-then-rename via `lockedFileSystem` to prevent corruption from crashes mid-write. All read-modify-write operations are serialized through an in-memory promise queue to prevent races from concurrent spawns/exits.

### Feat: worktree `.git`-only access option for agents

- New setting "Allow agents to access the parent repo's `.git` directory" gives agents read access to git metadata (history, branches, refs) without exposing the full parent repo working tree. Passes `--add-dir /path/to/repo/.git` instead of `--add-dir /path/to/repo`. The full parent repo option takes precedence when both are enabled. Claude Code only.

### Fix: automatic stale git index.lock cleanup for worktrees

- Added three-layer cleanup for stale `index.lock` files orphaned when agent processes are killed mid-git-operation: startup scan of all worktree git directories, periodic 10-second sweep during the reconciliation loop, and immediate per-worktree cleanup on session exit. The post-exit path skips the staleness age check since the owning process is known dead.
- Added `getGitDir()` helper to `git-utils.ts` — resolves the per-worktree git directory (`.git/worktrees/<name>/`) with proper `GIT_*` env sanitization via `createGitProcessEnv`.

### Feat: top bar git sync actions — fetch, pull, push accessible from any view

- Moved fetch, pull, and push buttons from the git view tab bar into the top bar next to the branch pill. Actions are now accessible regardless of which view is active. All three work for both home context and task worktrees (passing `taskScope` when a task is selected).
- Added "from {baseRef}" label in the top bar when viewing a task worktree, with a "(N behind)" indicator in blue when the worktree has fallen behind its base branch.
- Deleted the `HomeBranchStatus` component — the git view tab bar now shows only `GitBranchStatusControl` (branch name, file stats, git history toggle).

### Feat: "Pull from remote" in branch context menu

- Added "Pull from remote" option to the branch selector context menu (right-click on the current branch), available in the files view scope bar and card detail view. Mirrors the existing "Push to remote" menu item.

### Feat: merge branch confirmation dialog

- "Merge into current" in the branch context menu now shows a confirmation dialog before merging, displaying source and target branch names. Prevents accidental merges.

### Fix: stalled session detection fires less aggressively

- Stalled detection threshold increased from 60 seconds to 3 minutes, and now considers terminal output in addition to hook events — if the agent is producing output, it's probably still working. Also fixes false positives after returning from review: `lastHookAt` is now reset when a session transitions back to running, so time spent in review no longer counts toward the stalled threshold.

### Refactor: settings dialog reorganized with better section grouping

- Consolidated 11 scattered sections into 8 focused groups ordered by user intent: Agent, AI Features, Notifications, Terminal, Git, Confirmations, Troubleshooting, Advanced. Merged split Git settings (card indicators + polling intervals) into one section with sub-headers, combined Session Recovery + Layout & Debug into Troubleshooting, promoted Confirmations above developer settings, and renamed headers for clarity (LLM Generation → AI Features, Sound notifications → Notifications, Developer / Experimental → Advanced, Suppressed Dialogs → Confirmations).

### Fix: title generation now prioritizes recent agent activity

- Title generation was producing bad titles because the original prompt dominated the context — agent summaries (appended last) were truncated away by the 800-char limit. Reordered context assembly so most recent activity comes first, doubled the context budget to 1600 chars, and updated the system prompt to explicitly focus on recent work. The `finalMessage` fallback path now uses the same "Most recent activity" label as the summary path for consistency.

### Fix: status bar line diff not updating after merge or checkout via branch selector

- After merging or checking out a branch through the branch selector popover, the status bar's `+additions -deletions` display now updates immediately instead of waiting for the next polling cycle (~10s). The merge and checkout handlers in `use-branch-actions.ts` were ignoring the fresh `summary` in the server response — now they call `setHomeGitSummary()` to update the store, matching the pattern used by all other git operations (fetch, pull, push, discard).

### Fix: top bar branch selector no longer checks out on left-click

- Left-clicking a branch in the top bar branch selector popover previously triggered a checkout instead of just closing the popover. Now it behaves like the home and task scope bar popovers — left-click is a no-op view action, checkout requires the explicit icon or right-click menu.

### Docs: todo list updates

- Added todo #18: Full Codex support — conversation history UI, per-task session resume, hook configuration, error diagnostics
- Added todo #19: Commit sidebar performance — slow commit execution and post-commit file list refresh
- Added todo #20: File browser and diff viewer performance — laggy file tree navigation and large diff rendering

## [0.7.0] — 2026-04-12

### Feat: git stash support — stash button, stash list, stash-and-retry for checkout/pull

- Stash button in the commit sidebar alongside Commit and Discard — stashes selected files (or all when none selected), always includes untracked files, with optional stash message. Uses existing file selection checkboxes for partial stash.
- Collapsible "Stashes" section below the file list shows the full stash stack (shared across worktrees). Each entry displays index, message, originating branch, and relative date. Right-click context menu: Pop, Apply, Drop (with confirmation dialog), Show Diff (popover preview). Badge count auto-updates via metadata polling.
- "Stash & Switch" recovery for checkout blocked by dirty working tree — offered in both the checkout confirmation dialog and the `switchHomeBranch` failure toast. Stashes all changes, then retries checkout.
- "Stash & Pull" recovery for pull blocked by dirty working tree — offered in the git action error dialog. Atomic sequence: stash all → pull → auto-pop on success. If pop conflicts, the conflict resolution panel activates and a toast explains the state.
- Backend: 7 git stash functions in `git-sync.ts`, 6 tRPC endpoints (`stashPush`, `stashList`, `stashPop`, `stashApply`, `stashDrop`, `stashShow`), `homeStashCount` in metadata polling (stash-only changes detected independently of `stateToken`), structured `dirtyTree` boolean on checkout/pull failure responses.
- 37 tests across 4 new test files covering git operations, tRPC wiring, hook behavior, and edge cases.

### Feat: ahead/behind indicators + push to remote from branch selector

- Branch pill in the top bar and home scope bar now shows ↑N/↓N arrows when the current branch is ahead of or behind the remote tracking branch. Counts are derived from `git status --porcelain=v2 --branch` during the existing git probe — no extra git commands.
- Right-click the current branch in the branch selector popover to "Push to remote." Task-scoped push resolves the correct worktree directory via a new `taskScope` parameter on `runGitSyncAction`. Detached HEAD shows a disabled push item with a tooltip explaining why.

### Feat: Commit & Push button in commit sidebar

- "Commit & Push" button alongside the existing Commit button. Commits staged files and pushes in a single atomic operation. Disabled on detached HEAD with a tooltip. On push failure, the commit is preserved and a warning toast shows the error. Uses the existing `runGitSyncAction("push")` infrastructure via a new `pushAfterCommit` flag on the commit request schema.

### Feat: merge conflict UX overhaul — auto-merged files, persistent banner, auto-open

- Merge now uses `--no-commit` to detect auto-merged files (staged but non-conflicted) before the merge commit. Auto-merged files appear in a dedicated section of the conflict resolution panel with old-vs-new diffs, requiring explicit "Accept" before "Complete Merge" is enabled. If the auto-merged file content fetch fails, files are implicitly accepted to prevent deadlocking the merge.
- Persistent orange conflict banner appears outside the git view when a merge/rebase is in progress — shows operation type, remaining conflict count, and a "Resolve" link that navigates to the git view. Renders in both the home layout and task detail view.
- Merge conflicts now auto-open the resolver: the toast says "opening resolver" and navigates to the git view automatically. Previously it only showed a passive toast.
- New tRPC endpoint `getAutoMergedFiles` for fetching auto-merged file content (old vs merged via `git show HEAD:<path>` and `git show :0:<path>`).

### Feat: stalled session detection — warning badge when agent goes silent

- When a running agent session hasn't received a hook in over 60 seconds, the reconciliation sweep marks it as stalled. The UI swaps the blue "Running" badge for an orange "Stalled" badge with a tooltip: "No hook activity for over a minute — the agent may be stalled or could still be thinking." The indicator auto-clears when hooks resume and the card stays in the In Progress column — no state transition occurs. Addresses the case where Claude Code hits an API error (auth failure, rate limit) and stays alive but stops making progress, leaving the card green forever with no indication anything is wrong.

### Feat: pin branches to top of branch selector dropdown

- Right-click any local branch in the branch selector popover to "Pin to top" — pinned branches appear in a dedicated "Pinned" section above "Local". Unpin via the same context menu. Works in all three popover sites (topbar, home scope bar, task detail). Pinned branches are stored per-workspace in the project config file and persist across sessions. Fuzzy search still filters pinned branches normally.

### Fix: worktree-locked branches no longer fully disabled in branch picker

- Branches checked out by a worktree task were previously greyed out and unclickable in the `BranchSelectorPopover` dropdown. Now only the Checkout and Delete context menu items are disabled — the branch row itself is clickable for browsing, merging, creating branches from, and comparing. The "in use" badge still appears as a visual indicator.

### Feat: compare tab — include uncommitted work + live refresh

- "Include uncommitted work" checkbox in the compare bar (default on). When checked, the compare diff includes staged, unstaged, and untracked changes on top of committed work — shows the full working tree state against the target branch. When unchecked, shows only committed diffs between the two refs.
- Compare tab now stays current as the agent works. Committed-only mode uses reactive `taskWorkspaceStateVersion` (zero-cost refetch only on new commits). Working-tree mode adds 1-second polling (same as the Uncommitted and Last Turn tabs) since working tree changes can appear without a commit.
- Fixes TODO #11 — compare tab no longer shows stale diffs for named branches.

### Feat: confirmation dialog for individual permanent delete in trash

- Clicking "Delete permanently" on a trash card now shows a confirmation AlertDialog before deleting — matches the existing "Clear trash" confirmation pattern. Dialog shows the task title, "This action cannot be undone", with Cancel and "Delete Permanently" buttons. Uses the Radix `onOpenChange` ref guard to prevent the cancel handler from firing after confirm.

### Fix: localStorage toggle buttons broken after first click

- Fixed stale closure bug in `useBooleanLocalStorageValue` and `useRawLocalStorageValue` — `react-use`'s `useLocalStorage` setter captures `state` in a `useCallback` but omits it from the dependency array, so functional updaters like `(prev) => !prev` always receive the initial value. Markdown preview toggle and word wrap toggle in the file viewer were stuck after the first click. Workaround tracks the current value in a `useRef` and resolves updates before passing a plain value to the setter.

### Fix: restore terminal scrollback so history survives reconnect

- Removed `scrollback: 0` from the server-side `TerminalStateMirror` for agent sessions — restore snapshots now include conversation history instead of just the viewport. Tab refresh and WebSocket reconnects no longer wipe scroll history. `scrollOnEraseInDisplay: false` remains in place to prevent ED2 duplicate content. Alternate screen transition dupes are an accepted trade-off pending a future interception fix.
- Added "Dump terminal state" button (monitor icon) to the debug log panel — logs buffer state (active buffer, scrollback lines, viewport, session state) for all active terminals via the `[terminal]` tag. Triggered from Cmd+Shift+D debug panel, no browser dev tools needed.
- Rewrote `docs/terminal-scrollback-investigation.md` with consolidated findings: two distinct duplication mechanisms (ED2 fixed, alternate screen transitions open), failed approaches, and future fix direction.

### Feat: cherry-pick individual commits onto any branch

- "Land on..." branch dropdown in the git history commit diff header — select a commit, pick a target branch, and cherry-pick it in one action. Merge commits are excluded (button hidden). Confirmation dialog shows the commit hash, message, and target branch with an explanation that conflicts will abort safely.
- Two-path backend: if the target branch is checked out in a worktree, cherry-picks directly there (after verifying clean working tree); if not checked out, creates a temporary worktree, cherry-picks, and cleans up in a `finally` block. Pre-flight validates commit exists, rejects merge commits, and validates target branch.
- `skipCherryPickConfirmation` config setting with toggle in Settings > Suppressed Dialogs. When enabled, clicking a branch in the dropdown executes immediately without the confirmation dialog.
- New tRPC endpoint `cherryPickCommit` with task-scope support.

### Feat: merge/rebase conflict resolution

- When a merge produces conflicts, the operation now pauses instead of auto-aborting. GitView shows a conflict resolution panel with a file list, ours-vs-theirs diff previews (via git index stages 2 and 3), and per-file actions: Accept Ours, Accept Theirs, or Resolve Manually (with terminal instructions). Progress tracking shows resolved/total files. "Complete" button creates the merge commit; "Abort" button restores pre-merge state. Rebase conflicts follow the same flow with multi-round support — continuing after resolving one commit may surface new conflicts from the next.
- Conflict detection integrated into metadata polling — reopening Quarterdeck while a merge/rebase is in progress immediately shows the conflict panel. Works for both home repo and task worktrees (uses `git rev-parse --git-dir` for worktree-safe directory resolution).
- New tRPC endpoints: `getConflictFiles`, `resolveConflictFile`, `continueConflictResolution`, `abortConflictResolution`.
- "Conflicted" file status badge (orange `!`) in file tree and commit panels.
- On conflict detection, toast navigates user to the Git view.
- 43 new tests: 16 unit (real git repos), 5 integration (end-to-end flows), 6 tRPC (mocked), 16 UI (hook + panel).

### Refactor: consolidate settings dialog form state into useSettingsForm hook

- Replaced 26 individual `useState` hooks, a 140-line dirty-check `useMemo`, an 80-line reset `useEffect`, and a 27-field manual save payload in the settings dialog with a single `useSettingsForm` hook (175 lines). Adding a new config field now requires 2 lines in the hook + the JSX control — the dirty check, reset-on-open, save payload, and web-ui save types are handled automatically.
- Eliminated hand-duplicated save request types in `runtime-config-query.ts` and `use-runtime-config.ts` — both now import `RuntimeConfigSaveRequest` from the Zod schema.

### Fix: prevent xterm headless lineFeed crash

- Fixed a crash where the server-side headless xterm terminal (TerminalStateMirror) could throw `Cannot set properties of undefined (setting 'isWrapped')` inside xterm's internal setTimeout-based write loop, killing the process. The root cause is an xterm.js 6.x buffer-overflow bug triggered when `scrollback: 0` leaves the circular buffer with zero margin. Decoupled the terminal's internal scrollback from snapshot serialization — the terminal now always gets at least 100 lines of buffer headroom while snapshots remain viewport-only for agent sessions.

### Feat: delete branch from context menu

- Right-click a local branch in the branch selector popover to delete it. Shows a confirmation AlertDialog, then calls `git branch -d` (safe delete — refuses unmerged branches). Disabled for the currently checked-out branch and branches locked by active worktrees. Errors route through the centralized git error toast pipeline. Wired into all three branch selector sites (topbar, home scope bar, task detail).

### Feat: structured JSONL event log for session lifecycle observability

- New `src/core/event-log.ts` module writes structured events to `~/.quarterdeck/logs/events.jsonl` (10 MB rotation). Gated behind `eventLogEnabled` config toggle (default off) — intended for developer debugging, not general users.
- 21 event types instrumented across hooks-api.ts and session-manager.ts: hook lifecycle (received, blocked, transitioned), session lifecycle (started, exited, spawn_failed), state transitions (transition, noop, optimistic), user input (interrupt, codex_flag), trust prompts (detected, confirmed, cap_reached), auto-restart (triggered, rate_limited, failed), interrupt recovery (scheduled, fired), and reconciliation (action, sweep, health.snapshot).
- Health snapshots emitted every 10s per active session with timing diagnostics (msSinceLastOutput, msSinceLastHook, msSinceLastStateChange, processAlive, hookCount).
- Debug flag button (Bug icon) on in-progress and review task cards — click to emit a `user.flagged` event with full state snapshot as an anchor point for log analysis.
- Settings toggle in Developer / Experimental section with clear "leave this off" guidance.

### Fix: commit panel UX — discard confirmation, resizable textarea, readable error display

- Discard All now shows an AlertDialog confirmation before running `git restore` + `git clean` — previously fired immediately with no safety net.
- Commit message textarea is vertically resizable (`resize-y`) instead of fixed-height.
- Commit failures show a collapsible inline error panel above the textarea instead of dumping full pre-commit hook stderr into an unreadable toast.

### Fix: centralized git error parsing and toast truncation

- New two-stage pipeline in `app-toaster.ts` (`sanitizeErrorForToast`): strips the verbose `runGit` prefix ("Failed to run Git Command: ...") via `parseGitErrorForDisplay`, then truncates to the first meaningful line (150 char cap) as a safety net.
- Auto-applied to all `showAppToast({ intent: "danger" })` and `notifyError()` calls — no call site needs manual wrapping.
- Migrated all direct `toast` from "sonner" imports to `showAppToast` across 7 files (branch actions, create-branch dialog, checkout confirmation, context-menu utils, file browser, file content viewer) so every error toast gets parsing for free.
- Module doc comment on `app-toaster.ts` directs new features to use `showAppToast`/`notifyError` instead of importing toast directly.

### Feat: offer checkout after branch creation

- After creating a branch, `handleBranchCreated` now calls `handleCheckoutBranch` (showing the checkout confirmation dialog) instead of `selectBranchView` (which only switched to a read-only browse mode with no visible feedback).

### Fix: web-ui test type errors blocking build

- Updated `drag-rules.test.ts` to match `BoardCard` type (removed stale `description` field, added required fields via helper factory). Updated `session-status.test.ts` to include the 5 new `RuntimeTaskHookActivity` fields (`toolName`, `toolInputSummary`, `finalMessage`, `source`, `conversationSummaryText`) in all `latestHookActivity` literals.

### Fix: needs-input tasks double-counted in sidebar pills

- Fixed a bug where a task awaiting permission approval showed both an "R" (Review) and "NI" (Needs Input) pill in the project sidebar. The server counts all `awaiting_review` sessions as review; the client refines a subset as needs-input. The R pill now subtracts the needs-input count to prevent overlap.

### Test: unit coverage for pure utility modules

- Added 189 new test cases across 10 previously untested or undertested pure-logic modules, covering runtime utilities (project-path, output-utils, shell, shortcut-utils, debug-logger) and web-ui utilities (path-display, session-status, open-targets, drag-rules, resize-preferences). All target deterministic, side-effect-free functions that require no server, PTY, or filesystem mocking.

### Branch selector: show detached HEAD as "Working tree" indicator

- When on a detached HEAD, the branch selector popover now shows a non-interactive "Working tree" section at the top with the current commit hash — previously the popover showed no selected branch, making it look like nothing was checked out. Hidden during search since it's not a switchable target.

### Fix: permission race condition in agent state tracking

- Fixed a high-severity bug where a stale `PostToolUse` hook arriving after a `PermissionRequest` would bounce the task from "awaiting review" back to "running," hiding the permission prompt from the user. Added a permission-aware transition guard in `hooks-api.ts` that blocks `to_in_progress` transitions while permission-related activity is present. `UserPromptSubmit` is exempted since it indicates deliberate user input. The normal approval flow is unaffected — `writeInput` transitions synchronously on Enter, clearing permission activity before any hook arrives.

### Fix: hook delivery timeouts from checkpoint capture

- Checkpoint capture (git stash create) is now fire-and-forget during `to_review` hook processing. Previously, the tRPC response waited for checkpoint completion, routinely exceeding the hook CLI's 3-second timeout and triggering spurious retries. The state transition, activity data, and WebSocket broadcast now complete before checkpoint starts. Checkpoint data arrives asynchronously via store onChange listeners.

### Commit sidebar tab — JetBrains-style quick-commit workflow

- New "Commit" tab in the detail sidebar — file list with checkboxes, status badges (M/A/D/R/?), commit message input, and Commit / Discard All buttons. Enables quick-commit without leaving the current main view or using an external tool. Works in both task worktree and home repo contexts.
- Per-file rollback via right-click context menu on individual files.
- Cross-view navigation from the commit panel — "Open in Diff Viewer" switches to the git view with the file selected, "Open in File Browser" switches to the files view.
- Backend: new `commitSelectedFiles` and `discardSingleFile` tRPC mutations with path validation and rollback-on-failure. `commitSelectedFiles` stages only the selected files and commits; `discardSingleFile` restores a single file to HEAD.
- Added future work items: Commit and Push (#17), auto-generated commit messages (#18).

### Remove home agent chat sidebar feature

- Removed the "Quarterdeck Agent" tab from the project navigation sidebar. The feature — a live terminal panel for a Quarterdeck-managed Claude/Codex session — overlapped with task agents and had no clear UI home. The sidebar now shows only the project list. The home shell terminal (bottom panel) and home repo polling are unaffected.

### Move --add-dir settings to Developer/Experimental section with safety warnings

- Moved the `worktreeAddParentRepoDir` and `worktreeAddQuarterdeckDir` toggles out of "Git & Worktrees" into a new "Developer / Experimental" section in Settings. Added a section-level warning explaining that both settings break worktree isolation — agents can escape their assigned worktree, causing the status bar, branch pills, and "shared" indicators to desync. Updated individual tooltips with specific risks (directory drift, state corruption, cross-worktree navigation).

### New todo items for worktree isolation issues

- Added four new todo items: UI branch/status desync when agents leave worktree (#16), "shared" indicator not updating on directory drift (#17), clarification for shared detached HEAD hashes (#18), and testing git object sharing as a read-only `--add-dir` alternative (#19).

### Fix: non-isolated task trash/untrash/start lifecycle

- Fixed non-isolated tasks (`useWorktree === false`) creating orphan worktrees on start and restore. `ensureTaskWorkspace` is now skipped for tasks running in the shared home repo — prevents unnecessary worktree creation on disk.
- Fixed restore-from-trash failing for non-isolated tasks. The restore flow no longer calls `ensureWorktree`, which would either error or create an unwanted worktree. Restore now goes directly to session start with `resumeConversation: true`.
- Trash warning dialog now shows appropriate messaging for non-isolated tasks — "session will be stopped, home repo changes unaffected" instead of "worktree deleted, patch captured."
- Added session reliability warning toast when resuming or restarting non-isolated tasks — `--continue` picks the most recent session by CWD, which is unreliable when multiple agents share the home repo.
- Suppressed the "worktree deleted / patch captured" info toast and the `cleanupTaskWorkspace` server call for non-isolated tasks (no worktree to delete, avoids unnecessarily deleting patch files).

### Fix: clean up stale lock files on server startup

- Quarterdeck now automatically cleans up orphaned `.lock` directories and `.tmp.*` files left by previous process crashes (force-kill, double Ctrl+C, shutdown timeout) when the server starts. Two-phase cleanup: phase 1 sweeps `~/.quarterdeck/` hierarchy before registry load, phase 2 reads the workspace index and cleans per-project directories (`.quarterdeck/config.json.lock`, `quarterdeck-task-worktree-setup.lock` in `.git/`). Uses mtime-based staleness detection matching `proper-lockfile`'s 10-second threshold, so active locks held by live processes are never removed. Shared directories like `.git/` use targeted removal (only Quarterdeck-named artifacts) to avoid touching git's own lock files.

### Markdown renderer in file browser

- Markdown files (`.md`, `.markdown`, `.mdx`) now render as formatted HTML in the file browser instead of showing raw text. A toolbar toggle switches between rendered preview and source view — similar to JetBrains' split editor. Defaults to rendered, preference persisted in localStorage. Supports GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks) via `react-markdown` + `remark-gfm`. Dark theme styling uses existing design tokens.

### Fix: worktree incorrectly indexed as a project

- Fixed a bug where a Quarterdeck-managed worktree (under `~/.quarterdeck/worktrees/`) could be registered as its own project in the project selector. This happened because worktrees are valid git repos, and the auto-registration paths (server startup, CLI commands) didn't distinguish them from real projects. Added `isUnderWorktreesHome` guard to prevent worktree paths from entering the workspace index, plus pruning logic to clean up any existing stale entries on the next client connection.

### Fix: stale branch label shown for detached HEAD worktrees

- Fixed branch pills (top bar, detail view, board cards) showing a stale branch name when the worktree is in detached HEAD state. The `??` fallback chain fell through to the persisted `card.branch` value instead of the short commit hash. Now checks `isDetached` from workspace metadata and skips the stale fallback, showing the commit hash instead. The `card.branch` fallback is still used during initial load when workspace info hasn't arrived yet.

### Todo consolidation

- Consolidated 23 todo items down to 17 by merging related items: agent state tracking bugs (#9, #18, #19, #20 → #9), session persistence (#2, #11, #12 → #2), non-isolated worktree tasks (#8, #13 → #8), and removing completed sidebar widths item. Updated cross-references and refactor doc.

### Remove experimental HTML chat view

- Removed the "Experimental: HTML chat view" feature and its `terminalChatViewEnabled` setting. The feature replaced the terminal canvas with browser-rendered HTML text but was incomplete and noisy — output was unreliable for full-screen TUIs like Claude Code. Deleted `ChatOutputView` component and `useChatOutput` hook, removed the config field from the API contract and global config, removed the settings toggle, and cleaned up prop threading through `App` → `CardDetailView` → `AgentTerminalPanel`. Added todo #24 to revisit the concept with a better approach.

### Create branch from ref

- Added "Create branch from here" to the right-click context menu in both the branch selector popover and the git history refs panel. Opens a dialog where you enter the new branch name — validates the ref exists and the name isn't taken, creates the branch via `git branch`, shows a success/error toast, and refreshes the refs list with the new branch selected. Available from all branch popover locations (top bar, home scope bar, task detail) and all ref types in the git history panel (HEAD, local branches, remote branches). Uses `--` argument separator and try/catch error handling for robustness.

### Merge branch into current

- Added "Merge into current" action to the branch selector popover's right-click context menu. Attempts `git merge --no-edit` — if it's a clean fast-forward or auto-merge, shows a success toast. If there are conflicts, auto-runs `git merge --abort` to restore clean state and shows an error toast. Available from all three branch popover locations (top bar, home scope bar, task detail scope bar). Disabled on the current branch. Includes ref validation against flag injection and shared-checkout guard matching the existing checkout behavior.

### File browser UX — word wrap default + selection memory

- File content viewer now defaults to word wrap ON and persists the preference to localStorage via `useBooleanLocalStorageValue`. Previously reset to OFF on every remount.
- File browser remembers the last selected file per task (and home view). Switching between tasks and back restores the previously viewed file instead of clearing the selection. Uses a module-level `Map` cache keyed by task ID. Stale entries are cleared automatically when the file no longer exists in the file list.

### Branch management — scoping, cleanup, and fixes

- Expanded todo #5 (branch management in git view) with tiered operation breakdown: merge, create, delete, stash in tier 1; cherry-pick, rebase, rename, abort in tier 2; interactive rebase, tags, force push, revert in tier 3.
- Removed "discard all changes" UI from `GitHistoryView` — it was buried in the git history panel header where nobody could find it. The commit sidebar tab is now the proper home for this action. Backend (`discardGitChanges` endpoint, `useGitActions` hook) left intact for reuse.
- Wired `onCompareWithBranch` to the top bar branch pill — right-click "Compare with local tree" now works from the top bar, not just the Files tab scope bar and task detail pill.
- Fixed compare tab not activating when navigated to externally — the `currentProjectId` reset effect was overriding the pending compare navigation on mount, forcing the tab back to "uncommitted."
- Added JSDoc guidance to `BranchSelectorPopover` reminding future call sites to wire up `onCheckoutBranch` and `onCompareWithBranch`. Added JSDoc to `ScopeBar` clarifying it lives in the Files tab.

### Remove disabled Gemini and OpenCode adapters

- Removed all Gemini CLI and OpenCode agent adapter code — type definitions, adapter implementations, hook handlers, prompt injection, config path resolution, and associated tests (~1100 lines). These adapters were disabled in the agent catalog's launch-supported list and unreachable. The agent type system (`RuntimeAgentId`) now only accepts `claude` and `codex`. Stale references cleaned from docs, man page, and comments.

### Preload project on hover for instant switching

- Hovering a project in the sidebar for 150ms+ prefetches its workspace state via tRPC in the background. When the user clicks, the board renders immediately from cached data instead of waiting for the WebSocket to reconnect and deliver a snapshot. Falls back to normal loading behavior if the preload hasn't completed. Cache entries expire after 15 seconds and are consumed on use to prevent stale data.

### Fix: project sidebar missing notification dot and NI pill

- Restored per-project approval indicators (orange dot + "NI" pill) in the project navigation sidebar. These were lost during the `b6595ebd` refactor which replaced the working client-side approach with a server-side `needs_input` task count, then `271efe00` reverted the broken server-side approach without restoring the original client-side logic. Now uses the same `isApprovalState` filter on `notificationSessions` that already drives the toolbar icon badge — counts all projects including current, since the project list should show each project's state regardless of which is active.

### Refactor: extract inline components from App.tsx

- Moved `HomeBranchStatus`, the git-init confirmation dialog, and the git-action error dialog from inline definitions in `App.tsx` into their own component files (`home-branch-status.tsx`, `git-init-dialog.tsx`, `git-action-error-dialog.tsx`). Follows the same pattern as existing extracted dialogs (`ClearTrashDialog`, `MigrateWorkingDirectoryDialog`). Net −161 lines from `App.tsx`, zero behavioral change.

### Fix: switching projects doesn't return to home view

- Switching projects now always resets the main view to the kanban board (home + projects sidebar). Previously, if a task was selected and the user was on the files or git view, switching projects would clear the task but leave the main view on files/git — showing the new project's file tree or git history instead of its board. The layout hook now handles project-switch resets directly, alongside its existing task-deselection auto-coupling.

### Fix: agent terminal scrollback filled with duplicate conversation copies

- Agent terminals (Claude Code) no longer accumulate hundreds of duplicate screen copies in scrollback. The root cause was `scrollOnEraseInDisplay: true` — an xterm.js setting inherited from upstream kanban that pushes the viewport into scrollback on every ED2 clear-screen sequence. Full-screen TUI agents redraw constantly, filling the 10,000-line scrollback with repeated copies at varying column widths. Now configurable per-terminal: agent terminals use `false` (erase in place), shell terminals keep `true` (preserving `clear` command behavior). Applied on both the browser-side xterm.js terminal and the server-side `TerminalStateMirror` so restore snapshots don't reintroduce duplicate scrollback on connect/reconnect.
- Terminal resize dedup replaced with epoch-based invalidation — lifecycle events bump a counter instead of manually zeroing `lastSentCols`/`lastSentRows` in 3 separate locations. Self-documenting, scales to new lifecycle edge cases without adding more manual resets.
- Server-side mirror now uses `scrollback: 0` for agent sessions — the mirror only needs the viewport for TUI agents, and any accumulated scrollback bloated restore snapshots with stale content. Serialize calls also pass `scrollback: 0` as belt-and-suspenders.
- `ensurePersistentTerminal` now applies `scrollOnEraseInDisplay` on every cache hit (not just terminal creation), preventing stale options when hook ordering changes. `useChatOutput` threads the option through to match `usePersistentTerminalSession`.

### Debug log panel is resizable

- The debug log panel can now be drag-resized horizontally via a handle on its left edge. Width is clamped between 280px and 800px, persisted to localStorage, and included in the "Reset Layout" action. Uses the same `ResizeHandle` / `useResizeDrag` infrastructure as other resizable panels.

### Fix: squash merge prompt uses shell variable expansion

- The squash merge prompt template's divergence-check commands used `MERGE_BASE=$(git merge-base ...)` with `$MERGE_BASE` expansion, which triggered Claude Code's `simple_expansion` permission prompt on every run. Replaced with git's three-dot diff syntax (`git diff --name-only <target>...HEAD`) which is semantically equivalent and doesn't require shell variable assignment.

### Fix: summary regeneration ignores user-configured stale window

- The `generateDisplaySummary` endpoint now always respects the `summaryStaleAfterSeconds` window before checking for newer conversation data. Previously, new conversation data arriving within the stale window would bypass the user's configured interval and trigger an early LLM regeneration on the next card hover.

### Branch pill dropdown on the topbar

- Added a branch pill to the top navigation bar that shows the current branch and allows quick checkout of any branch. In task context, checkouts target the task worktree; in home context, they target the home repository. Uses the same `BranchSelectorPopover` component as the file browser and git view.
- Confirmation dialogs match the existing checkout flow: task checkouts show a "Don't show again" checkbox (re-enable via Settings), home checkouts always confirm (suppressible only through Settings). Dirty working tree and worktree-locked branch warnings work as before.
- The branch dropdown now shows an inline checkout icon and right-click "Checkout" context menu item on each branch row, matching the file browser's branch dropdown.

### Git view compare — headless worktree support

- The compare tab's default source ref now falls back to `headCommit` for headless (detached HEAD) worktrees, so the compare view populates automatically instead of showing "select branch."

### Fix: trashing a running task plays error triple beep

- Suppress the audible failure notification (3×740Hz beep) when a running task is moved to trash. The process exit from SIGTERM was being interpreted as a failure by the notification system. Tasks in the trash column are now excluded from sound scheduling via a `suppressedTaskIds` set derived from board state.
- Also cancel any already-pending sound timers for tasks that enter the trash during a hook-based settle window (500ms race).

### Fix: terminal renders at wrong width after untrashing a task

- When untrashing a task, the agent terminal could render text at roughly 1/3 of the correct width until the browser window was manually resized. Root cause: the PersistentTerminal's WebSocket connected and sent a resize before the server-side PTY existed (silently dropped), then the PTY was created with estimated geometry. The client's dedup tracking prevented re-sending the correct dimensions. The terminal now re-sends its dimensions when it receives a session state transition to `running` or `awaiting_review`, and also resets dedup tracking whenever the terminal is mounted to a new container (e.g., switching views).

### Statusline: fix token throughput glyph and color

- Replace unrenderable `nf-mdi-function` (U+F0865) glyph for the token throughput segment with `nf-md-file-document` (U+F0219) — a document icon that better represents token I/O.
- Change token throughput color from `brightYellow` to `dimWhite` so it's visually distinct from the adjacent duration (brightYellow) and cost (yellow) segments.

### Default prompt shortcuts with merge system

- Added "Squash Merge" as a second default prompt shortcut alongside "Commit". The prompt asks the user for the target branch and explains the operation before proceeding, then uses `commit-tree` + `update-ref` to land — the standard worktree-safe squash merge flow.
- Default shortcuts are now merged into user shortcuts on config load instead of being replaceable. Users who've never customized see both defaults; users with custom shortcuts get missing defaults appended automatically. Case-insensitive label matching — a user shortcut named "commit" overrides the default "Commit".
- Editing a default's prompt text creates a user override — the template source is never mutated. Deleting a default offers "Revert to default" (if overridden) or "Hide default" via confirmation dialog. Hidden defaults are tracked in a new `hiddenDefaultPromptShortcuts` config field.
- The editor dialog shows "Default" / "Modified" badges and a revert button on overridden defaults. A "Restore defaults" button in Settings (visible only when defaults are hidden or overridden) clears all customizations with a confirmation warning.
- Prompt template strings extracted from `config-defaults.ts` into `src/prompts/prompt-templates.ts` for maintainability.

### Double-click task in sidebar to open agent chat

- Double-clicking a task card in the sidebar column context panel now selects the task and switches the main view to the agent terminal/chat. A hint ("Double-click a task to open agent chat") is shown at the bottom of the sidebar. Backlog tasks are excluded (they use single-click-to-edit).

### Harden session state transition system

- Fix permanent dead state: tasks that exited cleanly (`reviewReason: "exit"`) could never transition back to running via hooks — `canReturnToRunning()` now accepts the `"exit"` reason. The duplicated guard in `hooks-api.ts` now uses the shared function.
- Fix interrupt recovery timer leak: when a session transitions back to running (via `hook.to_in_progress` or `agent.prompt-ready`), any pending interrupt recovery timer from a prior Escape/Ctrl+C is now cleared. Previously a stale 5s timer could bounce a resumed session back to `awaiting_review/attention`.
- Hook delivery retry: `hooks ingest` CLI now retries once after 1s if the initial 3s-timeout attempt fails. Lost hooks were the primary cause of tasks stuck in the wrong state with no automatic recovery.
- Route `mark_processless_error` reconciliation action through the state machine reducer instead of directly mutating the store, ensuring all state transitions are validated.
- Add diagnostic logging for hook events — CLI-side `[hooks:cli]` stderr lines show what the agent fired, server-side debug logs (enable in UI) show what the server received, whether it blocked or transitioned, and why. Supports investigation of todo #8 (permissions) and #19 (compact).

### Agent directory access from worktrees

- Claude Code agents running in task worktrees can optionally access the parent repository directory and the `~/.quarterdeck` state directory via `--add-dir`. Both settings are off by default and configurable in Settings > Git & Worktrees. Only affects Claude Code; other agents are unchanged.

### Fix: `--add-dir` consuming task prompt as a directory path

- Claude Code's `--add-dir` flag is variadic (`<directories...>`), so the CLI parser greedily consumed the task prompt as a directory path when `--add-dir` was present — the agent started but never received its prompt. Fixed by inserting a POSIX `--` end-of-options separator before the prompt positional arg in the Claude adapter.
- The workspace trust auto-confirm mechanism now handles multiple trust prompts per session (capped at 5). When the cap is reached, a warning toast is surfaced in the UI via the `warningMessage` field on session summaries.
- Added debug logging around the full task creation and agent launch flow (`agent-launch` and `session-mgr` tags). Traces `--add-dir` decisions, final command args, spawn success/failure, trust prompt detection, and process exit.

### Fix: revert broken needs_input project pill feature

- Reverted the `needs_input` project navigation pill introduced in be56e048. The feature misclassified all `reviewReason === "attention"` tasks as "needs input", but "attention" is the standard completion reason when an agent finishes work — causing every completed review task to show an orange "NI" pill instead of green "R". Removed `needs_input` from the project task count schema, pill rendering, and live session overlay. Project pills now show exactly 4 statuses (B, IP, R, T) matching board columns 1:1. Card-level review differentiation (`statusBadgeColors.needs_input`, `session-status.ts`) is unchanged.

### Fix: git index lock contention from workspace metadata polling

- The workspace-metadata-monitor's polling cycle no longer holds the git index lock on active worktrees. Seven read-only git commands (`merge-base`, `rev-list`) across `git-utils.ts` and `git-history.ts` were missing the `--no-optional-locks` flag, causing them to acquire the index lock unnecessarily on every poll cycle (every 2–5 seconds per worktree). This blocked concurrent git operations — commits, staging, and other write operations — in worktrees with active task cards. All polling git commands now consistently pass `--no-optional-locks`.

### Emergency stop/restart actions for stuck running tasks

- New settings toggle (Settings > Session Recovery > "Show stop & trash buttons on running tasks") adds force-restart and force-trash buttons to in-progress task cards when hovered. Disabled by default to keep the UI clean. When a task is stuck in "running" state (e.g. failed resume, permission prompt, agent hang), enabling this provides an escape hatch without needing to drag the card or restart the server. Related to todo #8 and #19.

### AGENTS.md: session reconciliation guidance

- Added a "Session reconciliation" section to AGENTS.md directing developers to register cleanup for new dynamic UI state in `src/terminal/session-reconciliation.ts`. Added a corresponding header comment to the reconciliation module listing current coverage and future candidates.

### Right-click context menu on branch selector items

- Right-clicking a branch in the `BranchSelectorPopover` dropdown (file browser scope bar, task detail scope bar, git view Compare tab) now shows a context menu with up to three actions: **Checkout** (triggers the existing confirmation dialog flow), **Compare with local tree** (switches to the git view Compare tab with that branch as the target), and **Copy branch name**. Actions render conditionally — Checkout and Compare only appear when the parent provides the relevant callback. The git view Compare tab's pickers show only "Copy branch name" since checkout and compare don't apply there. Shared context menu utilities (`CONTEXT_MENU_ITEM_CLASS`, `copyToClipboard`) extracted into `context-menu-utils.ts` and reused by the file browser context menu.

### Perf: faster project switching — decouple metadata, parallelize reads, cache counts

- Project switching no longer blocks on git probe latency. The initial WebSocket snapshot is sent immediately with board and session data; workspace metadata (git status, changed files, behind-base counts) arrives asynchronously via the existing `workspace_metadata_updated` message. With multiple active task worktrees this removes 1-3 seconds of git subprocess time from the critical path.
- The three sequential file reads in `loadWorkspaceState` (board, sessions, meta) now run in parallel via `Promise.all`.
- Sidebar badge counts for inactive projects (no running agent sessions) are served from an in-memory cache instead of re-reading board files from disk on every broadcast cycle.

### Fix: toolbar highlight styles swapped and sidebar highlight sync bugs

- Main view buttons (Home, Terminal, Files, Git) now use blue left-border accent when active. Sidebar buttons (Projects, Board) now use filled gray background when active — swapping the two styles for better visual hierarchy.
- Sidebar highlight now always reflects exactly what's visible: no ghost highlight when the sidebar is collapsed, and no suppression when on the Git view with a sidebar panel still open.
- Fixed a bug where deselecting a task while on Files or Git view with the Board sidebar open would leave no sidebar button highlighted — the Board sidebar now always falls back to Projects when a task is deselected, regardless of which main view is active.

### Fix: chat view showing duplicate copies of the conversation

- Scrolling up in the HTML chat view no longer shows repeated copies of the entire conversation. The root cause was `readBufferLines()` reading the full 10,000-line scrollback buffer — with `scrollOnEraseInDisplay: true`, every TUI screen clear pushed the viewport into scrollback, accumulating many duplicate copies. Now reads only the viewport lines (`baseY` to `baseY + rows`). Also removes the dead `chat-output-accumulator.ts` file.

### Move branch status from top bar to git view tab bar

- The branch pill (showing the current branch name, toggling git history on click), file change stats, and fetch/pull/push buttons have moved from the main top bar into the git view's tab bar. In the home context, the full cluster (branch pill + stats + fetch/pull/push) renders in the tab bar. In the task context, the branch pill + stats + "based on" label render there. Git history now renders inside the git view (below the tab bar) rather than replacing the entire main view. The `Cmd+G` shortcut still works from any view — it auto-switches to the git tab and opens git history. Partially addresses todo #5.

### Auto-collapse sidebar when opening Files or Git view

- Opening the Files or Git main view now automatically collapses the sidebar if it isn't pinned. Both views have integrated file trees that replace the sidebar's role, so leaving it open wastes space. Pinned sidebars are respected and stay open.

### "Copy file contents" in file browser context menu

- Right-clicking a file in the file browser tree now offers a "Copy file contents" action alongside the existing "Copy name" and "Copy path" options. Fetches the file content from the server (or git ref) and writes it to the clipboard. Handles binary files (shows error toast) and fetch failures gracefully.

### Fix: font weight settings input — replace number spinner with text input

- The font weight input in Settings > Terminal now uses a plain text field instead of a native `type="number"` spinner. The number spinner was unusable for manual entry — typing "350" would clamp to 100 after the first keystroke, and the step arrows caused jumpy, unpredictable behavior. The new input accepts free-form typing and validates on blur or Enter (reverts on invalid input). Input width narrowed from `w-20` to `w-14` to match the 3-digit value range.

### Fix: behind-base indicator not detecting when local branch advances

- The blue "behind base" indicator on headless worktrees now correctly detects when the local base branch (e.g. `main`) advances — previously it only checked `origin/main` which could be stale if no `git fetch` had occurred. Now checks both origin and local refs in parallel and reports whichever is further ahead. Also fixes cache staleness after `git fetch` by tracking the origin ref commit in the metadata cache.

### Fix: terminal scroll glitch and duplicate chat on task switch

- Switching tasks no longer causes a visible slow scroll from the top of the terminal buffer to the bottom — the terminal now fits to the container synchronously on mount instead of deferring to the next animation frame. Duplicate resize messages to the PTY are eliminated by tracking last-sent dimensions, preventing agents from redrawing their chat display at multiple widths and leaving duplicates in the scrollback.

### File browser right-click context menu

- Right-clicking any file or directory in the file browser tree now shows a context menu with "Copy name" (file/folder name only) and "Copy path" (full absolute filesystem path). Uses `@radix-ui/react-context-menu`, styled to match existing dropdown menus. Toast confirmation on copy.

### Sidebar pin toggle

- New pin button in the sidebar toolbar (below Projects/Board buttons) prevents the sidebar from auto-switching when selecting or deselecting a task. When pinned, clicking a task still opens the terminal but the sidebar stays on its current panel (e.g. Projects). Pin state persists to localStorage. The `task_column` sidebar always falls back to Projects on task deselect regardless of pin state, since it requires a task to function.

### Terminal WebGL renderer toggle and experimental HTML chat view

- New setting in Settings > Terminal to toggle the WebGL renderer on or off. When disabled, xterm.js falls back to the browser's native canvas 2D renderer for crisper text at the cost of GPU acceleration. Default: on. The toggle applies live to all open terminals without requiring a restart.
- New "Experimental: HTML chat view" toggle in Settings > Terminal — when enabled, replaces the xterm.js canvas in the main agent terminal with browser-rendered HTML text. Terminal output is streamed through an accumulator that strips ANSI escape sequences and filters cursor-save/restore status bar noise. Default: off. Caps at 10,000 lines.

### Files view — Board sidebar can coexist

- The Files main view now embeds its file browser tree internally (like the Git view) instead of occupying the sidebar slot. Board and Projects sidebars can be open alongside the Files view. New `FilesView` component with integrated ScopeBar, resizable file tree with toggle, and content viewer. Dead `isFileBrowserExpanded` and expanded/collapsed file browser ratio code removed from the layout hook.

### Uncommitted changes indicator on task cards

- Red dot appears on task cards (in_progress and review columns) when the task's worktree has uncommitted file changes. Shares the existing workspace-metadata-monitor polling infrastructure — no new detection or broadcast code. Tooltip shows "N uncommitted change(s)". Configurable via Settings > Git & Worktrees toggle (`uncommittedChangesOnCardsEnabled`, default on). Excluded from backlog and trash cards.

### Centralize status colors — card badges, project pills, and column indicators in sync

- Running status badges on task cards and the terminal panel now use accent blue (matching the In Progress column indicator) instead of green. Review states (ready for review, waiting for input, completed) now use green (matching the Review column indicator) instead of blue. All status colors derive from a single centralized module (`column-colors.ts`) — card badges, project-sidebar pills, and column-header SVGs all inherit from one place.
- Project sidebar: trash pill removed, replaced by an orange "NI" (Needs Input) pill that shows how many tasks need user action (waiting for input or approval) per project. The per-project approval dot is replaced by this pill.
- New `needs_input` field in `RuntimeProjectTaskCounts` — computed server-side from live session state (attention + approval).

### Show target branch when creating non-isolated task

- When "Use isolated worktree" is unchecked in the create dialog, the warning now shows the current workspace branch name (e.g. `main`, `feature/xyz`) so users know exactly which branch the task will run on. Falls back to "detached HEAD" when applicable.

### README refresh

- Updated README to reflect current feature set — names supported agents (Claude Code, Codex CLI), describes the git view's three tabs (Uncommitted / Last Turn / Compare), adds multi-project management, file browser, settings overview, and an experimental Windows support note.

### Suppressed Dialogs section in settings

- Dialog suppression toggles (trash worktree notice, task/home checkout confirmations) moved from "Git & Worktrees" into a dedicated "Suppressed Dialogs" section at the bottom of Global settings — provides a single place to re-enable any dialog previously dismissed via "don't show again". Checkout toggle labels flipped to positive phrasing ("Show X confirmation"). Convention documented in AGENTS.md.

### Fix: LLM title/summary prompts hardened against non-content responses

- All three LLM system prompts (title, branch name, summary) now include explicit rules forbidding questions, refusals, preamble, or clarification requests — a bad title is better than a non-title response. A new `sanitizeLlmResponse()` sanitizer in `callLlm()` provides defense-in-depth by stripping preamble patterns (`"Title: ..."`, `"Here's a title: ..."`), outer quotes, and trailing conversational noise, and rejecting responses that look like questions or refusals.

### Fix: Compare tab branch pill dropdowns not opening

- `BranchPillTrigger` now forwards ref and rest props so Radix Popover's `asChild` pattern can inject click handlers — previously the pills rendered but clicking them was a no-op.

### Git view — promote diff viewer to full main view

- The diff viewer is now a main view ("Git") instead of a sidebar panel ("Changes") — three internal tabs: **Uncommitted** (HEAD vs working tree, renamed from "All Changes"), **Last Turn** (preserved as-is), and **Compare** (new branch-to-branch diffing with dual pill dropdowns). The Compare tab defaults to the task's working branch vs base branch, shows a "Browsing" indicator when viewing a different branch, and has a "Return to context" button to reset. Works without a task selected (home repo context). Integrated file tree is toggleable, resizable, and persists width independently to localStorage. Git icon badge shows red for uncommitted changes in both task and home repo contexts. External navigation API (`openGitCompare`) enables future "compare against" entry points. Backend extended with nullable `taskId` and `fromRef`/`toRef` on `workspace.getChanges` for home repo and arbitrary ref-to-ref diffing, with `validateRef` input sanitization.

### Refactor: extract SessionSummaryStore from TerminalSessionManager

- Decoupled session summary state management from terminal process lifecycle — new `SessionSummaryStore` interface + `InMemorySessionSummaryStore` owns all `RuntimeTaskSessionSummary` data, mutations, and change subscriptions. External callers (hooks-api, runtime-api, workspace-api, workspace-registry, runtime-state-hub, shutdown-coordinator) now access summaries via `manager.store` instead of reaching into the terminal manager directly. The store is a synchronous, process-agnostic class designed to map 1:1 to a Go interface for the backend rewrite.

### Fix: stale review sessions recover instead of dropping to idle

- When an agent process exits while a task is in "ready for review" and no viewer is connected, clicking the card no longer drops it to idle — `recoverStaleSession` now detects the task was launched this server lifetime and schedules an auto-restart instead. Clean exits (code 0) preserve the "Completed" state without restarting. A new reconciliation check (`checkProcesslessActiveSession`) proactively marks orphaned review sessions as "Error" so the card shows the correct status even before the user clicks it.

### Project switcher drag-and-drop reorder

- Projects in the sidebar can now be reordered via drag-and-drop — grab the grip handle (visible on hover) and drag to a new position. Ordering persists across sessions in the workspace index file, with alphabetical fallback for projects that haven't been reordered. Optimistic UI prevents visual snap-back during the server roundtrip.

### Settings dialog reorganization

- Reordered settings sections so frequently used settings (sound notifications, LLM generation) are near the top and related settings are grouped logically — merged Changes/Trash/Git into "Git & Worktrees", Terminal/Terminal rendering into "Terminal", Layout/Debug into "Layout & Debug", and demoted Git Polling from top-level heading to a subsection under Global. Section count reduced from 14 to 9.

### Fix: delayed transition to "running" on prompt submit

- Task cards now transition to "running" immediately when the user submits a prompt (Enter/CR) from the review sidebar or terminal — previously the card stayed in "awaiting review" for 500ms–2s while waiting for the agent's async `to_in_progress` hook.

## [0.6.0] — 2026-04-10


### Error boundary & disconnection UX

- When the server shuts down, the UI now shows a clean "Disconnected from Quarterdeck" card instead of a confusing minified React error — a module-level flag tracks WebSocket state outside React so the error boundary can detect disconnection synchronously.
- Upgraded the disconnection fallback to a polished card with an Unplug icon, clear messaging, and a Reload button (consistent with the error boundary card style).
- Fixed 3 pre-existing lint warnings (optional chain) in the integration test.

### Dual-selection sidebar rework

- Split the sidebar toolbar from a single tab into two independent dimensions: **main view** (Home, Terminal, Files) above a divider, and **sidebar** (Projects, Board, Changes) below — each with its own active highlight style (filled bg vs left-border accent).
- Auto-coupling rules: selecting a task switches to terminal + task column, clicking Home returns to board + projects with task deselected, clicking Files opens the file browser (both home repo and task worktree).
- Disabled states: Terminal, Board, Changes icons grey out when no task is selected.
- Always opens to Home + Projects on page load — view state is transient, not persisted across sessions.
- Per-project approval indicators: orange dot on project rows in the sidebar when a task in that project is waiting for approval. Projects toolbar badge excludes the current project's approvals (already visible on the board).
- Cross-project notification workspaceId now preserved from `task_notification` WebSocket messages through the store.

### Project switcher sidebar tab

- New "Projects" icon (FolderKanban) in the detail toolbar between Home and the divider — always enabled, opens the ProjectNavigationPanel from any context (home view, task terminal, diff viewer) without deselecting the current task.
- Orange notification badge on the Projects icon when any cross-project task is in approval/permission state, computed from `notificationSessions` via `isApprovalState()`.
- "projects" tab persists to localStorage and survives page refresh. Auto-switch on task deselect preserves the Projects tab (like Files).
- Investigated todo #19 (task count badge sync) — the data flow is already correct: current project counts derive from the live board, other projects update via `projects_updated` WebSocket messages.

### Native Claude Code statusline

- TypeScript statusline — renders a two-line ANSI statusline for Claude Code sessions without requiring Starship or a compiled binary.
- Line 1: directory name (light blue), git branch (purple) with status indicators, battery level. Headless worktrees show the short commit hash and "based on {baseRef}" instead of a branch name.
- Line 2: session ID, model with icon, context window usage with color-coded tiers (green/yellow/red), cost, duration, cumulative tokens, lines changed.
- Registered as `quarterdeck statusline` CLI subcommand — reads JSON from stdin, writes ANSI to stdout.
- Automatically injected into Claude agent sessions via `--settings` when quarterdeck spawns agents. Gated by `statuslineEnabled` global config field (defaults on). Base ref passed via `QUARTERDECK_BASE_REF` env var for headless worktree display.
- Input validated with Zod schema; command parts shell-quoted for paths with spaces.
- Web UI top bar also shows "based on {baseRef}" for headless worktrees, matching the scope bar.

### Fix: unmerged-changes badge false positive after squash merge

- The blue dot on the Changes icon persisted when a worktree's changes had already landed on the base branch via squash merge or commit-tree (identical trees but divergent commit graphs). Now cross-checks the three-dot merge-base diff with a two-dot tree comparison — if the trees are identical, the badge is suppressed.

### Debug log panel — right-side push layout, stop button, global error capture

- Debug log panel is now a 420px right-side panel that pushes main content over, instead of an overlay that took over the screen. Filters moved to a dedicated row below the header.
- Three distinct close actions: Clear (removes entries), Close (hides panel, logging continues in background), Stop (disables server-side logging and closes).
- Global error capture installed at app startup — catches uncaught exceptions (`window.onerror`), unhandled promise rejections, and intercepted `console.error`/`console.warn` from libraries and React.
- Console-intercepted entries hidden by default behind a "Console" checkbox in the filter bar to avoid noise from React dev warnings and third-party libraries. Uncaught errors and unhandled rejections always show.
- `notifyError` toast calls and WebSocket stream errors now also appear in the debug panel when logging is active.

### Fix: prevent orphaned processes when parent exits without signaling

- Runtime servers now detect when their parent process (Cline, an agent launcher, etc.) exits without sending a signal — stdin pipe EOF triggers graceful shutdown via SIGHUP. Only activates for pipe-connected child processes, not direct terminal launches or detached stdin.
- Shutdown coordinator cleanup has a 7s timeout so `closeRuntimeServer()` always runs orderly, even if workspace state persistence or worktree deletion hangs.
- Codex wrapper cleanup has a 3s timeout so the wrapper can't hang forever if the session watcher stalls.

### Fix: terminal font weight and ligature tuning

- Bumped terminal font weight from 300 (Light) to 350 for a middle ground between the too-thin Light weight and the too-chunky Regular (400) on low-DPR monitors. Bold weight set to 500 (Medium).
- Switched back from the NL (No Ligatures) variant to standard JetBrainsMono Nerd Font Mono — ligatures are fine and the NL switch wasn't meaningfully helping with rendering weight.

### Configurable terminal font weight

- Terminal font weight is now configurable in Settings > Terminal (default 325, range 100–900, step 25). Previously hardcoded. Changes apply to all live terminals immediately without restart.

### Backend domain boundary cleanup

- Moved `agent-registry.ts` from `src/terminal/` to `src/config/` — it builds config responses and only depended on config types, not terminal internals.
- Moved `command-discovery.ts` from `src/terminal/` to `src/core/` — it's a pure PATH inspection utility used by both config and server layers.
- Consolidated working directory resolution: extracted `resolveTaskWorkingDirectory` and `isMissingTaskWorktreeError` to `src/workspace/task-worktree.ts` as the single source of truth. Removed the duplicate local copy from `workspace-api.ts` and replaced the inline copy-paste in `runtime-api.ts` `startShellSession`. `startTaskSession` and `migrateTaskWorkingDirectory` keep their specialized inline logic (different `ensure`/`useWorktree`/`branch` requirements).
- Added research doc and TODO (#22) for the remaining coupling hotspot: session summary dual-sourcing between terminal and state layers.

### Board sidebar opens when clicking task from board view

- Clicking a task card from the board now opens the terminal with the board sidebar (`task_column` tab) visible, so you keep column context alongside the agent terminal. Previously it collapsed the sidebar entirely for a full-width terminal. If the sidebar was already manually collapsed, it stays collapsed to respect user preference.


> Prior entries (0.5.0 and earlier) in `docs/changelog-through-0.5.0.md`.
