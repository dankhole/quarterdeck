# Changelog

## [Unreleased]

### Docs: trim active refactor docs

- Moved the remaining active architecture-refactor pickup context into `docs/todo.md` and archived stale editor-lite and roadmap handoff docs out of the active docs map.

### Feature: edit files from the Files view

- Files view now opens worktree files in editable CodeMirror tabs with dirty indicators, save/reload/discard flows, word wrap, markdown preview, and branch/ref browsing kept read-only.
- Files view now supports creating files/folders, renaming or moving files/folders, and deleting files/folders behind an explicit confirmation in live worktree scopes.
- Runtime file saves now use a full-content hash check plus locked atomic writes, rejecting binary, oversized, skipped-path, escaped, or concurrently changed files instead of overwriting agent or external-editor edits.
- File editor saves now preserve edits typed while a save is in flight, keep tabs isolated per file-browser scope, preserve CRLF line endings and executable permissions on edited scripts, and open files over 5 MB read-only with an explicit edit-limit message.
- File editor autosave is now optional, defaults off, and supports delayed saves or save-on-focus-change using the same conflict-aware save path as manual saves.
- Files view now has toolbar access to active-file find/replace, save all, close all, dirty unload protection, and scope-aware Cmd+P/Cmd+Shift+F search across home, task worktree, and read-only ref browsing.
- Editor dirty-unload protection now survives leaving the Files view, focus autosave no longer saves while discard prompts are active, and global file search keeps the active home/task/ref scope outside the Files surface.
- In-app file saves and file/folder mutations now refresh git metadata and quick-open caches promptly instead of waiting for normal polling.
- File tab close, close-all, and reload controls now wait for in-flight saves to finish so discard/reload actions cannot race a write that is still completing.
- File editor autosave now lives in Settings, the normal Files view omits the duplicate scope bar, and CodeMirror search/selection styling is higher contrast.

### Fix: reduce background file polling

- Home and task detail views now load and poll file-tree/content data only while the Files surface is active, avoiding hidden 5-second file-list refreshes from Terminal, Git, and board-focused views while keeping global file search scoped correctly.

### Fix: improve generated commit messages

- Commit-message generation now sends task context, the complete selected-file list, and a larger bounded diff/content context, including untracked file excerpts when available.
- Untracked commit-message excerpts now use bounded, binary-aware reads and omit symlink contents instead of following them into the prompt.
- Commit-message generation no longer falls back to mechanical local text when the helper LLM is unavailable or fails; the commit panel now surfaces a failure toast instead.

### Fix: improve commit sidebar resizing

- Moved commit controls resizing from the commit-message textarea corner to a draggable top divider with bounded, persisted heights.

### Chore: continue terminal lifecycle cleanup

- Moved task/shell lifecycle orchestration out of `TerminalSessionManager` into a dedicated lifecycle controller, keeping the manager focused on registry, listener, IO, transition, and reconciliation wiring.

### Chore: tighten project provider ownership

- Project-level browser state now exposes separate navigation, runtime-stream/debug, sync/persistence, and notification contexts, so app/providers no longer consume one broad `ProjectContext` bag.
- App-level project notification, sync, and persistence side effects now live behind focused hooks instead of widening the app shell side-effect boundary.

### Chore: unify branch/base-ref state

- Inferred, pinned, and unresolved task base refs now share one runtime/web UI model with detached-worktree display, so top-bar base-ref pills, branch-change sync, task-start guards, and detached hints interpret task branch state consistently.

### Fix: remove stale keyboard shortcuts

- Removed the `Cmd+G` / `Ctrl+G` git view toggle and `Cmd+M` / `Ctrl+M` terminal expand hotkeys, plus their sidebar reminders, while keeping explicit UI controls intact.
- Pruned sidebar-only reminders for start-and-open task and Escape close/back without changing those behaviors, and now show the remaining sidebar shortcuts without a collapsed "All shortcuts" section.

## [0.12.2] — 2026-04-29

### Docs: version bump to 0.12.2

- Bumped root package metadata to 0.12.2 and promoted the current release notes for release prep.

### Feature: choose task harness at creation

- Task creation now includes an agent harness selector, persists the chosen harness on each task, and starts fresh sessions with that task-owned harness instead of requiring a global Settings change.
- Task cards now show the harness in their metadata row, replacing transient last-tool activity text so mixed-agent boards stay scannable without crowding the card header.
- Settings no longer exposes the task-agent picker; it keeps agent launch tuning such as Claude row multiplier and the worktree context prompt.
- Settings now leads with PATH-based harness detection guidance, moves debug-log access near the top, and uses harness terminology for task-runner UI copy.

### Fix: refresh Windows compatibility audit

- Windows agent availability probes now launch command shims through `ComSpec`, matching task PTY launch behavior for `.cmd` and `.bat` agent wrappers.
- Quarterdeck worktree detection now normalizes separators and casing before rejecting managed worktrees as projects, and `npm run dev:full` uses `npm.cmd` on Windows.
- Dev/e2e wrapper scripts now avoid registering or forwarding `SIGHUP` on Windows.
- Startup/shutdown orphan cleanup now discovers Windows agent processes with missing parents, including known agent CLIs hosted by `node.exe` or `cmd.exe` shims, and terminates matching process trees instead of skipping Windows entirely.
- Added a Windows support audit doc with the current compatibility boundary and replaced the broad todo with concrete Windows follow-ups.

### Fix: improve source viewer word wrap

- File source word wrap now prefers normal word boundaries, uses the full content column, and re-measures wrapped rows after panel resize so Markdown prose no longer wraps too early or breaks awkwardly inside words.

### Docs: refresh README

- Reworked the root README around the current source install flow with `npm run link`, optional environment variables, the active agent/worktree workflow, and GitHub/Bitbucket-friendly Markdown.

### Fix: harden runtime request and launch defaults

- Runtime HTTP and WebSocket entry points now reject unexpected Host/Origin headers while preserving local runtime, Vite dev, and e2e proxy flows.
- Codex task launches now disable Codex startup update checks unless the user explicitly overrides that Codex config.
- Fallback task ID generation no longer mixes timestamp-derived entropy into short task IDs when UUID generation is unavailable.

### Fix: make lightweight LLM helpers reliable

- Lightweight title, branch-name, summary, and commit-message generation now use a provider-neutral OpenAI-compatible helper client configured by `QUARTERDECK_LLM_BASE_URL`, `QUARTERDECK_LLM_API_KEY`, and `QUARTERDECK_LLM_MODEL`.
- Title and display-summary context now prioritizes the original prompt, first agent summary, and latest agent summaries instead of sending broad chronological transcripts.
- Title and commit-message generation now fall back to deterministic local text when the helper LLM is unavailable, times out, or returns unusable content.
- Title and summary normalization now drops trailing transcript echo fragments such as `Human:` / `Assistant:` instead of showing them on task cards.
- Card summaries now use compact agent conversation text immediately, and optional LLM summary polish runs from task lifecycle changes instead of board-card hover.

### Docs: track editor-lite backlog

- Added an active todo for an editor-lite review/editing surface, including Monaco, CodeMirror 6, and Eclipse Theia as implementation options.

### Chore: ignore local tool state

- Ignored generated Husky install shims and local Codex config/session spillover while preserving the checked-in Codex environment bootstrap that symlinks worktree dependencies.

## [0.12.1] — 2026-04-29

### Docs: version bump to 0.12.1

- Bumped root package metadata to 0.12.1 and promoted the current release notes for release prep.

### Fix: aggregate project metadata visibility per browser client

- Project metadata polling now treats a project as visible when any connected browser tab reports it visible, so a hidden tab can no longer back off git metadata refreshes for another visible tab on the same project.

### Fix: prioritize diff content loading

- Git diff tabs now load the selected file and visible diff sections first, while any offscreen diff prefetch is capped and cancelable so large change sets no longer make all file diffs foreground work.

### Chore: close session launch path migration

- Runtime task session summaries now use only `sessionLaunchPath` for launch identity; the temporary legacy `projectPath` read fallback has been removed from the shared schema, and persisted old `sessions.json` records are rewritten through the state loader.

### Fix: dedupe shared-checkout metadata polling

- Project metadata refreshes now load checkout-level git state once per physical task path and then project task metadata from that shared result, avoiding duplicate probes for active shared-checkout tasks while preserving task-specific base-ref projections.

### Chore: extract Pi lifecycle extension source

- Moved the Quarterdeck Pi lifecycle extension into a standalone runtime JavaScript asset and copied it into packaged builds while preserving the launch-scoped hook bridge behavior.

### Chore: separate orphan maintenance boundaries

- Session reconciliation now owns only task session/process drift, while a project orphan-maintenance sweep owns periodic stale git lock cleanup.
- Documented the cleanup taxonomy for session drift, process artifacts, filesystem locks, orphan worktrees, and dangling state references.

### Fix: clarify detached task worktrees

- Detached task worktrees now show subtle "detached from {baseRef}" context and tooltips in task cards, task branch/status bars, and branch dropdowns so matching HEAD hashes read as independent task copies.

### Fix: refresh sidebar shortcut tips

- Removed the obsolete plan/act toggle shortcut from the sidebar tips and corrected the start-and-open task shortcut to match the active task-create hotkey.

### Fix: align small checkbox rows

- Small task creation, compare, and confirmation checkboxes now align more cleanly with their labels and keep the check icon centered.

### Chore: simplify settings agent launch controls

- Settings now groups task-agent selection, Claude row tuning, and the worktree context prompt together so agent launch behavior is easier to scan.
- Removed the parent `.git` and `~/.quarterdeck` agent access toggles from settings/config; Quarterdeck no longer passes those extra `--add-dir` directories to Claude task sessions, and stale config keys are dropped on the next save.

### Fix: reduce compare diff refresh churn

- Compare and diff views now preserve unchanged enriched file entries across background refreshes and only replace file diff content when a fetched diff actually changes, reducing scroll interruptions while sync updates arrive.

### Feature: restore Open in IDE

- The top bar now has an Open button before project script shortcuts, using the current project path or the selected task's assigned worktree path.
- Added Rider as an open target alongside the existing editor and system targets.
- Open target commands now use the runtime host platform and stay disabled for isolated tasks until their worktree exists.

### Fix: improve file browser source selection

- File browser source panes now use a selectable full-file text layer over the virtualized syntax view, so code selection and native copy no longer depend on only the mounted rows.
- Added a copy-file-contents toolbar action and file-scoped `Cmd+A` / `Ctrl+A` behavior for the current source pane.

### Docs: prune stale branch-status todo

- Removed the stale UI branch/status desync backlog item after validating that task git UI now derives branch and change state from assigned task metadata rather than session launch path.

### Fix: mark unresolved task base refs

- Task branch changes that cannot infer a new base now clear the card base ref, prompt users to select one, and suppress base-derived actions until a base is chosen.

### Fix: keep debug log controls responsive

- Debug log capture-level changes now update optimistically in the panel, avoid reseeding the recent log buffer on every level broadcast, and render log rows through virtualization so the control remains usable during log floods.

### Fix: batch live terminal writes

- Live task terminal output now batches same-kind xterm writes per frame while preserving output acknowledgements and notification text, reducing browser main-thread churn during high-volume agent output.
- Restore snapshots, terminal resets, and local status messages still flush pending live output first and then write immediately, preserving terminal ordering around reconnect and restore paths.

### Fix: make terminal re-sync easier to reach

- Task terminal view top bars and shell terminal headers now expose visible re-sync controls that request a fresh server snapshot for the current terminal without opening Settings.
- Top bars now show only the project/worktree directory name while keeping the full path available on hover, avoiding noisy hidden worktree paths in task views.
- Settings no longer includes the old all-terminal re-sync button now that each terminal surface exposes its own contextual re-sync control.

### Chore: split terminal pool ownership

- `terminal-pool.ts` now composes pooled task-slot ownership from separate hidden-stream timer policy, DOM/debug diagnostics, and cross-terminal helper modules while preserving existing terminal behavior and compatibility exports.
- Shared pooled-slot bookkeeping now lives in `terminal-pool-state.ts`, keeping slot arrays, roles, role timestamps, and task-to-slot indexes out of the side-effecting pool facade.

### Fix: settle task terminal reveal after restore

- Task terminals now wait for pending xterm writes, resize, and bottom-scroll passes before clearing restore readiness or fallback readiness, preventing Claude sessions from becoming visible before the restored output has settled at the bottom.

### Fix: honor shared-checkout repository state

- Shared-checkout tasks now resolve branch, diff, compare, and metadata refresh state from the project checkout instead of stale isolated worktree assumptions.

### Fix: separate Codex prompt arguments

- Codex task prompts that begin with `-` now launch and resume correctly because Quarterdeck terminates Codex option parsing before passing the prompt positional.

### Fix: lower default Claude terminal rows

- New installs now default the Claude row multiplier to 2, reducing hidden terminal buffer height while still giving Claude extra scrollback room.

### Chore: refresh web e2e smoke tests

- Playwright web smoke tests now launch an isolated Quarterdeck runtime with disposable state, so e2e runs no longer depend on or mutate a developer's active runtime.
- Updated the smoke coverage for the current onboarding, task creation, backlog inline editing, board column, and settings-dialog flows.

### Chore: remove synchronous git helper export

- Removed the obsolete `runGitSync` workdir helper/export so future runtime code cannot accidentally reintroduce synchronous git subprocesses through the shared API.

## [0.12.0] — 2026-04-29

### Docs: version bump to 0.12.0

- Archived the 0.11.0 changelog into `docs/history/changelog-through-0.11.0.md`, rotated the implementation log through 0.12.0, and bumped root package metadata to 0.12.0 for release prep.

### Chore: mark Pi support experimental in settings

- Settings now labels Pi as experimental and warns that Pi support is unstable, so users see the risk before selecting it as a task agent.

### Fix: avoid runtime stalls from sync child processes

- Directory picking now launches OS folder-picker commands asynchronously, so an open picker dialog no longer blocks websockets, terminal streams, polling, or unrelated tRPC requests.
- Codex availability checks now use async version/feature probes with in-flight deduping, TTL caching, stale-while-revalidate responses for cached display/task-start results, and fresh validation when saving a selected agent.
- Project stream resolution now validates indexed git repositories through async probes with bounded parallelism, and startup orphan-agent cleanup now runs async `ps` discovery after yielding the boot path.
- Shutdown orphan-agent cleanup now awaits async discovery before graceful shutdown resolves, so Ctrl+C does not exit before orphan processes are signaled.
- Added focused coverage for async picker behavior, Codex probe cache/dedupe/stale refresh, bounded project-index validation, and async orphan cleanup.

### Fix: keep agent hooks off blocking transcript work

- Claude Stop hooks now transition tasks through the normal reliable ingest path before transcript parsing, then enrich conversation summaries from the server in the background.
- Claude transcript parsing now scans a bounded JSONL tail instead of loading the whole transcript file to find the last useful assistant message.
- Activity-only Claude and Codex tool/maintenance hooks now use best-effort `hooks notify` delivery with no retry, while `to_review`, `to_in_progress`, and Codex `SessionStart` session metadata keep the reliable retrying ingest path.

### Chore: remove sidebar pinning

- Removed the sidebar toolbar pin toggle, its surface-navigation state, and the persisted `quarterdeck.sidebar-pinned` preference.
- Files/Git now always collapse non-Commit side panels, and selecting a task from Home always opens the Board side panel.

### Fix: show remote refs in base branch picker

- The task top-bar base-ref dropdown now groups pinned local, local, and remote refs, so refs such as `origin/main` can be selected directly.
- The base-ref picker now uses ref-oriented loading, filter, and empty-state copy and preserves the selected remote ref name instead of aliasing it to a local branch.

### Fix: parallelize runtime file and stream loading

- Runtime WebSocket snapshots now load the project list, selected project state, and notification baseline concurrently while still reporting selected-project state load errors separately.
- Workdir diff content now reads old/new sides concurrently, search file indexing filters deleted tracked files more defensively, and file browser listing uses bounded filesystem traversal that skips VCS/dependency directories without hiding other ignored local files.
- Added focused runtime coverage for snapshot concurrency, file listing behavior, and file diff content loading.

### Chore: remove read-only startup task flow

- Removed the task-level read-only startup flag from board cards, browser task editing, runtime start-session requests, and agent launch adapters.
- Dropped the obsolete inline task toggle, local storage key, deferred Codex startup command path, and CLI man-page option.
- Updated fixtures and coverage to use the standard task start flow everywhere.

### Fix: reduce browser main-thread work

- Replaced the shared tRPC hook's unconditional `JSON.stringify` response comparison with opt-in lightweight endpoint equality for polled changes, file lists, and git refs.
- Git file and diff viewers now highlight rendered lines through a per-line Prism cache instead of pre-highlighting whole files or full old/new diff text, with very long lines falling back to plain text.
- Added focused coverage for query revision equality, syntax highlighting cache behavior, and unified diff rendering without whole-file highlighting.

### Chore: remove reviewed-task auto-trash

- Removed the task-level “Auto-trash when reviewed” setting, its persisted board fields, local storage defaults, review-column timer hook, cancel affordances, and CLI/man-page option references.
- Kept normal manual trash behavior intact, including confirmation dialogs, worktree cleanup, and patch capture for uncommitted work.

### Feature: send worktree context to Codex agents

- Worktree-launched Codex task sessions now receive the configured worktree context prompt as Codex `developer_instructions`, giving Codex the same repo/task guidance path that Claude already received through its system-prompt context.
- Codex launch args now preserve explicit per-launch `developer_instructions` overrides, and the settings reminder now describes the Claude and Codex delivery paths.
- Added focused adapter coverage for injected Codex worktree context and explicit override handling.

### Fix: checkout remote branch refs from branch picker

- Branch checkout now accepts explicit remote refs such as `origin/feature`, so top-bar and file-scope branch pickers can create or switch to the matching local tracking branch.
- Added runtime coverage for remote-only refs, existing local branches selected through their remote ref, and linked worktree checkouts.

### Fix: start Codex with measured task terminal width

- Task sessions now wait briefly for the browser terminal to report real geometry before spawning the agent PTY, preventing Codex from hard-wrapping its first output at a stale half-width estimate.
- Cached terminal geometry now gets a short settle window so pending resize-observer updates can land before startup, while detached/background starts fall back to a wider capped estimate.
- Added focused coverage for geometry resolution, startup deferral until geometry is available, and the detached fallback sizing path.

### Fix: add form field identifiers

- Added stable `name` attributes to unlabeled web UI inputs, textareas, and selects so browser autofill, diagnostics, and accessibility tooling can identify fields consistently.
- Covered task creation mocks with matching field names and left existing interactive behavior unchanged.

### Chore: remove frontend perf-investigation logging

- Removed the remaining browser-side `[perf-investigation]` console probes from terminal writes, restore application, and session-instance reconnects now that hidden terminal streams are bounded.
- Deleted the diagnostic-only terminal write/socket/pool-role plumbing that only fed those probes, while keeping the sampled `[quarterdeck-debug]` reconnect trace for targeted lifecycle debugging.
- Routed leftover trash/trash-warning debug breadcrumbs through Quarterdeck's client logger instead of raw `console.debug` / `console.error` calls.

### Fix: keep .NET build outputs local to task worktrees

- Worktree ignored-path mirroring now skips mutable build-output directories named `bin`, `obj`, and `TestResults`, avoiding symlinks back into the parent checkout for .NET build/test artifacts.
- Added integration coverage that keeps those build outputs absent from the task worktree while preserving normal ignored dependency mirroring.
- Added a follow-up todo to move ignored-path mirroring toward an explicit allowlist with per-project opt-ins.

### Fix: avoid blocking project git context probes

- Project request routing, hook ingest, and project-add path resolution now use a lightweight project scope lookup when they only need project identity/path data, avoiding branch-list git probes on hot request paths.
- Repository branch context detection now runs asynchronously with in-flight deduping and a short cache, with explicit invalidation after git mutations and metadata polling refreshes.
- Added integration coverage for cached repository git info and the new scope-only project lookup path.

### Fix: avoid tsx force-killing dev shutdown

- `npm run dev` now runs the runtime through a small Node supervisor that forwards one shutdown signal to `tsx watch`, waits for Quarterdeck cleanup, and only force-kills after a timeout.
- `npm run dev:full` now uses the same managed shutdown path for both runtime and web UI processes, avoiding duplicate wrapper signals while still cleaning up both children when either exits.

### Fix: bound hidden terminal stream lifetimes

- Terminal prewarm slots now have a 12-second absolute TTL from warmup start, so hover-created `PRELOADING` / `READY` slots cannot stay connected indefinitely when `cancelWarmup()` never arrives.
- PREVIOUS task terminals now auto-evict after 8 seconds, and promoting an already-retained slot back to `ACTIVE` demotes any other active slot first so hidden streams keep the same bounded lifecycle.
- Mouseleave cancellation still uses the existing 3-second grace eviction, and acquiring, releasing, evicting, or clearing the pool cancels the relevant delayed timers.
- Temporary terminal write diagnostics captured slot, task, pool role, visibility, socket state, readiness, and restore state while any remaining hidden writer was still being identified from browser console output.
- Added focused terminal-pool lifecycle/acquire coverage for max-TTL eviction, previous-slot eviction, existing-slot promotion, cancel-warmup eviction, acquisition cleanup, and `releaseAll()` timer cleanup.

### Fix: keep timed-out Codex hooks from pinning cancellation

- Hook CLI timeouts now abort the underlying tRPC HTTP request instead of only racing the promise, so a timed-out `PostToolUse` ingest cannot keep a hook subprocess alive and leave Codex stuck on "Running ... hooks" during cancellation.
- Added focused coverage for aborting pending hook work when the timeout fires.

### Fix: harden git metadata polling and command isolation

- Git metadata polling now uses fixed, less aggressive intervals with visibility-aware focused-task polling, hidden-tab backoff, and no user-facing settings for poll cadence.
- Metadata refresh, remote fetch, and project-state broadcast paths now avoid blocking snapshots on git probes, with per-project and global concurrency limits to isolate slow repositories.
- Git commands now use explicit timeout classes for metadata, remote fetches, inspection reads, checkpoints, and user actions, and start-time turn checkpoints no longer block task-session startup.

### Fix: stop PTY output from driving session-summary churn

- Task and shell PTY output no longer updates `lastOutputAt` on every chunk, so idle terminal redraws do not emit full runtime session summaries or fan out through browser session, notification, and project-summary state.
- Removed the stalled-session reconciliation producer that moved quiet running sessions into `awaiting_review` with reason `stalled`; legacy stalled summaries remain readable so older local state can recover normally.
- Successful hook CLI ingests no longer write `[hooks:cli] parsed` diagnostics to stderr on every hook; retry/failure diagnostics still surface when the hook cannot reliably reach runtime logging.
- Added a follow-up todo to reintroduce stalled/unresponsive detection through a cheaper signal that does not wake the runtime/browser fanout path for terminal output noise.

### Fix: reconcile stale project notification indicators

- Runtime task-notification streams now filter summaries through board-linked task IDs and send tombstones for removed notification tasks, so deleted-card sessions do not keep project needs-input/review/failure indicators alive.
- Browser notification memory now replaces project buckets from authoritative snapshots and project-state updates, while live deltas still merge monotonically unless a tombstone removes a task.
- Added focused stream-store, dispatch, and integration coverage for notification bucket replacement, tombstone propagation, and board-linked notification seeding.

### Fix: expose degraded terminal DOM diagnostics

- Xterm helper textareas now receive stable `id` and `name` attributes when terminals open, making orphaned helpers easier to identify in degraded browser sessions.
- Added `window.__quarterdeckDumpTerminalState()` so terminal pool, dedicated terminal, helper textarea, xterm DOM, and parking-root state can be dumped from DevTools without opening the debug panel.
- Terminal pool teardown now disposes browser terminal instances during Vite hot reload, and a minute-based DOM health monitor warns through the raw browser console when terminal DOM counts exceed the expected ceiling.

### Chore: add perf-investigation instrumentation

- Added temporary `[perf-investigation]` probes around PTY input/output, terminal mirror application, runtime summary fanout, hook ingest, notification snapshot seeding, terminal reconnects, write queues, and restore guards so idle-scrollbar CPU churn can be isolated across the likely hot paths.
- The investigation logs use direct console output where practical instead of Quarterdeck's tagged runtime logger, avoiding feedback through the debug-log WebSocket stream while the runtime is degraded.
- Each probe is marked with `[perf-investigation]` comments so the temporary diagnostics can be removed cleanly after the investigation.

### Fix: prune orphan session summaries from project state

- Project-state snapshots and cross-project notification baselines now omit stale non-live session summaries whose cards are no longer on the board, reducing old task history in stream payloads.
- Browser board saves now persist only board-linked task summaries to `sessions.json`, so deleted tasks and ephemeral shell terminals stop accumulating in project state.
- Shutdown cleanup now applies the same board-linked persistence filter when marking sessions interrupted, preventing home/detail shell summaries from surviving a restart through the sessions-only writer.
- Runtime startup now applies the board-linked persistence filter before terminal-manager hydration, backs up the old `sessions.json`, and rewrites the file so stale summaries do not re-enter memory after a restart.

### Fix: explain why title regeneration failed

- Title regeneration now produces a descriptive warning/error trail at every layer when the "Could not regenerate title" toast fires, instead of swallowing the failure silently.
- The browser handler now logs mutation throws with full error context and also warns (and shows the toast) when the server returns `ok: false`, pointing readers at the matching `title-gen` / `llm-client` runtime logs.
- The runtime title generator distinguishes the common unconfigured-LLM case up front and labels the post-call null path so the preceding `llm-client` warning is easy to correlate with the user-visible failure.
- The LLM client now logs distinct causes for each failure mode: rate limiter hits include current usage versus configured limits, HTTP non-2xx responses capture status/statusText/body snippet/model, empty-content and sanitizer rejections include model context, and timeouts are tagged separately from network/parse errors with the configured `timeoutMs`.

### Fix: keep shutdown cleanup from overwriting board state

- Shutdown cleanup now writes only runtime session state when marking active tasks interrupted, leaving browser-owned `board.json` and its revision untouched.
- This preserves in-progress and review card placement across server restarts even when shutdown races a recent browser board save or works from an older disk snapshot.
- Added focused state/shutdown coverage to lock in the sessions-only persistence contract and prevent shutdown from bumping board revisions.

### Fix: seed cross-project notification state on stream connect

- Runtime stream snapshots now include a notification-summary baseline for every managed project, so reconnecting or reloading the browser preserves already-waiting cross-project needs-input state instead of relying only on future live deltas.
- The browser notification store seeds its existing project-owned notification buckets from that snapshot while keeping `task_notification` as the live update channel, preserving current-project mute and sound-transition semantics.
- Added regression coverage for cross-project stream seeding plus Codex-specific audible notification suppression so `PermissionRequest` stays a permission sound and Codex completion remains a review event.

### Fix: suppress closed-PTY async write noise

- PTY sessions now suppress expected async `EIO` / `EBADF` write-queue races from node-pty when a child PTY closes after input has already been accepted, while preserving `EAGAIN` retries and keeping unexpected write failures visible.
- Added focused coverage for the node-pty async write-queue path so the shutdown-noise guard stays narrower than the existing synchronous write/resize protections.

### Fix: harden Codex native hook dogfooding

- Codex availability now requires `0.124.0` or newer, matching the release where `codex_hooks` became stable and gained the tool coverage Quarterdeck relies on.
- Codex feature probing now rejects disabled `codex_hooks` rows and emits structured debug logs for version/feature probes, launch-scoped hook config, hook ingest rejections, transitions, broadcast failures, and checkpoint failures.
- Codex `SessionStart` hooks now record metadata without moving tasks back to running, avoiding false resumes after slash-command/compact session maintenance.
- Codex prompt redraws no longer drive `agent.prompt-ready` state transitions, so review cards do not move to running from Enter or TUI repaint noise.
- Codex `PostToolUse` now uses one transition hook because the transition ingest path already persists the same hook metadata, cutting one hook subprocess/tRPC round trip per tool completion.
- Documented the known Codex subagent `Stop` limitation in the task-state guide and active todo list, and removed the stale branch-review handoff document that described older native-hook iterations.

### Fix: keep normal interrupted auto-restart skips out of warning logs

- Auto-restart skip classification now checks the pre-exit session state before listener count, so expected `interrupted` / review cleanup exits report `not_running` and stay at debug level even when no browser listener is attached.
- `no_listeners` remains warning-level for a task that was actually `running` when it exited, preserving signal for skipped crash recovery.

### Fix: skip shell stop RPC when home terminal was never opened

- `closeHomeTerminal` no longer falls back to `currentProjectId` when the home-shell project ref is null. The ref is only populated by paths that actually start the shell, so a null ref unambiguously means "never opened" and there is nothing to stop.
- Eliminates the debug warning `[terminal-panels] failed to stop shell terminal { reason: "close", error: "Could not stop terminal session." }` that fired on every project-switch reset because the UI was asking the runtime to stop a session that never existed.

### Docs: consolidate architecture and convention references

- Merged the ranked architecture weaknesses and refactor-roadmap context into `docs/architecture-roadmap.md`, with `docs/todo.md` remaining the active execution queue.
- Moved reusable methodology docs under `docs/conventions/`, including architecture guardrails and UI layout conventions, and removed the stale UI component cheatsheet.
- Updated `AGENTS.md` with an area-specific documentation lookup cheat sheet so agents read convention docs only when working in the matching code area.

### Fix: repair invalid session entries during project load

- Project loads now drop invalid `sessions.json` entries individually, preserve the original file as `sessions.json.corrupt-*`, and immediately write a repaired `sessions.json` containing the surviving sessions so the project does not remain half-corrupt until the next board save.
- Runtime-state WebSocket startup now sends the project list even when the selected project's full state cannot load, then reports the project-state error separately instead of leaving the browser with no visible projects.
- Repair warnings are retained long enough for the browser snapshot to see them even when startup terminal-manager hydration repairs the file first, and the web UI no longer immediately retries `project.getState` after a partial snapshot with no project state.

### Fix: stop shell terminal sessions on close

- Home and task shell terminals now treat close/context switch as a real shell-session boundary: the browser disposes the dedicated terminal view and asks the runtime to stop the backing PTY instead of keeping hidden shells alive.
- Project shortcuts now reuse an already-open home/task shell without calling `startShellSession` again, avoiding the visible terminal reboot when running a shortcut in an open shell.
- Shell session exits now use the shared terminal finalizer, so `stopTaskSession({ waitForExit: true })` resolves on shell exits instead of waiting for the timeout fallback.

### Feature: Pi CLI agent harness support

- Pi is now a launch-supported `pi` agent type detected from Quarterdeck's inherited PATH, eligible for auto-selection after Claude Code and Codex, and guarded by a `0.70.2` minimum version check.
- Removed the checked-in Pi source tree and its build, sync, link, and egress-audit scripts so Quarterdeck works with the user's installed Pi CLI instead of maintaining a bundled copy.
- The Quarterdeck-owned Pi lifecycle extension still loads launch-scoped with `--extension`, mapping Pi session ids, follow-up input, agent start/end, tool activity, and model-initiated `bash` permission prompts into the shared hook/session flow while leaving user extension discovery enabled.
- Pi state-changing lifecycle hooks are serialized and awaited with a timeout so permission resolution and turn start/end events cannot overtake one another; high-volume tool update events now only refresh cached input metadata instead of spawning hook processes.
- Startup/shutdown orphan-process cleanup now recognizes `pi` processes alongside `claude` and `codex`.

### Fix: log full toast warning/error messages to the debug log

- Error and warning toasts now log their full, untruncated message through the existing tagged-logger system, so the debug log panel (and browser console) retains the complete text even when the toast itself truncates at 150 chars.
- Centralized the logging inside `showAppToast` / `notifyError` rather than adding per-call-site log calls, so all ~80 danger/warning toasts are covered by one edit. Two direct-sonner toast violations were migrated onto `showAppToast` so they get logged too.
- Server-side WebSocket error payloads sent to clients (e.g. `Invalid sessions.json file at …` from `parsePersistedStateFile`) are now logged on the runtime side with a `runtime-state-hub` tag, so the full schema-validation detail is recoverable from runtime logs instead of disappearing with the toast.

### Fix: stabilize Codex untrash and resume terminal races

- Task session exit handling now verifies that the exiting PTY is still the active PTY for that task before mutating summary state or clearing the active process entry.
- This prevents delayed Codex/wrapper exits from tearing down a newly spawned resume session and leaving the restored task with an empty terminal/spinner.
- Codex resume without a stored `resumeSessionId` now surfaces a session warning toast, because falling back to `codex resume --last` is explicitly best-effort.
- Explicitly stopped resumed sessions no longer run the resume-failure fallback that starts a fresh non-resume Codex process, preserving the stored `resumeSessionId` for the real trash-restore resume.
- Startup resume keeps the clean-exit fallback path for resumed agents, so a `codex resume`/`--continue` process that exits 0 can still reopen an interactive review session when it was not explicitly stopped.
- Startup resume no longer replaces a non-zero `codex resume` failure with a fresh blank prompt; it preserves the failed resume output and surfaces a warning instead.
- A failed `codex resume <stored-id>` now invalidates that stored id, stops reconnect recovery from retrying the same broken target, and makes the next explicit restart fall back to the most recent Codex session with a warning toast/log.
- Startup resume now logs its scan result and warns when it cannot select or launch resumable work-column sessions, so restart failures are visible without raising the global log level to debug.
- Startup resume now treats persisted `awaiting_review` / `attention` sessions with a stale pid as resumable after an unclean server stop, while still preserving completed `hook` / `exit` review sessions.
- Task terminals now fall back to an interactive visible terminal when the IO socket is open but the restore handshake stalls, including reused pooled slots and delayed IO-open cases, so a delayed restore cannot keep input blocked behind the loading spinner.
- Pooled task terminals now reconnect their IO/control sockets when the task session instance changes, avoiding stale control sockets that stay stuck waiting for initial restore completion after Codex trash-restore.
- Pooled task terminals skip that reconnect for processless stop summaries, reducing the extra flash before untrash starts the real replacement process.
- Restore recovery no longer issues speculative extra restores after live output is available, and empty restore snapshots are ignored after queued terminal writes drain when the visible terminal already has content, preventing Codex untrash from flashing output and then blanking the terminal.
- Untrash/resume diagnostics now follow the logger-level conventions: normal breadcrumbs are debug-level tagged logs, degradation paths stay warn-level, and temporary raw Codex subprocess stderr traces were removed from the visible agent terminal stream.
- Terminal restore now emits warning-level diagnostics when the restore handshake remains pending for 10 seconds, when IO/control sockets close mid-restore, or when snapshot application fails, making stuck agent-terminal spinners diagnosable without changing restore behavior.

### Chore: bump `postcss` to 8.5.10 in both packages

- Ran `npm audit fix` in the root and `web-ui` packages to pull `postcss` from 8.5.8 to 8.5.10, clearing the only open advisory (GHSA-qx2v-qp2m-jg93, moderate) across both lockfiles.
- `postcss` is a transitive dev/build dependency of the CSS toolchain and the advisory is only reachable when the stringifier processes untrusted CSS, which Quarterdeck does not do at runtime, but keeping the lockfiles clean makes future security reviews easier.
- Re-synced the root `package-lock.json` internal version field with `package.json` (0.10.0 -> 0.11.0) where it had drifted; no `package.json` edits required.

### Fix: harden native Codex hook integration

- Codex hook activity/permission matchers now use `*`, so Quarterdeck keeps seeing file-edit and future tool events instead of only Bash-class hooks.
- Quarterdeck now injects its Codex hooks inline on the `codex` command line instead of writing repo-local or user-global hook files, so only Quarterdeck-launched Codex sessions load the task-state hooks and standalone Codex app/GUI sessions stop seeing Quarterdeck hook failures.
- Settings and startup onboarding no longer have a separate Codex hook setup gate; Codex availability is back to the normal version-and-feature detection path, while Quarterdeck still forces `codex_hooks` on with `--enable codex_hooks` when it launches Codex.

### Fix: resume Codex sessions by stored session id

- Quarterdeck now persists the Codex root session id from `session_meta` events and reuses it on task restart, trash restore, and interrupted-session recovery, so Codex resumes target the original conversation instead of falling back to repo-global `codex resume --last`.
- Non-isolated task resumes still warn for agents without session-targeted resume, but Codex no longer shows that warning once a stored resume id is available.

### Fix: replay queued terminal restore requests during untrash resume

- Task terminals now queue `request_restore` calls that arrive before the initial restore handshake finishes, then replay them immediately after that first restore completes.
- This closes the remaining untrash race where Codex could publish a new resumed session while the first empty pre-spawn snapshot was still restoring, leaving the terminal stuck on a spinner with no logs because the refresh request was silently dropped.

### Fix: refresh terminal restore when untrash creates a new session instance

- Task terminals now request a fresh restore snapshot when the runtime reports a new `startedAt`/`pid` for the same task, covering untrash resumes that connected early enough to receive an empty pre-spawn snapshot.
- This keeps restored tasks from sitting on a loading spinner with no logs when the resumed Codex process appears after the first restore attempt.

### Fix: wait for trash-stop exit before untrash resume

- Restoring a trashed task now waits for any lingering task session shutdown to finish before asking the runtime to resume the conversation.
- This closes a trash/untrash race where `startTaskSession()` could see the still-active pre-trash session, skip spawning a new one, and leave the restored card stuck without a live agent once the old process finally exited.

### Refactor: switch Codex integration to native hooks

- Removed the legacy Codex wrapper/log-watcher/rollout-scraping path and now launch `codex` directly with Quarterdeck-generated native hook config, using `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` hooks for runtime state transitions.
- Persisted Codex `session_id` from hook payloads onto task session summaries so resume now prefers `codex resume <session_id>` instead of relying on `codex resume --last`.

### Fix: log and fail loud when untrash/restart races a still-exiting session

- `stopTaskSession(..., { waitForExit: true })` now waits up to 3 seconds (down from 5) before timing out and emits a warning log if the PTY still has not exited, instead of silently continuing.
- If a new start/resume arrives for the same task while the previous session is still exiting, the runtime now logs a warning and throws an explicit error instead of reusing the stale active summary; the board restore path surfaces that failure and moves the card back to trash instead of leaving the terminal spinner stuck with no logs.
- The tRPC start-task-session handler warns when `resumeConversation` is requested but no stored `resumeSessionId` is available, and the Codex adapter warns when it falls back to `codex resume --last`, so "agent came back up but with the wrong conversation" no longer disappears into silence.

### Fix: warn when Claude untrash resume lost the original worktree identity

- Start-task resume now emits an explicit warning log and session warning when Claude is asked to resume an isolated task after trash deleted its original worktree and cleared the persisted `workingDirectory`.
- This makes the startup-vs-untrash difference visible: server-start resume can reopen the old Claude chat when the original worktree still exists, but trash restore recreates a fresh worktree and `--continue` is only best-effort because Claude has no stored session-id resume path.

### Refactor: always show running-task stop/trash actions

- Removed the `showRunningTaskEmergencyActions` setting and its config/schema/settings wiring, so running task cards now always expose the stop/restart and trash escape hatches on hover instead of hiding them behind an opt-in toggle.

### Fix: harden Codex CLI detection with version gating

- Replaced the old "Codex binary exists on PATH" launch gate with a minimal compatibility check that still uses PATH for discovery but also runs `codex --version` and requires `0.124.0` or newer before Quarterdeck treats Codex as runnable.
- Added explicit agent install states (`installed`, `upgrade_required`, `missing`) to the runtime config contract so the settings dialog and startup onboarding can distinguish outdated Codex installs from genuinely missing CLIs.
- Updated the Codex install/help link to the official OpenAI Codex CLI quickstart and clarified in Settings that detection is PATH-based plus a Codex version floor.
- Tightened auto-selection so Quarterdeck no longer silently picks an outdated Codex binary as the default task agent.

### Refactor: remove session event log debugging path

- Removed the `eventLogEnabled` setting, deleted the JSONL session event logger and its startup/save plumbing, and stripped the task “flag for debug log” action plus tRPC handler so Quarterdeck no longer writes `~/.quarterdeck/logs/events.jsonl` or exposes that developer-only workflow.

### Refactor: remove task working-directory migration

- Removed the end-to-end "Move to main checkout" / "Isolate to worktree" feature: the runtime mutation, websocket delta, board sync hook, confirmation dialog, and board-card action are gone, so task working directories are now chosen at task creation/start time and no longer hot-swapped mid-session.

### Fix: clarify worktree system prompt is Claude Code only

- Updated settings UI copy from "the agent's system prompt" to "Claude Code's system prompt" — Codex has no equivalent injection, so the generic phrasing was misleading.

> Prior entries (0.11.0 and earlier) in `docs/history/changelog-through-0.11.0.md`.
