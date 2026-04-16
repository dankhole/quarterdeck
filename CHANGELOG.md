# Changelog

## [Unreleased]

### Fix: restore sidebar panel state when returning to agent chat

- Switching from agent chat (terminal view) to a full-screen view (file browser, git) and back now automatically reopens the previously-open sidebar panel (e.g. task column). The auto-collapse on view switch saves what was open; returning to terminal restores it. Manual sidebar toggles, home navigation, and project switches clear the saved state so restoration only fires for the specific auto-collapse → return flow.

### Refactor: split runtime-config test file into focused modules

- Split the 951-line `runtime-config.test.ts` into 5 focused test files + shared helpers module, all under 250 lines. Extracted repeated 40-field save payloads into a `createDefaultSavePayload()` factory. No test logic changes — same 28 tests, same assertions.

## [0.9.2] — 2026-04-15

### Fix: remember last viewed file when switching tasks

- Git view now restores the previously selected file when switching back to a task, instead of resetting to the first file. Uses the existing `lastSelectedPathByScope` per-task cache — replaced the unconditional null reset with scope-aware eager restoration on task switch, matching the pattern in `use-file-browser-data.ts`.

### Fix: preserve file browser scroll position and expanded dirs across navigation

- File browser tree panel now saves and restores its scroll position when navigating away and back (switching tasks, toggling views). Uses the virtualizer's `initialOffset` for flash-free restoration with a module-level Map keyed by scope.
- Expanded directory state and initialization flag are now persisted per scope in `FilesView`, so switching tasks no longer collapses the tree and re-runs initial expansion.

### Refactor: extract domain logic from hooks into plain TS modules (Phase 2)

- **Batch 1** — Split 3 priority hooks into domain module + thin React wrapper pairs: `task-lifecycle.ts` (board revert helpers, workspace info mapping, isolation predicate), `conflict-resolution.ts` (step-change detection, unresolved path filtering, external resolution detection), `workspace-sync.ts` (session merging, revision conflict guards, board hydration decisions). 29 new domain-level unit tests across 3 test files.
- **Batch 2** — Extracted 6 more hooks: `git-actions.ts` (loading state derivation, workspace info matching, error titles), `terminal-panels.ts` (geometry estimation, pane height persistence, panel state helpers), `settings-form.ts` (form values type, initial values resolver, equality check), `commit-panel.ts` (selection sync, commit validation, success formatting), `trash-workflow.ts` (types, initial states, trash column queries), `project-navigation.ts` (error parsing, picker detection, manual path prompt). 63 new domain-level unit tests across 6 test files. Phase 2 now 9 of ~11 candidates done.

### Docs: hooks architecture conventions (Phase 3)

- Added "Hooks architecture" section to `docs/web-ui-conventions.md` — codifies directory structure, domain module vs hook separation pattern, naming conventions, backward-compatible re-exports, and reference table of all 9 existing extractions. Updated `AGENTS.md` to reference the new conventions and add the >50-line extraction rule.

### Refactor: extract ConnectedTopBar, HomeView, and AppDialogs from AppContent

- Extracted three JSX-heavy sections from AppContent (1348 → 820 lines) into dedicated components. Each reads from existing contexts and receives only hook-local values as props — pure JSX extraction with zero behavior change. ConnectedTopBar (184 lines) owns the TopBar with branch pill and git sync wiring; HomeView (271 lines) owns the loading/empty/board/git/files view switch and bottom terminal; AppDialogs (234 lines) owns all 18 dialog/shelf components.

### Fix: dedicated shell terminals blank after close/reopen

- Closing and reopening a shell terminal (home or detail dev shell) could leave the terminal blank or broken. The xterm canvas was orphaned from the DOM when React unmounted the panel container, causing WebGL context loss. Added `park()` to `TerminalSlot` — moves the host element back to the off-screen parking root before the container is removed, keeping the canvas in the live DOM so it survives the round-trip.

### Fix: auto-restart only fires for genuine crashes, not normal agent exits

- `shouldAutoRestart` now checks the pre-exit session state — only restarts when the agent was actively `running` at exit time. Agent processes that exit after completing work (already in `awaiting_review`) are normal lifecycle cleanup, not crashes.
- The state machine's `process.exit` handler now preserves the existing review reason when the session is already in `awaiting_review`. Previously it unconditionally overwrote the reason (e.g. `hook` → `error`), making completed tasks show "Error" instead of "Ready for review".
- `recoverStaleSession` only attempts restart for `reviewReason: "error"` (genuine crash). Previously it restarted for any non-`exit` reason, causing spurious restarts on viewer reconnect.
- Reconciliation sweep treats all processless `awaiting_review` sessions as expected — the agent finished and the process exited as normal cleanup.

### Fix: auto-focus agent terminal on open

- Opening an agent terminal now immediately grabs keyboard focus. Previously, `terminal.focus()` fired before the restore snapshot completed — while the terminal was still `visibility: hidden` — so the browser silently ignored it. Focus is now deferred until the terminal is revealed after restore, including the restore-failure path.

### Refactor: rename debug-logger to runtime-logger

- Renamed `src/core/debug-logger.ts` to `src/core/runtime-logger.ts` — the "debug" name was a holdover from when logging was a boolean on/off toggle. Renamed internal types (`DebugLogLevel` → `LogLevel`, `DebugLogEntry` → `LogEntry`) and functions (`getRecentDebugLogEntries` → `getRecentLogEntries`, `onDebugLogEntry` → `onLogEntry`) to match. API contract wire-format schemas unchanged.
- Added `HH:MM:SS` local-time timestamps to all console log output from the runtime logger.
- Bumped orphan cleanup "found" and "killed" log messages from `info` to `warn` so they appear at the default threshold.

### Refactor: complete frontend provider migration

- Migrated all hook/state logic from the monolithic App.tsx into 6 focused provider components (ProjectProvider, BoardProvider, TerminalProvider, GitProvider, InteractionsProvider, DialogProvider). Eliminated the AppCore intermediate component. App is now a ~50-line composition root; each provider is independently maintainable. AppContent props reduced from 35+ to 2.

### Refactor: organize web-ui hooks into domain subdirectories

- Reorganized the flat 78-file `hooks/` directory into 5 domain subdirectories (`board/`, `git/`, `terminal/`, `project/`, `notifications/`) — hooks are now grouped by the domain they serve. Relocated 5 non-hook files (utility functions, constants, React components) to their proper directories (`utils/`, `terminal/`, `components/`). ~123 import sites updated across ~40 files. Pure structural change — no logic modifications.

## [0.9.1] — 2026-04-15

### Fix: preserve terminal review reasons across server restart

- Sessions in `awaiting_review` with a terminal review reason (`hook`, `exit`, `error`, `attention`, `stalled`) now survive server restarts and shutdowns — they represent completed agent work or explicit review requests. Previously, both `hydrateFromRecord` (startup) and the shutdown coordinator unconditionally overwrote them to `interrupted`, losing the meaningful review state.
- Only `running` sessions and `awaiting_review` sessions with non-terminal reasons (`interrupted`, `null`) are marked interrupted for auto-resume.

### Fix: CI test failures — bare repo branch name, stale hydration assertions

- Fixed `git-stash.test.ts` `dirtyTree` test: bare repo `git init` missing `-b main` caused `push origin main` to fail on CI runners with `init.defaultBranch=master`.
- Updated 4 test files with assertions that expected `awaiting_review` → `interrupted` after hydration to match the new preserve-terminal-reasons behavior.

### Fix: reconnect terminal WebSockets after sleep/wake

- After a computer sleeps and wakes, WebSocket connections die but the terminal pool still held slot references for the task. `acquireForTask()` and `ensureDedicatedTerminal()` returned the existing slot without reconnecting, leaving the terminal blank despite a live agent session. Added `ensureConnected()` to `TerminalSlot` and a `visibilitychange` reconnection path so terminals auto-recover on wake.

### Perf: auto-evict PREVIOUS terminal slot after 30 seconds

- Hidden PREVIOUS terminal slots kept their IO WebSocket open indefinitely, causing xterm.js to parse incoming PTY bytes and execute WebGL draw calls into an invisible canvas — driving GPU work and WindowServer compositing overhead. PREVIOUS slots now auto-evict after 30 seconds, closing sockets and stopping rendering. Switching back within 30s still reuses the warm slot instantly; after 30s the slot is reacquired fresh with a server restore.

### Fix: background terminal re-sync on task switch

- When switching tasks, the previously-active terminal slot is demoted to PREVIOUS but keeps its WebSocket connections open. The xterm buffer could drift into a garbled visual state during this period, which persisted if the user switched back before the slot was evicted. Now `requestRestore()` fires on demotion — re-syncing the buffer from the server's headless mirror while the user isn't looking — so the terminal is clean on return.

### Fix: compare view branch dropdown left-click

- Left-clicking a branch in the compare bar's source/target dropdowns opened the context menu instead of selecting the branch. Added `disableContextMenu` to both `BranchSelectorPopover` instances in `CompareBar` so left-click performs direct selection.

### Fix: noisy auto-restart warning on task trash

- Trashing a running task triggers `stopTaskSession` → SIGHUP → exit code 129. The exit handler logged this as a `warn`-level "auto-restart skipped" message even though the skip was intentional. Changed `shouldAutoRestart` to return a discriminated union with a `reason` field (`suppressed` | `no_listeners` | `rate_limited`) so the caller can log intentional suppression at `debug` instead of `warn`. Added `displaySummary` to session exit and auto-restart skip log lines for easier task identification.

## [0.9.0] — 2026-04-15

### Fix: resolved conflicts reappearing in auto-merged section during merge

- After resolving a conflict file, the next metadata poll re-classified it as "auto-merged" (it appeared in `git diff --cached` but was no longer in the unmerged set). This caused duplicates in the file list and permanently blocked the "Complete Merge" button — the file couldn't be "accepted" in the auto-merged section because the detail pane showed "File resolved" with no action button. Fixed by filtering `resolvedFiles` out of the effective auto-merged list in the UI.

### Diagnostic: idle session lifecycle logging

- Added 4 structured diagnostic events to trace why agent processes die and sessions drop to idle: `server.started`, `workspace.terminal_manager_created`, `session.autorestart_skipped` (warn), `session.recover_to_idle` (warn). All log to both the console logger (debug ring buffer / WebSocket) and the JSONL event log.
- `hydrateFromRecord` now marks `awaiting_review` sessions as `interrupted` (same as `running` sessions) during workspace bootstrap, feeding them into `resumeInterruptedSessions` on first viewer connect instead of dropping to idle via `recoverStaleSession`.
- Added convention to `event-log.ts`: every `emitEvent`/`emitSessionEvent` call should have a corresponding console log unless there's a specific reason to omit it.

### Feature: three-dot diff in compare view

- Added "Only branch changes" toggle to the compare bar (default on). When enabled, diffs show only changes the branch introduced since diverging from the base, excluding base-side changes — matching GitHub/GitLab PR diff behavior.
- Backend uses native `git diff A...B` syntax for ref-to-ref comparisons and `git merge-base` for ref-vs-working-tree. File content loading reads the old side from the merge-base instead of the raw fromRef.
- Toggle persists to localStorage independently of "Include uncommitted work".

### Refactor: unify default branch resolution

- Unified three independent "default branch" paths into a single `resolveDefaultBaseRef` function with priority chain: config pin → git detection → fallback.
- CLI task creation (`quarterdeck task create`) now respects the user's pinned `defaultBaseRef` config — previously only used git auto-detection.
- Frontend "(default)" label in the branch dropdown now follows the config pin instead of being hardwired to `"main"`.
- Home terminal `baseRef` resolution now respects the config pin.

### Docs: hooks directory refactoring plan

- Added `docs/refactor-hooks-directory.md` — three-phase plan for organizing the 78-file flat `web-ui/src/hooks/` directory. Phase 1: group into domain subdirectories (board, git, terminal, project, notifications). Phase 2: extract domain logic from hooks into pure TS modules (incremental, as-touched). Phase 3: conventions for `web-ui-conventions.md` to prevent re-bloating.

### Fix: card-detail-view test failures after GitContext extraction

- Added `GitContext.Provider` with a noop value to the test harness's `renderWithProviders` — the GitContext extraction (phase 8 step 4) added a `useGitContext()` call in `CardDetailView` but the test wrapper was never updated, breaking all 3 tests.

### Fix: title generation timeout noise

- Bumped title and branch-name generation timeouts from 3s to 5s — matches the summary generator and `callLlm` default fallback. 3s was too aggressive for Bedrock proxy round-trips.
- Timeout errors (`AbortError`) in `llm-client.ts` now log at `debug` level instead of `warn`. Actual failures (network errors, unexpected exceptions) remain at `warn`.

### Fix: remove arrow key task cycling

- Removed the `useHotkeys` bindings that cycled task selection on up/down/left/right arrow keys. The original fix (suppressing inside `.xterm`) was too narrow — focus could land on the terminal panel wrapper, toolbar, or other elements outside the `.xterm` DOM, causing arrow keys to unexpectedly switch the selected task. Removed the feature entirely: `isTypingTarget` helper, `handleSelectAdjacentCard` callback, both hotkey bindings, and the `react-hotkeys-hook` import from `card-detail-view.tsx`. 5007e1de

### Refactor: complete provider shapes and AppProviders compositor — phase 8 step 5

- Created `TerminalContext` (`web-ui/src/providers/terminal-provider.tsx`) — context shape for terminal panel state (`useTerminalPanels` result), connection readiness (`useTerminalConnectionReady`), and derived metadata (home/detail terminal summaries, subtitles, visibility flag).
- Created `InteractionsContext` (`web-ui/src/providers/interactions-provider.tsx`) — context shape for board interactions (`useBoardInteractions` result: drag/drop, trash workflow, task lifecycle) and task start actions (`useTaskStartActions` result).
- Created `AppProviders` compositor (`web-ui/src/providers/app-providers.tsx`) — composes all 6 context providers in dependency order (Project → Board → Terminal → Git → Interactions → Dialog). App.tsx return statement simplified from 4 inline `.Provider` wrappers to a single `<AppProviders>` component.
- All 6 provider shapes now exist; remaining phase 8 work is migrating state/hooks from App.tsx into each provider component.

### Refactor: extract GitContext provider from App.tsx — phase 8 step 4

- Introduced `GitContext` (`web-ui/src/providers/git-provider.tsx`) — owns all git-related state: git actions (`runGitAction`, `switchHomeBranch`, loading/error state), git history toggle, git navigation (`pendingCompareNavigation`, `pendingFileNavigation`, `navigateToFile`, `navigateToGitView`), home file browser scope context, and the derived `gitSyncTaskScope`.
- `CardDetailView` now reads git navigation, git history, conflict detection, and pull/push callbacks from `useGitContext()` instead of props — removes 12 props (`isGitHistoryOpen`, `onToggleGitHistory`, `pendingCompareNavigation`, `onCompareNavigationConsumed`, `onOpenGitCompare`, `pendingFileNavigation`, `onFileNavigationConsumed`, `navigateToFile`, `onConflictDetected`, `onPullBranch`, `onPushBranch`).
- Context value constructed in App.tsx via `useMemo`, provider wraps inside `BoardContext.Provider`. Hooks remain in App.tsx — only their return values are exposed via context.

### Feat: state backup system with periodic snapshots

- Added automatic state backup system that snapshots critical files (`config.json`, `workspaces/index.json`, per-workspace `board.json`, `sessions.json`, `meta.json`, `pinned-branches.json`) to `~/.quarterdeck-backups/` — a sibling directory that survives a wipe of `~/.quarterdeck/`.
- Backups are created automatically on server startup and periodically (default every 30 minutes, configurable via `backupIntervalMinutes`). Periodic backups use mtime+size fingerprinting to skip no-op snapshots when nothing has changed.
- CLI commands: `quarterdeck backup create` (manual snapshot), `quarterdeck backup list` (show available backups), `quarterdeck backup restore [name]` (restore from a backup). Automatic pruning retains the 10 most recent backups.
- Backup location overridable via `QUARTERDECK_BACKUP_HOME` environment variable.

### Refactor: C#-style readability — phase 3 (shared service interfaces, message factories, dispatch map)

- Created 5 shared service interfaces in `src/core/service-interfaces.ts` (`IRuntimeBroadcaster`, `ITerminalManagerProvider`, `IWorkspaceResolver`, `IRuntimeConfigProvider`, `IWorkspaceDataProvider`) — replaces 4 bespoke `Create*Dependencies` bags that each re-declared the same function signatures. `RuntimeStateHub` extends `IRuntimeBroadcaster`; `WorkspaceRegistry` extends the 4 workspace interfaces. API consumers accept nested `{ config, broadcaster, terminals, workspaces, data }` objects instead of flat function plucking.
- Extracted 11 message factory functions into `src/server/runtime-state-messages.ts` — all 14 inline `satisfies` object constructions in `RuntimeStateHub` replaced with one-liner factory calls.
- Created typed WebSocket dispatch map (`web-ui/src/runtime/runtime-stream-dispatch.ts`) — compiler-enforced handler map keyed by message type replaces the 110-line if/else chain in `use-runtime-state-stream.ts`. Adding a new message type causes a compile error until a handler is added.
- Simplified `runtime-server.ts` wiring from 42 individually plucked functions to passing service objects directly. Removed redundant `ensureTerminalManagerForWorkspace` from server deps (available via `workspaceRegistry`).
- Split `RuntimeApiImpl` handler methods into 11 individual files under `src/trpc/handlers/` — `RuntimeApiImpl` is now a ~90-line thin dispatcher that delegates to standalone handler functions, each with explicit dependency interfaces. Completes section 5 of the readability roadmap.

### Fix: terminal scroll flash when switching to stale tasks

- Switching to a task whose terminal slot was evicted from the pool caused the entire chat history to visibly scroll past as xterm rendered the restore snapshot. mount() now defers visibility when restoreCompleted is false — the terminal stays hidden until the snapshot is fully written and scrolled to bottom, then appears instantly.
- Socket error/close handlers call ensureVisible() as a safety net so the terminal never stays permanently hidden if the restore message never arrives.
- Warmup timeout no longer fires while the card is still hovered — the 3s grace period now starts on mouseLeave instead of mouseEnter, so hovering for >3s before clicking still gets a warm slot.
- Sidebar task cards now trigger terminal warmup on hover, matching the main board cards (was missing onTerminalWarmup/onTerminalCancelWarmup passthrough from CardActionsContext).
- Eliminated DOM reparent on task switch via pre-mount architecture: all 4 pool slots are staged in a shared container via `attachPoolContainer()`/`attachToStageContainer()` when the terminal panel mounts. `mount()` replaced with `show()` (visibility toggle + `terminal.refresh()` insurance), `unmount()` replaced with `hide()` (visibility toggle). No `repairRendererCanvas` or SIGWINCH on normal task switch.
- Added `document.visibilitychange` listener per slot — repaints the visible terminal when the browser tab returns to foreground (handles GPU texture eviction during backgrounding).
- `requestResize` guard loosened to `visibleContainer ?? stageContainer` so warmup can send correct dimensions to the server before the slot is shown.
- Pool rotation stages replacement slots into the container if one is registered.
- `show()` now calls `scrollToBottom()` after `fitAddon.fit()` when the terminal is already restored, so switching tasks snaps to the latest output instead of showing a stale scroll position. Reveal deferred until after fit+scroll to prevent a visible frame at the old position. A one-shot `pendingScrollToBottom` flag re-scrolls after the first ResizeObserver-driven reflow.
- Post-restore resize guard widened to `visibleContainer ?? stageContainer` so warmup sends correct browser dimensions to the server immediately after restore — eliminates dimension mismatch that caused intermittent TUI layout gaps.

### Fix: remove unauthenticated `resetAllState` endpoint

- Removed the `runtime.resetAllState` tRPC endpoint, which recursively deleted `~/.quarterdeck` and `~/.quarterdeck/worktrees` with no authentication — any process on localhost could call it. Also removed the "Reset all state" button and confirmation dialog from the debug tools UI, the `prepareForStateReset` server callback, the frontend `resetRuntimeDebugState` helper, and all associated types, schemas, and tests.

### Refactor: C#-style readability — phase 1 & 2 (named types, IDisposable, class conversions)

- Installed `neverthrow` (typed `Result<T,E>`) and `mitt` (typed event emitter) for incremental adoption — no callsite changes yet, packages available for phase 3+.
- Replaced `ReturnType<typeof>` gymnastics with named types across 11 sites in 9 files — `ResolvedAgentCommand`, `RuntimeConfigState`, `PreparedAgentLaunch`, `RuntimeWorkspaceStateResponse`, `ReconciliationTimer` (new), `RuntimeTrpcClient` (new), `RuntimeServerHandle` (new), `CardSelection`, and direct types for `UseRuntimeStateStreamResult` fields.
- Created `src/core/disposable.ts` — `IDisposable` interface, `toDisposable()`, `DisposableStore`, and `Disposable` base class (~70 lines). Equivalent to VS Code's lifecycle primitives.
- Converted `RuntimeStateHub` from 550-line factory-closure to `RuntimeStateHubImpl` class extending `Disposable` — 7 closure Maps/Sets become private readonly fields, 130-line inline WebSocket handler becomes `handleConnection()` pipeline, metadata monitor and debug log subscription managed via `_register()`.
- Converted `RuntimeApi` from 615-line factory-closure to `RuntimeApiImpl` class — handler methods organized by section (Config, Sessions, Shell, Debug, Migration), `createRuntimeApi()` wrapper preserved for backward compatibility.

### Refactor: begin App.tsx context provider extraction — DialogContext, ProjectContext, BoardContext

- Introduced `DialogContext` (`web-ui/src/providers/dialog-provider.tsx`) — the first step of the App.tsx provider split described in `docs/refactor-csharp-readability.md` section 8. Defines a typed context for all dialog open/close state, debug tools, and debug logging.
- Extracted `DebugShelf` component (`web-ui/src/components/debug-shelf.tsx`) — renders the DebugLogPanel and DebugDialog by reading from `useDialogContext()` instead of receiving 25+ props from App.tsx. Removes ~30 lines of inline JSX from App.tsx.
- Introduced `ProjectContext` (`web-ui/src/providers/project-provider.tsx`) — the second provider in the extraction. Surfaces project navigation, runtime config (both current and settings scope), startup onboarding, access gate, and all config-derived values + mutation callbacks.
- Extracted `ProjectDialogs` component (`web-ui/src/components/project-dialogs.tsx`) — renders StartupOnboardingDialog and GitInitDialog by reading from `useProjectContext()`.
- Introduced `BoardContext` (`web-ui/src/providers/board-provider.tsx`) — owns board data, task sessions, and task selection state (`board`, `setBoard`, `sessions`, `upsertSession`, `selectedTaskId`, `selectedCard`, `setSelectedTaskId`). `CardDetailView` now reads `board`, `taskSessions`, and `upsertSession` from context instead of props, removing 3 of its 55 props.
- All three contexts are constructed in App.tsx via `useMemo` and provided inline. Hooks stay in App.tsx — child components opt into context reads incrementally.

### Perf: replace per-task xterm instances with fixed 4-slot terminal pool

- Terminals are no longer created and destroyed per task. A pool of 4 pre-allocated `TerminalSlot` instances is reused across tasks via `connectToTask`/`disconnectFromTask`. Only the currently viewed task (ACTIVE) and the previously viewed task (PREVIOUS) keep live WebSocket connections — all other slots are free for warmup or rotation.
- Hovering a task card pre-connects a pool slot (PRELOADING → READY), so clicking it shows the terminal near-instantly instead of waiting for WebSocket handshake + restore.
- Scrollback reduced from 10,000 to 3,000 lines on both client and server mirrors — sufficient for agent sessions and significantly lighter with 4 concurrent terminals.
- Server-side (`ws-server.ts`): output chunks are no longer buffered for viewers whose IO socket is intentionally disconnected, preventing unbounded memory growth during long sessions.
- Dedicated terminals (home shell, dev shells) remain outside the pool with their own lifecycle.
- Proactive slot rotation every 3 minutes replaces the oldest idle slot to prevent xterm canvas/WebGL resource staleness in long sessions.
- Project switch cleanup properly releases all pool slots and disposes all dedicated terminals.
- Task switch no longer triggers a redundant server restore round-trip — the existing buffer is already current. Canvas repair (dimension bounce + texture rebuild) now completes while hidden, eliminating visible flicker.
- Session restart detection added to the pool path — stale scrollback from a previous session is cleared when `sessionStartedAt` changes.
- Deleted compatibility shims (`warmupPersistentTerminal`/`cancelWarmupPersistentTerminal`) and dead `deferredResizeRaf` code.

### Fix: simplify notification settings — merge completion into review

- Removed the separate "Completion" notification event. Successful agent exits now use the "Review" sound and setting, since both mean "task needs your attention." The notification settings grid drops from 4 rows to 3 (Permission, Review, Failure).
- Renamed the confusing "Other projects only" column header to "Mute focused project" for clarity.
- Updated the Review event description from "Task is ready for review" to "Task finished or needs attention" to reflect its broader scope.

### Fix: un-trash no longer flashes error state during reconnect

- Un-trashing a card no longer shows a red "Error" status pill while the session reconnects. The race was between `startTaskSession` (async spawn in-flight) and `recoverStaleSession` (triggered by the terminal WebSocket connecting before the spawn completes). A `pendingSessionStart` flag on `ProcessEntry` now guards both `recoverStaleSession` and the reconciliation sweep from clobbering the session state during the async gap.

### Feature: inline scrollable diffs with last-viewed persistence

- The compare, uncommitted, and last turn tabs in the git view now show all file diffs inline in a single scrollable list — no need to click individual files on the left to load their diffs. Diffs load progressively with per-file loading skeletons that fill in as each file's content arrives.
- The file tree panel becomes a jump-to navigator: clicking a file scrolls to its diff section, and the tree highlight follows the scroll position.
- Switching away from a git view tab and back restores the last-viewed file position instead of resetting to the top. Persistence is scoped per task and per tab, stored in localStorage.
- Scroll-sync ping-pong (where scrolling in the compare view snapped the file selection back to the first file) is eliminated by removing the single-file fetch chain that caused the re-render cycle.

### Feature: commit sidebar improvements — stash relocated, generate-message button

- Stash and Discard All buttons moved above the commit message textarea, visually separating "save/discard work" actions from "commit" actions. Stash is now immediately accessible without scrolling past the message input.
- Added a Sparkles (generate) button in the top-right corner of the commit message textarea. Sends the selected files' diff to the LLM pipeline (same Haiku model used for title and summary generation) and populates the textarea with the result. The message is fully editable before committing. Gracefully falls back when LLM is not configured — button shows a warning toast instead of failing silently.
- New backend: `generateCommitMessage` tRPC mutation, `commit-message-generator.ts` generator module, `getDiffText` workspace API helper.

### Docs: C#-style readability refactoring roadmap

- Added `docs/refactor-csharp-readability.md` — an 8-section plan to make the TypeScript codebase navigable like a well-structured C# solution. Covers typed errors (`neverthrow`), typed events (`mitt`), VS Code's IDisposable lifecycle pattern, factory-closure to class conversions, shared service interfaces, message factory functions, and App.tsx provider extraction.
- Replaced todo #18 (App.tsx investigation) with the broader roadmap that subsumes it.

### Feature: per-event scoped notification beeps

- Each notification event type (permission, review, failure, completion) can independently be configured to only beep for tasks in other projects, suppressing sounds for the currently viewed project. The settings dialog notifications section now displays events in a two-column grid with "Enabled" and "Other projects only" columns per event type.
- Settings dialog widened from 600px to 960px to accommodate the grid layout.
- The per-event suppress check runs at sound-fire time (after the settle window), so switching projects during the window uses the correct project context.

### Feature: log level setting replaces boolean debug toggle

- The runtime debug logger now uses a four-level threshold (`debug`, `info`, `warn`, `error`) instead of an on/off boolean. Default is `warn` — only warnings and errors are captured. Setting `info` captures informational messages like orphan cleanup without the full debug firehose.
- The log level is persisted in `config.json` as `logLevel` and applied at startup.
- The debug log panel (Cmd+Shift+D) is now a pure viewer — opening/closing it no longer toggles server-side logging. A "capture:" dropdown in the panel header changes the runtime log level. A "show:" label clarifies the filter bar is for local display filtering only.
- The `setDebugLogging` boolean tRPC endpoint is replaced by `setLogLevel` which accepts a level string.

### Fix: arrow key task navigation suppressed when terminal is focused

- Arrow keys (up/down/left/right) no longer navigate between tasks when an xterm.js terminal has focus. The `isTypingTarget` guard in `CardDetailView` now checks `closest(".xterm")` in addition to INPUT/TEXTAREA/contentEditable, so keystrokes inside terminals go to the terminal instead of cycling the selected card.

### Fix: trash confirmation dialog always shown

- The trash button on task cards now always shows a confirmation dialog before trashing, regardless of whether the task has uncommitted changes. Previously the dialog was only shown when the workspace snapshot reported changed files — tasks with no changes, or whose snapshot hadn't loaded yet, were trashed immediately without asking. The dialog adapts its message: tasks with uncommitted changes get the full warning about worktree deletion and patch capture; clean tasks get a simpler "are you sure?" prompt.

### Fix: branch name click in dropdown opens context menu instead of closing

- Left-clicking a branch row in the top bar branch dropdown now opens the context menu (checkout, compare, merge, copy, etc.) instead of immediately navigating to that branch's file view and closing the dropdown. The old file-browsing action is available as "Browse files" — the first item in the context menu. The `disableContextMenu` codepath (file browser dropdown) retains the original direct-select behavior.

### Fix: git conflict tests fail on CI due to default branch name

- Test helpers (`git init`) didn't specify a branch name, so runners with `init.defaultBranch=master` failed on `checkout main`. Added `-b main` to `git init` in all test `initRepository` functions and the shared `initGitRepository` helper.

### Fix: permission badge clobbered by terminal focus event

- Selecting a "Waiting for Approval" card no longer clears the permission badge. xterm.js focus reporting (`DECSET 1004`) sends `\x1b[I` when the terminal panel gains focus — `writeInput` was treating this protocol response as user interaction and clearing `latestHookActivity`. Added `isTerminalProtocolResponse()` to filter focus-in/out and DSR cursor position reports from the permission-clearing path.

### Refactor: file browser uses filesystem listing for on-disk repos

- The file browser tree now lists files via `fs.readdir` instead of `git ls-files` when viewing on-disk repos (home and task worktrees). Shows everything actually on disk rather than a git-filtered view. Branch browsing (refs not checked out) still uses `git ls-tree`. No new dependencies.

### Docs: comprehensive performance audit

- Rewrote `docs/performance-bottleneck-analysis.md` with a full audit covering all subsystems — state persistence, WebSocket broadcasting, frontend memory, terminal/PTY backpressure, tRPC/API polling, git operations, and React rendering. Documents what shipped since the previous 2026-04-07 audit (lazy diff loading, scoped metadata refresh, terminal backpressure redesign, chat message removal) and identifies remaining medium-severity items (undebounced state broadcasts, uncached workspace snapshots, global project broadcasts, metadata polling cost).

### Fix: remove drag-and-drop from sidebar task column

- Sidebar task cards are no longer draggable — the `DragDropContext`, `Droppable`, and `Draggable` wrappers are removed from the column context panel. Cards are still clickable, hoverable, and support all existing actions (start, trash, pin, edit, etc.). Main board drag-and-drop is unaffected.

### Fix: base ref dropdown not resetting to user's default on dialog open

- The create task dialog now resets the base ref dropdown to the user's default (pinned or auto-detected) each time it opens, instead of retaining whatever branch was used for the previous task.
- Removed the misleading "(default)" label from git-detected branches in the dropdown — it was independent of the user's pinned default and couldn't be overridden, causing confusion when both were visible. The pin icon is the authoritative default indicator.
- Added todo #19 and `docs/refactor-default-branch.md` documenting the three independent default-branch systems and a plan to unify them.

### Refactor: file browser branch dropdown cleanup

- Disabled right-click context menus on the file browser's branch dropdown (`BranchSelectorPopover`) via a new `disableContextMenu` prop — the top bar dropdown retains context menus. Renamed local App.tsx aliases from ambiguous `home*` prefix (`homeBranchActions`, `homeResolvedScope`, etc.) to `fileBrowser*` to clarify they're scoped to the file browser, not the top bar.

### Feature: editable worktree system prompt

- The hardcoded worktree context prompt appended to Claude agent sessions via `--append-system-prompt` is now a user-editable template stored in global config (`worktreeSystemPromptTemplate`). Supports `{{cwd}}`, `{{workspace_path}}`, and `{{detached_head_note}}` placeholders resolved at launch time. A collapsible editor in Settings > Agent lets users customize the prompt and reset to the built-in default. Only applies to worktree sessions — non-worktree behavior is unchanged.

### Docs: todo roadmap updates

- Replaced the Go backend rewrite todo with a standalone desktop app (Electron/Tauri) todo — browser-tab limitations (duplicate connections, no window management, no OS integration) are the bigger pain point.

> Prior entries (0.8.0 and earlier) in `docs/changelog-through-0.8.0.md` and `docs/changelog-through-0.5.0.md`.
