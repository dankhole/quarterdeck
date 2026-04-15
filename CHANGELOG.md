# Changelog

## [Unreleased]

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
