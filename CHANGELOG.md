# Changelog

## [Unreleased]

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

## [0.5.0]

### Per-card hard delete in trash column

- Trash cards now have a permanent delete button (red trash icon) next to the existing restore button. Clicking it removes the task from the board, stops the session, and cleans up the workspace — no need to clear all trash or drag the card.

### Upstream sync tracker, browser nav, onboarding tips, dev:full

- Replaced date-stamped upstream sync doc with a living tracker (`docs/upstream-sync.md`) — covers all 22 upstream commits since fork with Adopted / Backlog / Decided against sections. Made upstream sync and doc archiving recurring items in todo.md.
- Browser back/forward now works for task detail views — opening a task pushes `?task=<id>` to the URL, so the browser back button closes the detail view. Implemented via new `use-detail-task-navigation.ts` hook.
- Added "Getting started" onboarding tips in the project sidebar — dismissible with localStorage persistence, Quarterdeck-specific tips about creating tasks, parallel agents, and reviewing changes.
- Added `npm run dev:full` script (`scripts/dev-full.mjs`) — launches both runtime and web UI dev servers in a single process with prefixed output.

### Fix: file browser shows deleted files

- The file browser tree and file search no longer show files that were deleted from disk but not yet committed. `git ls-files --cached` still lists them; now cross-referenced with `git status --porcelain=v1` to filter out `D`-status entries.

### Fix: always open to agent view when selecting a task from home

- Clicking a task card from the home board now always opens the agent terminal view instead of restoring the last active tab (which could be the file browser). Task-to-task switching still preserves the current tab.

### Fix: file browser folders start collapsed by default

- The file browser tree panel no longer auto-expands directories two levels deep on load. All folders start collapsed, reducing visual noise when opening the Files tab.

### Config field registry — single source of truth for settings

- Extracted a field registry pattern (`global-config-fields.ts`) so adding a new boolean/number config setting requires 1 line instead of ~12 files. Runtime-config.ts reduced from 1167 to 683 lines.

### Configurable behind-base indicator on Files tab

- The blue dot on the Files toolbar icon (showing when the base branch has advanced) is now controlled by a `behindBaseIndicatorEnabled` setting (default: on). Toggle it in Settings under the Changes section.

### Fix: diff tab badge false positive when worktree is only behind base

- The Changes tab notification badge lit up when a task worktree was behind its base ref (e.g. main advanced) even if the worktree had no new changes to land. Switched the unmerged-changes detection from a two-dot diff (`baseRef HEAD`) to a three-dot diff (`baseRef...HEAD`) so it only flags changes the worktree introduced since diverging.

## [0.4.0]

### Scope bar, branch selector, and context-aware file browser

- New scope bar in the Files tab showing which worktree context you're viewing (task worktree, home repo, or a different branch). Supports switching between the task's worktree and the home repo, with a "return to contextual" action.
- Branch selector popover — pill-styled trigger showing the current branch name, with a dropdown listing all worktree branches. Selecting a branch opens a read-only file browser view of that ref. Checkout button to switch the worktree to a different branch.
- Checkout confirmation dialog with "don't show again" persistence via runtime config. Warns when checking out to a branch while the agent is running or when switching the home repo.
- Context-aware file browser — the file tree and file content viewer now derive their data source from the scope bar's resolved context (task worktree path, home repo path, or a `git show` ref for branch browsing).
- Behind-base detection — scope bar shows a warning badge when the task branch is behind its base ref.
- Headless (detached HEAD) worktree display — shows abbreviated commit hash instead of branch name when the worktree is in detached HEAD state.
- Deleted orphaned `FileBrowserPanel` component, replaced by the new `FileBrowserTreePanel` + `FileContentViewer` split architecture.

### Fix: stale "unmerged changes" badge

- Fixed stale blue notification dot on the Changes tab persisting after a task branch was merged to main. The metadata monitor's cache key only tracked the worktree's own state (HEAD, branch, working-tree status) — it didn't notice when the base ref (e.g. `main`) advanced. Added the resolved base ref commit to the cache invalidation check so the diff is re-evaluated when the target branch moves.

### Fix: stuck "waiting for approval" state

- Fixed three independent root causes that could leave a task card stuck in "Waiting for approval":
  - **RC1 — Stop hook clobbering permission metadata**: Added a guard on the hook ingest non-transition path that prevents non-permission hooks (Stop, PreToolUse, SubagentStop) from overwriting permission-related `latestHookActivity` fields when the task is in `awaiting_review`.
  - **RC3 — Auto-review trashing permission-waiting cards**: Added an `isApprovalState` guard in the auto-review evaluation loop so cards actively waiting for permission are skipped.
  - **RC4 — Null-window flash during `transitionToReview`**: Removed the preemptive `latestHookActivity` clear that created a brief window where the UI showed "Ready for review" before correcting to "Waiting for approval". The caller already handles activity replacement atomically.

### Dead code cleanup

- Removed orphan `text-shimmer.tsx` component (never imported) and its sole dependency `motion` (Framer Motion).
- Removed 6 stale CSS classes from `globals.css` — leftover upstream kanban styles (`kb-home-layout`, `kb-status-banner`, `kb-project-count-tag`, `kb-task-preview-pane`, `kb-task-preview-text`, `kb-markdown`).

### Other changes

- Prompt shortcuts can now be reordered via drag-and-drop in the editor dialog.
- Added close button (X) to the file content viewer header — deselects the current file and returns to the full tree view.

## [0.3.1]

### Git polling efficiency

- Replaced the fixed 1-second poll-everything-equally approach with three independent timers — focused task (2s default), background tasks (5s), home repo (10s). The selected task gets priority polling with an immediate probe on selection change.
- Added `p-limit(3)` concurrency cap on git child processes to prevent 20+ simultaneous spawns at scale.
- Added mtime-based cache for untracked file line counting — skips `readFile` when file hasn't changed since last poll. Bounded at 2000 entries.
- Backpressure guards on partial refresh functions prevent overlapping calls from piling up.
- All three poll intervals are configurable in Settings under "Git Polling."

### Runtime debug logging

- New runtime-togglable debug logging system — press `Cmd+Shift+D` to toggle the debug log panel and stream server-side logs to the browser in real-time. Ephemeral (resets on server restart), zero overhead when disabled.
- Bottom panel with level/source filters, search, auto-scroll. Batched WebSocket delivery (150ms) to avoid flooding.
- Targeted instrumentation on LLM client, title/summary generation, hook ingest, and the `generateDisplaySummary` / `regenerateTaskTitle` mutations to aid diagnosis of transient summary-unlinking issues.
- Client-side logger with same API for UI-side debug logging.
- Removed the debug logging toggle from Settings — the shortcut-only approach avoids a confusing UX where the toggle took effect immediately without enabling the Save button. Settings now shows a keyboard shortcut hint instead.
- Fixed debug log panel width overflow — long messages and data now word-wrap instead of overflowing horizontally.

### Config defaults and save path unification

- Extracted all runtime config defaults into a shared `config-defaults.ts` — server, frontend, and test factories now import from one source. Adding a new setting no longer requires copying the default value to 4-5 locations.
- Unified the two near-identical config save functions (`updateRuntimeConfig` / `updateGlobalRuntimeConfig`) into a single `applyConfigUpdates` internal function, eliminating the 8-edit-per-setting maintenance burden that had already caused a silent persistence bug.
- Fixed duplicated commit prompt template string in `DEFAULT_PROMPT_SHORTCUTS`.
- Fixed: autonomous mode initial state in settings dialog now matches server default (disabled by default).

### Windows runtime compatibility

- Fixed 7 runtime code paths that would crash or silently fail on Windows — `/dev/null` in git diff, `isProcessAlive` liveness check, unsupported signal registration (SIGHUP/SIGQUIT), symlinks requiring admin privileges (now uses junctions for directories), chmod no-op, case-sensitive lock ordering on case-insensitive filesystem, and Unix tilde in display paths.

### Diff sidebar indicator

- Blue dot on the Changes sidebar icon when a task's branch has unmerged changes relative to its base ref — content-based comparison resilient to squash merges. Red dot (uncommitted changes) takes priority. Configurable via a new setting toggle.

### Notification simplification

- Removed OS browser notifications — the audible cue system and tab title badge `(N)` are sufficient. The "Notifications" settings section is gone.

### LLM rate limiting

- Background LLM calls (auto-generated titles, branch names, summaries) are now rate-limited at 5 concurrent / 20 per minute to prevent runaway API costs from bugs or rapid state transitions.

### File browser improvements

- File browser expand/collapse state and file selection now persist when toggling between the sidebar panel and the full-size view.
- The expand button is hidden when no file is selected.
- Removed redundant X buttons from the expanded diff and file browser toolbars — they duplicated the collapse button with a misleading icon.

### Incremental expand in diff viewer

- Collapsed context blocks in diffs now show "show 20 more lines" buttons for progressive expansion instead of all-or-nothing expand. Cherry-picked from upstream cline/kanban#247.

### Resume conversation on session restart

- Restarting an agent session now resumes the existing conversation (`--continue`) instead of starting fresh. Cards stay in their current column on restart instead of being forced back to in-progress.

### Unify card action prop threading

- Replaced ~15 individually-threaded card action props with two React contexts (`StableCardActions` for handler callbacks, `ReactiveCardState` for per-render values). Both board and sidebar card paths now consume from the same source, eliminating prop drilling divergence between views.

### Other changes

- Fixed trash column sorting — was showing newest-trashed at top (same as active columns), now shows oldest-first so newly trashed items appear at the bottom in chronological order.
- Added a beta notice card at the bottom of the project sidebar with a "Report issue" link. Removed the dead Featurebase feedback widget.
- The detail sidebar can now be dragged up to 80% of viewport width (was capped at 45%).
- The restart session button on task cards now waits 1 second before appearing to prevent flashing during transient states.
- Default side panel ratio reduced from 25% to 15%.
- Default prompt shortcut textarea height increased from 3 to 5 rows.
- Base ref dropdown in the create task dialog is now greyed out when isolated worktree is unchecked.
- Fixed permission notification sound playing wrong beep count — hook activity data was arriving after the 500ms settle window expired due to slow checkpoint capture.

## [0.3.0]

### Always-visible sidebar

- Decoupled the detail sidebar from task selection — the sidebar now renders as a persistent 4-tab layout (Board, Terminal, Changes, Files) regardless of whether a task is selected. When no task is active, panels show workspace-level content or empty states. This is the foundation for the planned git management view and project switcher.

### Session state reconciliation

- Added periodic reconciliation (10-second interval) that polls actual agent/session state and corrects stale UI badges — permission prompts, approval indicators, and other status badges that outlive the session state they were derived from are now auto-corrected.
- Removed a flawed output-after-review heuristic that incorrectly bounced tasks back to running when agents produced incidental terminal output (spinners, ANSI redraws) after entering review.

### LLM generation improvements

- Unified all LLM-powered generation features (titles, branch names, summaries) with a consistent Sparkles icon, proper disabled states when no LLM is configured, and a dedicated settings section explaining env var requirements.
- Split summary character limits (LLM prompt budget vs display limit) to reduce mid-word truncation.
- Fixed `displaySummary` being wiped when consecutive hook events overwrote task card state.

### Other features

- Cross-workspace audible notifications — notifications now fire for tasks in all projects, not just the currently viewed one. Switching projects no longer silences notifications from other projects.
- Auto-restart shell terminals on unexpected exit — non-agent shell terminals automatically restart with crash-loop rate limiting (max 3 per 30s), a 1-second delay, and a settings toggle.
- Moved the prompt shortcut split button from per-card rendering to a single TopBar instance, eliminating a 6-prop threading chain.

### Bug fixes

- Fixed branch name on task cards getting out of sync — prioritized live metadata from the runtime over stale persisted state.
- Fixed chunky terminal rendering on low-DPR monitors by switching to light font weight.

### Maintenance

- Consolidated ~10 duplicated config mock factories into 2 shared files — adding a config field now touches 1-2 files instead of 12.
- Removed dead code, unused exports, and unused dependencies across the codebase.
- Recommended Nerd Font installation in README setup instructions.

## [0.2.0]

**Quarterdeck.** The project formerly known as Kanban has been renamed, rebranded, and substantially reworked. This release includes 194 commits spanning new features, architectural changes, and a full identity overhaul.

### Rename and rebrand

- Renamed the project from "kanban" to "quarterdeck" across the entire codebase — CLI, package name, config paths (`.cline` → `.kanban` → `.quarterdeck`), documentation, and branding
- Replaced robot icons with lucide sailboat icons to match the nautical theme
- Changed the default runtime port from 3484 to 3500
- Isolated dogfood state via `KANBAN_STATE_HOME` env var so development testing doesn't collide with real usage

### Agent streamlining

- Removed Cline SDK integration entirely (frontend components, backend API types, chat runtime, MCP OAuth) — quarterdeck now focuses purely on orchestrating CLI agents via PTY
- Removed Factory Droid agent support
- Removed Sentry, PostHog, OpenTelemetry, and npm auto-update — stripped all third-party telemetry and analytics
- Removed the beta support footer and feedback widget

### Board cards redesign

- Redesigned board cards with status badges, a dedicated title field, branch name with diff stats, and a cleaner layout
- LLM-generated card titles — titles are generated by injecting a prompt into the running agent, with a regenerate button and hover tooltip
- Inline title editing with a pen icon and auto-generate button
- Pin-to-top feature for board cards
- "No WT" badge (red) on cards that aren't using a worktree
- In-progress and review columns now sort by most recently updated
- Distinguish permission prompts from ready-for-review on task cards, with separate notification labels for approval vs review

### File browser

- Added a full file browser panel to the detail view — tree view of the task worktree with expand all / collapse all, keyboard navigation, search with debounce, and symlink traversal
- File browser state resets on card switch with proper error surfacing

### Branch and worktree management

- Branch persistence on cards — tasks remember their branch, with opt-in branch creation and LLM-powered branch name generation
- Configurable worktree and branch strategy for task creation
- Worktrees default to on; cards without a worktree show a visible badge

### Review and diff improvements

- Configurable prompt shortcuts for review cards — replaced the hardcoded commit/PR prompt injection with a user-managed shortcuts dropdown, editor dialog, and localStorage persistence
- Simplified auto-review to trash-only mode
- Show branch comparison label in diff viewer toolbar
- Uncommitted changes indicator in the detail toolbar
- Swapped diff panel layout for better readability

### Detail view

- Added a JetBrains-style toolbar to the card detail view
- Conversation summaries with LLM-powered display summaries on cards
- Larger, resizable task create dialog with viewport-relative sizing
- Shell terminal in detail view with clear and restart buttons
- Restart session button for failed or stuck agent tasks

### Notifications and interaction

- Trash confirmation dialog with worktree notice toast before deleting tasks
- Configurable audible notifications for task events
- Remapped create task dialog shortcuts to prioritize the start action

### Terminal

- Switched to Nerd Font Mono / JetBrains Mono NL (no ligatures) for crisper terminal rendering
- Terminal re-renders when moving windows between monitors with different DPR
- Wait for font readiness before opening xterm terminals
- Reset terminal rendering button in settings dialog

### Stability and bug fixes

- Eliminated the dual-writer race between server and UI for board state — the UI is now the single writer when connected, preventing "Workspace changed elsewhere" conflicts
- Added `--no-optional-locks` to polling git commands to prevent `index.lock` contention
- Prefer default branch over current branch for new task base ref
- Await agent process exit before worktree cleanup on trash
- Recover cards stuck in running after user interrupts agent
- Preserve detail terminal session across task switches
- Clear stale hook activity on review transitions
- Prevent stale permission fields from persisting across hook events
- Fix drag-and-drop restoring wrong task from sorted columns
- Fix refresh project config after dismissing trash worktree notice toast
- Fix feature branch toggle not resetting when opening create task dialog
- Dialog sizing guardrails across settings, task create, and alert dialogs

---

> **Note:** This project was renamed from "kanban" to "quarterdeck" as of this release. All entries below were released under the original name.

## [0.1.59]

- Added a beta hint card to the project sidebar with quick access to send feedback or report issues
- Added "Read the docs" button in the settings dialog linking to documentation
- Adjusted prompting for the commit button to better handle stale git lock files and multiple stashes at once

## [0.1.58]

- More panels are now resizable (agent chat, git history, and more) and your layout preferences persist across sessions
- Adds full Factory Droid CLI agent support
- Add, edit, and delete custom OpenAI Compatible providers from the settings dialog
- Fixed trashed task cards being openable from the board
- Fixed git history cache not clearing when closing the view
- Terminal cursor defaults now match VS Code behavior
- Feedback widget no longer triggers authentication until you actually click it
- Updated Cline SDK from 0.0.24 to 0.0.28, which includes: OpenAI-compatible provider support via AI SDK, custom provider CRUD in core, better handling of overloaded and insufficient-credits errors, fixed tool schema format for OpenAI-compatible providers, accurate input token reporting

## [0.1.57]

- Added `kanban --update` command so you can check for and install updates manually
- Fixed Windows agents (like Codex) being incorrectly launched through cmd.exe when they're native executables
- Reduced latency when switching between projects
- Restored the feedback widget with proper JWT authentication
- Fixed telemetry service configuration for Cline agents
- Updated Cline SDK from 0.0.23 to 0.0.24, which includes reasoning details support and improved JSON Schema handling for tool definitions

## [0.1.56]

- Automatic context overflow recovery: when the conversation history exceeds the model's context window, Kanban now compacts old messages and retries instead of failing
- Credit limit errors (insufficient balance / 402) are now surfaced immediately without unnecessary retries or confusing system messages
- Added report issue and feature request links to the settings dialog
- Added Cline icon to browser notifications
- Updated Cline SDK from 0.0.22 to 0.0.23, which includes: LiteLLM private model support, provider-specific setting configs, loop detection as a built-in agent policy, provider ID normalization for model resolution, OAuth token refresh fix for spawned agents

## [0.1.55]

- Fixed non-ASCII file paths (e.g. Japanese, Chinese, Korean characters) rendering as garbled octal escape sequences in the diff view

## [0.1.54]

- Task agent chat panel resizing now persists when navigating between tasks

## [0.1.53]

- Added `/clear` slash command to reset the Cline agent chat session
- Added hints for environment variables in Cline provider setup
- Aligned Cline provider and model fallbacks with SDK defaults for more reliable configuration
- Fixed Codex plan mode not working
- Fixed slash command file watchers to reuse a single watcher per workspace instead of creating duplicates
- Show loading skeleton in onboarding carousel while videos load
- Added VS Code Insiders as a file open target

## [0.1.52]

- Added support for custom OpenAI-compatible providers, so you can connect any OpenAI-compatible API as a Cline model provider
- Added PWA support -- the web UI can now be installed as a standalone desktop app from Chrome, with window controls overlay and an offline fallback page that auto-reconnects when the server comes back
- Sticky file headers in the diff viewer now pin under the toolbar while scrolling through large diffs
- Show a cleanup spinner during Ctrl+C shutdown instead of silently hanging
- Fixed Codex status monitoring to reliably track the latest tool call
- Fixed terminal color detection for TUI apps like Codex CLI that query both foreground and background colors at startup
- Fixed activity preview text getting truncated in hooks
- Fixed project column sizing not persisting across sessions
- Fixed home sidebar session IDs not matching the current format

## [0.1.51]

- Task terminals now support multiple simultaneous viewers, so opening the same task in several browser tabs no longer causes disconnections
- Terminal TUI state is now preserved across reconnects, so you no longer lose your terminal view when the connection drops and re-establishes
- Fixed Codex CLI content disappearing or rendering incorrectly -- PTY sessions are now fully server-side, so you can refresh the page, switch between tasks, and unmount terminals without losing any output
- Fixed home sidebar terminal sessions not reconnecting after navigation
- Switched to esbuild for faster builds
- Claude agent hyperlinks now render correctly in Kanban terminals
- Fixed screen flickering and unnecessary polling when viewing trashed tasks
- Fixed restoring tasks from trash using the wrong agent
- Fixed stale git worktree registrations that could cause worktree operations to fail

## [0.1.50]

- Updated Cline SDK from 0.0.21 to 0.0.22, which includes: fixed hook worker process launching to use a more robust internal launch mechanism

## [0.1.49]

- Updated Cline SDK from 0.0.16 to 0.0.21, which includes: organization fetching support, SDK declaration maps for better type resolution, OpenAI Compatible provider migration and cleanup of the legacy provider, agent telemetry events with agent ID and metadata, bash tool and home directory fixes on Windows, and exposed LoggerTelemetryAdapter in the node package

## [0.1.48]

- Fixed sidebar agent attempting to edit files and write code instead of staying focused on Kanban board management

## [0.1.47]

- Fixed browser open failing on Linux systems where `xdg-open` is not available

## [0.1.46]

- Added reasoning level dropdown to Cline provider settings and the model selector in the chat composer
- Images can now be attached when creating tasks for Claude Code and Codec CLI agents -- images are saved as temporary files and their paths are passed into the prompt since TUIs don't support inline images
- Added shortcuts for diff view actions and a "Start and Open" shortcut as an alternative to starting a task (shout out to Shey for the idea!)
- Fixed issues with the sidebar Cline chat session not reloading after adding MCP servers
- The project column can now be collapsed all the way to the edge for a minimal view (shout out to Shey for this idea!)
- Fixed issues with some Next.js project configurations in worktrees
- Fixed diff viewer showing false changes for end-of-file-only differences
- Fixed a crash in older browsers when generating UUIDs for board state
- Fixed a crash on Windows when resizing the terminal after the PTY process has exited

## [0.1.45]

- Fixed kanban access validation to only apply restrictions to enterprise customers, so non-enterprise users are no longer incorrectly blocked

## [0.1.44]

- Fixed remote configuration not being applied correctly

## [0.1.43]

- Kanban access can now be gated via Cline remote config
- Fixed "C" (create task) keyboard shortcut crashing when no projects exist
- Fixed macOS directory picker treating cancel as an error instead of a normal cancellation
- Improved agent selection copy during onboarding
- File paths in the settings dialog now display with `~` instead of the full home directory
- Fixed incorrect "kanban" branding in the disconnected screen (now says "Cline")
- Fixed cancel button showing wrong label in detail view panels
- Temporarily disabled Featurebase feedback widget

## [0.1.42]

- Fixed auto-update failing on Windows by using the correct `.cmd` extensions for package manager commands (npm, pnpm, yarn)

## [0.1.41]

- Cline agent sessions now automatically recover after a runtime teardown, so work isn't lost if the runtime restarts
- Per-task plan/act mode now persists when switching between tasks
- Chat messages sent while the agent is actively working are now queued and delivered when the turn completes, instead of being dropped
- Fixed repeated MCP OAuth callbacks causing errors when the browser fires the redirect more than once
- Fixed corrupt patch captures when trashing tasks in worktrees
- Session IDs are now sanitized for Windows-safe file paths
- Agent mistake tolerance increased from 3 to 6 consecutive errors, giving the agent more room to recover from transient failures
- Fixed the navbar agent setup hint showing incorrect state
- Use the `open` package for cross-platform URL opening instead of custom logic
- Updated Cline SDK to 0.0.15 with file-based store fallbacks, remote config support, improved chat failure handling with message state rollback, and a new `maxConsecutiveMistakes` option to prevent agents from getting stuck in failure loops

## [0.1.40]

- Sidebar agent now stays focused on board management and redirects coding requests to task creation, so dedicated agents handle implementation work in their own worktrees
- Fixed feedback widget initialization for Cline-authenticated users

## [0.1.39]

- Fixed the feedback widget not opening reliably when clicking "Share Feedback"
- Capitalized button labels for consistency ("Add Project", "Share Feedback")

## [0.1.38]

- First-run onboarding for script shortcuts -- new users are guided through creating their first shortcut directly from the top bar
- Settings file URLs can now be opened
- Fixed terminal bottom pane content clearing when running script shortcuts

## [0.1.37]

- Slash commands and file mentions in the client chat input field
- Share Feedback button in the bottom left, powered by Featurebase and enriched with Cline account data like email so we can see who reports are coming from, with a Linear integration for automatic issue creation
- MCP OAuth callbacks consolidated onto the main runtime server with real-time auth status updates
- Linear MCP shortcut for one-click install setup
- Updated startup onboarding carousel with a screen about using camera and the agent to add tasks
- Conversation history always visible in detailed task view
- Fixed an issue where adding MCPs wouldn't be available in existing Cline chats -- adding MCPs now resets Cline chats to use them
- Fixed an issue where the client chat would get into a "task chat session is not running" error state. You can now send a message to continue the conversation when Cline fails a tool call
- Fixed an issue where binary diffs would not show up in diff views
- Diff renderer groups removals before additions for easier reading
- Fixed default model selection when OAuth login leaves it blank
- Updated Cline SDK with fixes for ask question tool being disabled in yolo mode, cost calculation, and tool description and truncation logic improvements

## [0.1.36]

- Added Sentry error reporting to help identify and fix crashes faster
- Fixed terminal sessions sometimes failing to reconnect, which caused the terminal emulator to scroll to the top during card transitions before scrolling back down
- Fixed onboarding to default to Cline as the AI provider and automatically set the provider's default model, preventing errors when switching providers without updating the model
- Fixed Ctrl+C to wait for Cline to finish shutting down before fully exiting, preventing false double-interrupt exits
- Upgraded Cline SDK from 0.0.7 to 0.0.11 with numerous fixes and improvements:
  - Fixed prompt caching being broken for Anthropic models, meaning users were paying full price every turn. Cost calculation was also fixed (it was double-counting cache reads and ignoring cache writes)
  - Fixed cancelling a request causing all subsequent requests in the session to immediately fail, due to a reused AbortController
  - Fixed Gemini tool use failing for most non-trivial tool schemas. JSON Schema properties not in Gemini's allowed set (like `default`, `pattern`, `minLength`) caused Gemini to reject entire requests
  - Fixed tools with no required parameters (like "list all") being silently dropped
  - Fixed CLI hanging indefinitely in CI/Docker environments when stdin was detected as "not a TTY" but wasn't providing input
  - Fixed Vercel AI Gateway being completely broken (base URL was `.app` instead of `.sh`, so all requests 404'd)
  - Fixed internal metadata fields leaking into API requests sent to providers, wasting tokens
  - Fixed multi-agent team tools failing when the orchestrator sent null for optional filter parameters. Also added concurrent run prevention and better error visibility for teammate failures
  - Fixed MCP tool names with special characters or exceeding 128 chars causing provider schema validation errors (now sanitized with a hash suffix)
  - Fixed OpenRouter and other gateway error messages showing opaque nested JSON blobs instead of the actual error
  - Fixed `--json` mode output being impure (plain text warnings leaked into stdout, breaking JSONL parsing)
  - Fixed SQLite crashing with a disk I/O error on first run instead of auto-creating the data directory
  - Fixed "Sonic boom is not ready yet" error on CLI exit
  - Removed hardcoded 8,192 max output tokens per turn cap, so models are no longer artificially limited
  - Added OpenAI-compatible prompt caching support
  - Added OpenAI-compatible providers now surface truncated responses (`finish_reason: "length"`) so callers can detect them
  - Headless mode no longer requires a persisted API key -- env vars like `ANTHROPIC_API_KEY` now work
  - Headless mode output cleaned up: model info, welcome line, and summary gated behind `--verbose`
  - Config directory is now overridable via `--config` flag or `CLINE_DIR` env var for isolated config across multiple SDK instances
  - `readFile` executor now supports optional `start_line`/`end_line` parameters, enabling models to read specific portions of large files

## [0.1.35]

- Added runtime debug tools accessible from the top bar for troubleshooting configuration and agent state
- Settings now automatically retry loading when the initial attempt fails, improving reliability on slower connections

## [0.1.34]

- Model pickers now show recommended Cline models for quick selection
- Failed tasks show a red error icon and failure reason on the board card instead of a spinner
- When adding a project on a headless/remote runtime where no directory picker is available, you can now enter the project path manually
- Fixed workspace not refreshing correctly on startup by waiting for the runtime snapshot before syncing
- Fixed Kanban agent creating tasks for worktree paths instead of the main project

## [0.1.33]

- Fixed task worktree setup for Turbopack projects no longer attempting slow background copies of node_modules; affected subproject dependencies are now correctly skipped instead of symlinked

## [0.1.32]

- Fix concurrent task mutations (e.g. adding multiple tasks at the same time) failing due to write conflicts -- task mutations now use a workspace lock to safely handle simultaneous operations
- Fix a bug where stopping a task that was restored from a previous session would fail because the session wasn't properly reconnected on startup
- Fix a bug where restarting the app would show raw metadata in user messages for old Cline sessions that were reloaded
- Fix worktrees for projects using Turbopack, where symlinked node_modules would cause build failures -- worktrees now fall back to copying node_modules for Turbopack projects
- Fix SDK command parsing that could cause agent system prompts to be malformed
- Fix Cmd+V image paste in the chat composer not working due to the paste handler running asynchronously, causing the browser to swallow the event
- Fix proper-lockfile crashing due to accidentally passing undefined as the onCompromised handler
- Require confirmation before git init when adding projects
- Fix task card agent preview flickering to empty state
- Cancel inline task edit on Escape key press
- Move task worktrees to ~/.cline/worktrees
- Update onboarding intro video and frame width
- Change the start-all-tasks shortcut to Cmd+B

## [0.1.31]

- Add ability to resume Cline tasks that were trashed
- Support image attachments for Cline agent chat
- Fix the commit and make PR button in the Cline agent chat panel
- Fix issue where creating multiple tasks at the same time with git submodules would run into a git config locking issue
- Fix script shortcuts to interrupt previously long-running commands, so you no longer need to Ctrl+C before hitting the shortcut again
- Fix issue where running incorrect kanban commands would auto-open the browser
- Preserve runnable kanban command in sidebar prompt
- Avoid premature Codex review state transitions
- Fix diff "Add" button incorrectly sending Cline chat messages
- Various UX improvements (checkbox labels, Cline thinking shimmer animation)

## [0.1.30]

- Add MCP server management and OAuth authentication for Cline providers
- Add "Start All Tasks" keyboard shortcut (Alt + Shift + S)
- Show assistant response previews in task card activity instead of generic "Agent active" text
- Track full chat history per task, enabling richer conversation display and reliable message streaming
- Display API key expiry as a human-readable date instead of a raw number
- Support launching Kanban without a selected project (global-only mode)
- Automatically restart agent terminals when the underlying process exits unexpectedly
- Fix prewarm cleanup accidentally disposing the detail panel terminal for active tasks
- Fix task card expand animation jumping by waiting for measured height before animating
- Fix Cline thinking indicator flicker in the chat panel

## [0.1.29]

- Fix onboarding and settings screens not working when no projects exist
- Update Cline SDK with auth migration for existing CLI users and fixes for OpenAI-compatible APIs

## [0.1.28]

- Onboarding dialog for first-time users with guided walkthroughs for auto-commit, linking, and diff comments
- Dependency links now show arrowheads so you can see direction at a glance, and the agent provides guidance about link direction when creating them
- Cline chat input field now includes a model selector, plan/act mode toggle, and a cancel button to stop generations midstream
- Resizable project sidebar (drag to resize, persists across sessions)
- Show the full command in expanded run_commands tool calls
- Review actions (Commit, Open PR) only appear when there are actual file changes
- Cline chat preserves your scroll position when reading older messages
- Failed tool calls display proper error messages instead of deadlocking the session
- "Thinking" indicator shows while tool calls are loading
- ANSI escape codes from CLI output are stripped instead of showing raw characters
- Inline code in Cline chat wraps correctly instead of overflowing
- Tasks with uncompleted dependencies can no longer be started
- Better error reporting when Cline fails to start (clear messages instead of silent hangs)
- Gracefully handles missing provider settings instead of crashing
- Removed OpenAI, Gemini, and Droid agents to reduce surface area at launch (coming back in follow-up releases)

## [0.1.27]

- Upgraded Cline SDK to stable v0.0.4, replacing nightly builds for more reliable native Cline sessions

## [0.1.26]

- Trashing a task now saves a git patch of any uncommitted work, and restoring it from trash automatically reapplies those changes so nothing gets lost
- "Create more" toggle in the new task dialog lets you create multiple tasks in a row without reopening the dialog each time
- New keyboard shortcuts: Cmd/Ctrl+G toggles the git history view, Cmd/Ctrl+Shift+S opens settings, and Esc closes git history from the home screen
- Shortcut commands now safely interrupt any running terminal process before executing, so commands no longer get jumbled with whatever was previously running
- Agent file-read activity now shows the full list of files being accessed instead of truncating with "(+N more)"
- Expanding the diff view now automatically closes the terminal panel to avoid overlapping views
- Task worktree cleanup no longer gets stuck when patch capture fails
- Fixed the "Thinking..." indicator incorrectly appearing while the agent is actively streaming a response
- Native Cline sessions now correctly capture their latest changes when entering review
- Removed the redundant "Projects" label below the sidebar segment tabs
- Consistent spacing and alignment across all alert dialogs
- Fixed terminal background color in the detail view to match the rest of the overlay

## [0.1.25]

- Added a chat view to the home sidebar for project-scoped agent conversations. What used to be the project column is now a sidebar that can switch between projects and chat.
- The agent can now trash and delete tasks on your behalf using new task management commands
- When no CLI agent is detected, a guided setup flow walks you through getting started
- Replaced the Kanban skill system with `--append-system-prompt` -- since the board now has a dedicated agent, we just append context to its prompt instead of maintaining a separate skill
- Native Cline SDK chat runtime with cancelable turns
- `--host` flag to bind the server to a custom IP address
- Submodules are now initialized automatically in new task worktrees
- Fix Escape key unexpectedly closing the detail view
- Increased shortcut label and footer font sizes
- Capped agent preview lines in task cards

## [0.1.24]

- Fixed multiline prompt arguments being broken on Windows cmd.exe

## [0.1.23]

- Fix Windows terminal launches incorrectly escaping arguments with spaces, parentheses, and other special characters

## [0.1.22]

- Fix Windows terminal launch failing for bare executables (e.g. `cline`) due to unnecessary quoting

## [0.1.21]

- Fix Windows agent commands failing to launch
- Fix update detection for Windows npm-cache npx transient installs
- Reduce false-positive triggering of the kanban skill
- Show worktree errors in toasts

## [0.1.20]

- Fix branch picker showing remote tracking refs instead of just local branches, and enable trackpad scrolling in the picker
- Fix task card activity not updating when Opencode completes hook actions
- Fix Cline tasks getting stuck instead of returning to in-progress when asking follow-up questions during review

## [0.1.19]

- Fixed a race condition where navigating to a task's detail view could trigger an unintended auto-start
- Fixed shutdown cleanup to reliably stop all running tasks across projects

## [0.1.18]

- Fix layout stability when moving cards between columns programmatically
- Improve checkbox contrast on dialog footers
- Reduce dialog header/footer side padding to match vertical padding
- Fix description briefly flashing on card mount

## [0.1.17]

- Fix keyboard shortcuts (Cmd+Enter) not working when focus is on dialog inputs

## [0.1.16]

- Fixed agent startup reliability and command detection
- Fixed path handling on Windows and Linux for cross-platform support

## [0.1.15]

- Fix diff view syntax highlighting colors in git history
- Improve graceful shutdown handling for CLI processes
- Fix worktree symlink mirroring for ignored paths to avoid blocking operations
- Fix process cleanup on Windows when tasks time out
- Support Windows AppData path discovery for Opencode integration
- Make "Open in Editor" workspace actions work correctly across platforms
- Add directory picker support on Windows
- Fix transcript path detection in hooks
- Handle Linux directory picker fallbacks and errors gracefully

## [0.1.14]

- Fixed a crash on Linux systems where no browser opener (xdg-open, etc.) was available

## [0.1.13]

- New task creation dialog with list detection for quickly creating multiple tasks at once
- Git history now shows remote refs and branch divergence so you know if you need to pull
- Expandable task card descriptions -- click to reveal the full description inline
- Notifications now show the latest agent message
- Improved split diff rendering by consolidating same hunk changes
- Fixed issue where cards in the kanban column updating content would cause scroll jumps

## [0.1.12]

- Redesigned the web UI with a refined dark theme, custom UI primitives, and polished controls for a more professional look and feel
- Added split diff view so you can click the expand button above any diff to see changes side by side
- Added last turn changes, which takes a Git snapshot each time you send a message to your agent so you can see exactly what changed since your last message
- Added an all changes view to see every modification in a task's worktree at a glance
- Resizable agent terminal emulator so you can drag to make it bigger or smaller
- Inline task creation controls with keyboard shortcut hints
- Fix diff panel persisting stale content when switching views
- Fix last-turn diff transitions flickering during scope changes
- Only keep terminal connections alive for tasks actively on the board, and clean them up when the runtime disconnects
- Fix WebSocket proxy so terminal connections work correctly during local development
- Fix the dogfood launcher not waiting for the child process to exit, which could leave orphaned processes on shutdown

## [0.1.11]

- Add Kanban skill for creating and managing tasks directly from your agent
- Remove Kanban MCP server in favor of skill-based task automation

## [0.1.10]

- Add "Start task" button to create task card -- press `c` to create, type your task, then Cmd+Shift+Enter to start it right away
- Add "Cancel auto-review" actions to task cards
- Add "Start All" button to backlog column header to start all backlog tasks at once
- Add Cmd+Enter shortcut for sending diff comments
- Show keyboard shortcut hints on the create task button
- Simplified shortcut icon picker
- Show authentication warning callout in Linear MCP setup dialog
- Show loading state on trash button while deleting
- Resume paused droid tasks when read/grep hooks fire
- Fix stale diff persisting when switching between task details
- Fix stale script shortcuts lingering after switching projects
- Fix git history flicker during scope switches
- Fix terminal rendering for Droid CLI in split terminals
- Fix linked task start animations
- Detect when GitHub/Linear/Kanban MCPs are already installed to skip unnecessary setup dialogs
- Fix resuming trashed tasks after terminal refactors
- Fix Droid CLI review state transitions around AskUser tool calls
- Default new users to Cline CLI when installed
- Highlight active branch button in blue
- Fix settings dialog appearing disabled during config refresh
- Center selected detail card in sidebar

## [0.1.9]

- Fix worktree paths with symlinks in ignored directories being incorrectly treated as active

## [0.1.8]

- Terminal now properly renders full-screen TUI applications like OpenCode
- Fixed terminal content disappearing and scroll back being lost when opening a task. Terminals are now created proactively for each agent instead of connecting mid-session, which preserves full scroll back and content rendering. This is especially important for rendering TUI apps like Codex and Droid correctly.
- Improved terminal rendering quality, inspired by VS Code's xterm and node-pty implementation. Noticeably higher FPS, smoother scrolling, and a more native look and feel for terminal emulators.

## [0.1.7]

- When a task prompt mentions creating tasks (e.g. "break down into tasks", "create 3 tickets", "split into cards"), Kanban now shows a setup dialog offering to install the Kanban MCP before the task starts
- Similar setup dialogs appear for Linear and GitHub CLI when task prompts reference those services
- MCP server instructions now guide agents to detect the ephemeral worktree path and pass the main worktree as projectPath, so "add tasks in kanban" tasks correctly create tasks in the main workspace instead of the ephemeral task worktree

## [0.1.6]

- Show live hook activity (tool calls, file edits, command runs) on task cards as agents work
- Auto-confirm Codex workspace trust prompts so tasks start without manual intervention
- Show working copy changes in the detail panel's git history
- Fix terminal pane state bleeding across tasks when switching between them
- Fix duplicate paste events in agent terminals
- Stop detail terminals when trashing tasks to free resources
- Automatically pick up new versions when launching with `npx kanban`
- Fix git metadata not updating reliably when switching projects
- Stabilize workspace metadata stream startup

## [0.1.5]

- Added Droid CLI agent support alongside Claude and Codex
- Dogfood launcher for quickly opening Kanban on its own repo with runtime port selection
- Terminal rebuilt around xterm and node-pty for better performance and reliability
- Filter terminal device attribute auto-responses from being sent to agents as input
- Fix workspace metadata causing unnecessary rerenders, with retry recovery
- Fix task worktrees being recreated when the base ref updates if they already exist
- Fix self-ignored directories being symlinked in task worktrees
- Fix bypass permissions toggle resetting unexpectedly
- Fix git refs not clearing when switching detail scope

## [0.1.4]

- Each task gets its own CLI agent working in a git worktree, so they can work in parallel on the same codebase without stepping on each other
- When an agent finishes, review diffs and leave comments before deciding what to merge
- Commit or open a PR directly from the board, and the agent writes the commit message or PR description for you
- Link tasks together to create dependency chains, where one task finishing kicks off the next, letting you complete large projects end to end
- "Automatically commit" and "automatically open PR" toggles give agents more autonomy to complete work on their own
- MCP integration lets agents add and start tasks on the board themselves, decomposing large work into parallelizable linked tasks
- Built-in git visualizer shows your branches and commit history so you can track the work your agents are doing
