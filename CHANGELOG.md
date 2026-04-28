# Changelog

## [Unreleased]

### Fix: avoid tsx force-killing dev shutdown

- `npm run dev` now runs the runtime through a small Node supervisor that forwards one shutdown signal to `tsx watch`, waits for Quarterdeck cleanup, and only force-kills after a timeout.
- `npm run dev:full` now uses the same managed shutdown path for both runtime and web UI processes, avoiding duplicate wrapper signals while still cleaning up both children when either exits.

### Fix: bound hidden terminal stream lifetimes

- Terminal prewarm slots now have a 12-second absolute TTL from warmup start, so hover-created `PRELOADING` / `READY` slots cannot stay connected indefinitely when `cancelWarmup()` never arrives.
- PREVIOUS task terminals now auto-evict after 8 seconds, and promoting an already-retained slot back to `ACTIVE` demotes any other active slot first so hidden streams keep the same bounded lifecycle.
- Mouseleave cancellation still uses the existing 3-second grace eviction, and acquiring, releasing, evicting, or clearing the pool cancels the relevant delayed timers.
- Temporary terminal write diagnostics now include slot, task, pool role, visibility, socket state, readiness, and restore state so any remaining hidden writer can be identified from browser console output.
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

## [0.11.0] — 2026-04-22

### Fix: stabilize uncommitted changes view against needless poll re-renders

- `useTrpcQuery` now compares JSON-serialized responses before updating React state, so identical 1-second poll results no longer cascade new object references through the component tree.
- `activeFiles` memo in `use-git-view` depends on `.files` arrays instead of full response objects, preventing invalidation from `generatedAt` timestamp changes.
- `useAllFileDiffContent` early-exits when the file fingerprint is unchanged and selectively invalidates only changed files instead of clearing the entire diff cache — unchanged diffs stay in place without skeleton flash.

### Fix: detect sessions that stall before first hook arrives

- Widened `checkStalledSession` to catch running sessions that never receive their first hook — covers agent-level failures (API errors, cert issues, quota exhaustion) that happen before the hook system engages.
- Added a 60-second `UNRESPONSIVE_THRESHOLD_MS` fallback using `startedAt` when `lastHookAt` is null, so the card moves to review with a "Stalled" badge instead of staying stuck in "running" indefinitely.
- No new check function, action type, or reconciliation mechanism — same `mark_stalled` action and `reconciliation.stalled` state machine transition, broader detection condition.

### Refactor: deduplicate config and task/session test fixtures

- Replaced the hand-maintained runtime config save-payload fixture in `test/runtime/config/runtime-config-helpers.ts` with typed shared builders in `test/utilities/runtime-config-factory.ts`, so most config-shape changes now update one runtime helper instead of a copied 30+ field object.
- Expanded the runtime fixture helper to expose both `createDefaultMockConfig(...)` for resolved `RuntimeConfigState` and `createDefaultRuntimeConfigSaveRequest(...)` for persistence tests, with clone-safe nested defaults and ergonomic field overrides.
- Expanded `web-ui/src/test-utils/runtime-config-factory.ts` with clone-safe config-response builders plus focused helpers for selected-agent scenarios and audible-notification config slices, then moved notification/runtime onboarding tests onto those shared builders instead of local config-shaped wrappers.
- Added dedicated shared task/session fixture helpers in `test/utilities/task-session-factory.ts` and `web-ui/src/test-utils/task-session-factory.ts`, covering task session summaries, hook activity defaults, and web-ui project-state responses so runtime/session shape changes no longer require near-identical edits across terminal, project-sync, notification, websocket, and integration test files.
- Migrated the high-churn runtime and web-ui session tests onto those shared helpers, including terminal/session state machine coverage, runtime API and project API tests, runtime state stream and project sync tests, board-card and terminal panel tests, plus shutdown/project-state integration coverage.
- Clarified `latestHookActivity` override handling in the shared task-session factories so the default/null-vs-object behavior stays obvious while keeping per-test overrides ergonomic.
- Preserved test intent by keeping environment-specific defaults explicit where they matter, including the audible-notification harness’s “do not suppress current-project sounds by default” behavior, while still centralizing the boring config shape in one helper per test environment.

### Refactor: narrow terminal session lifecycle transition ownership

- Added `src/terminal/session-transition-controller.ts` as the terminal-layer owner for session state-machine side effects and active-listener summary fanout, so `TerminalSessionManager` no longer hides that lifecycle policy behind a private callback.
- Rewired task-session exit/restart recovery, reconciliation action application, interrupt recovery, and PTY input/output transition paths to call the shared controller, clarifying the boundary between session truth in `SessionSummaryStore`, process entry wiring in `TerminalSessionManager`, and transition-policy side effects.
- Added focused runtime coverage for the new controller boundary and reran targeted terminal lifecycle tests (`session-manager`, auto-restart, interrupt-recovery, reconciliation, and the new controller suite) plus `npm run typecheck`.

### Refactor: normalize session launch path vs assigned task identity

- Added `web-ui/src/utils/task-identity.ts`, a shared task-identity model that explicitly separates project root, assigned task path, assigned git identity, shared-vs-isolated assignment, and the session launch path used for divergence warnings.
- Renamed the shared runtime session-summary field from ambiguous `projectPath` semantics to explicit `sessionLaunchPath` in `src/core/api/task-session.ts`, and kept persisted-session compatibility by accepting legacy `projectPath` when reading older `sessions.json` records.
- Switched task-scoped branch/folder consumers (`board-card`, top-bar/navbar state, task-detail repository surfaces, card-detail branch pill logic, and git compare defaults) to use that shared vocabulary instead of ad hoc `workingDirectory` / `projectPath` / branch fallback chains.
- Preserved the useful “agent started somewhere unexpected” warning while tightening its meaning: the UI now treats `RuntimeTaskSessionSummary.sessionLaunchPath` as a session launch path, not as a true live cwd signal, and keeps that separate from assigned worktree identity.
- Updated runtime/frontend tests and helpers across session persistence, restart hydration, hooks checkpoint capture, shell-session summaries, board/task-detail identity display, and notification/session utilities; reran targeted `web-ui` tests, targeted runtime/integration tests, `npm run web:typecheck`, and `npm run typecheck`.

### Feature: agent terminal row multiplier

- Added “Agent row multiplier” setting (Settings > Terminal) that inflates the PTY row count reported to agent processes, so agents render more content per turn and produce denser scrollback. Default: 5×. Set to 1 if the agent UI looks broken.
- Shell terminals are unaffected — only task agent sessions apply the multiplier.

### Fix: React "Maximum update depth exceeded" crash on app load

- Stabilized `resetTaskEditorWorkflow` in `TaskEditorProvider` by depending on the stable `resetTaskEditorState` callback instead of the whole `taskEditor` object, which changed identity every render and caused an infinite loop through `useProjectSwitchCleanup` layout effects.
- Stabilized the inline `onWorkingDirectoryResolved` callback in `BoardProvider` with `useCallback` so `startTaskSession` (which depends on it) keeps a stable reference across renders.
- Added a regression test verifying `resetTaskEditorWorkflow` reference stability across re-renders.

### Refactor: share notification/indicator semantics across UI consumers

- Added `src/core/api/task-indicators.ts` as the shared semantic layer for approval-required, review-ready, needs-input, failure, completed, stalled, and interrupted indicator meaning, so Claude and Codex raw hook signals normalize into one runtime-contract model before UI consumers interpret them.
- Switched `web-ui/src/utils/session-status.ts`, `web-ui/src/hooks/notifications/audible-notifications.ts`, and `web-ui/src/hooks/notifications/project-notifications.ts` to consume that shared derivation instead of independently inspecting `reviewReason`, `hookEventName`, `notificationType`, or approval text.
- Updated backend permission cleanup to reuse the same shared `isPermissionActivity(...)` helper in `src/terminal/session-reconciliation.ts`, keeping permission semantics aligned across hook guards, stale-hook cleanup, status badges, project indicators, and audible notification selection.
- Preserved the prior green badge tone for `attention` / “Waiting for input” review state so the semantic refactor does not silently change a visible task-status color while still exposing `needsInput` semantics to downstream consumers.
- Added focused regression coverage for the new semantic layer plus the existing runtime/frontend notification and status consumers, including exit-code, interrupted, stalled, failed, running, and idle derivation cases, then reran targeted runtime tests, targeted `web-ui` notification/navigation tests, and both root/frontend typecheck.

### Refactor: tighten notification ownership around project-scoped projections

- Replaced the old flat notification session map plus task-to-project lookup with project-owned notification buckets in `web-ui/src/runtime/runtime-state-stream-store.ts`, keeping cross-project notification memory monotonic for stream/audio semantics while making project ownership explicit in the stored shape.
- Added `web-ui/src/hooks/notifications/project-notifications.ts` and moved project-level indicator derivation there, so navigation badges and current-vs-other project needs-input indicators now consume a narrow projection (`needsInputByProject`, current-project flag, other-project flag) instead of reconstructing ownership from broad global maps.
- Narrowed notification consumers to the ownership seam they actually need: `ProjectProvider` now exposes the derived project notification projection, `ProjectNavigationPanel` no longer owns notification aggregation logic, and `use-app-action-models.ts` now reads provider-owned needs-input flags for toolbar badges.
- Kept audible notification timing and suppression behavior intact while switching `use-audible-notifications.ts` to flatten project-owned notification buckets internally, so current-project suppression still works without relying on a separate task→project map.
- Added focused regression coverage for the new notification projection, runtime notification bucket pruning, navigation-panel ownership narrowing, and the existing audible notification suites, then reran targeted `web-ui` notification/navigation tests plus frontend and root typecheck.

### Refactor: narrow board provider ownership around task editing

- Added `web-ui/src/providers/task-editor-provider.tsx`, a dedicated task-editing seam that owns task create/edit state, branch-option derivation, and the edit-save-to-start bridge instead of exposing those workflows through `BoardContext`.
- Narrowed `web-ui/src/providers/board-provider.tsx` so it now reads as board/selection/session ownership: board state, selected-task state, runtime task-session actions, and board-loading flags stay there, while task-editor workflow moved to the new context.
- Updated the highest-surface consumers (`App.tsx`, `app-dialogs.tsx`, `dialog-provider.tsx`, `interactions-provider.tsx`, and `use-app-side-effects.ts`) to depend on the narrower task-editor seam they actually use rather than pulling mixed board-plus-editor state from `useBoardContext()`.
- Clarified project-switch cleanup at the seam boundary by replacing the board-owned `resetBoardUiState()` reach-through with a task-editor-owned `resetTaskEditorWorkflow()` reset path.
- Added focused regression coverage for the new provider seam and reran targeted frontend tests (`task-editor-provider`, `use-task-editor`, and `card-detail-view`) plus `web-ui` typecheck.

### Refactor: narrow task-detail layout/composition ownership

- Regrouped `CardDetailView` around owned task-detail sections (`layoutProps`, `sidePanelProps`, `repositoryProps`, and `terminalProps`) so the detail root coordinates the screen instead of acting like one broad dependency funnel.
- Added `TaskDetailRepositorySurface` plus grouped `useCardDetailView()` output so the git/files half of task detail now owns its own composition seam: scope bar, branch pill/actions, git history slot, file navigation, and branch-driven repository flows are wired together without being mixed into the terminal shell.
- Followed through on the remaining ownership seams by adding `TaskDetailSidePanelSurface` and `TaskDetailTerminalSurface`, so commit-vs-column side context and agent-terminal-plus-shell composition now live behind their own task-detail boundaries instead of staying inlined in the layout root.
- Kept branch dialogs and detail behavior intact while simplifying `TaskDetailMainContent` into a clearer layout router, then added focused regression coverage for the repository, side-panel, and terminal surfaces and reran targeted task-detail/layout tests, `web-ui` typecheck, and `web-ui` build.
- Tightened the follow-up contracts after review: the side panel now takes `navigateToFile` directly instead of importing a repository-state slice, `sessionSummary` now flows through an explicit shared detail prop instead of the terminal group, and `TaskDetailMainContent` now accepts only the specific layout/repository/terminal state it directly coordinates.

### Fix: stop leaving artifacts in the target repo

- Moved project config from `{repo}/.quarterdeck/config.json` to `~/.quarterdeck/projects/{projectId}/config.json` — Quarterdeck no longer creates or writes to any directory inside the user's repo (only `.git/` internal state remains, which is already untracked).
- Added one-time startup migration that moves existing project configs from the old repo-local path to the state home, then cleans up the empty `.quarterdeck/` directory.
- Removed the repo-local `.quarterdeck/` directory from Phase 2 lock cleanup targets.

### Fix: base ref selector popover transparency and pinned branch ordering

- Fixed the base ref branch selector popover in the top bar using a non-existent `bg-bg-secondary` background class, making the dropdown see-through after selection. Changed to `bg-surface-1` to match the main branch selector popover.
- Added pinned branch support to the base ref selector — branches pinned via the main branch popover now sort to the top of the base ref dropdown list.

### Refactor: separate surface navigation from git provider ownership

- Added `web-ui/src/providers/surface-navigation-provider.tsx`, a dedicated UI-surface seam that owns main-view/sidebar selection, git-history visibility, and cross-surface compare/file navigation instead of leaving those concerns inside `GitProvider`.
- Narrowed `web-ui/src/providers/git-provider.tsx` so it now reads as git-domain ownership: git actions, git history data, file-browser scope, and branch actions remain there, while toolbar/layout state moved out to the new surface-navigation context.
- Updated the highest-surface consumers (`App.tsx`, `home-view.tsx`, `connected-top-bar.tsx`, `use-card-detail-view.ts`, and interaction/app orchestration hooks) to depend on the clearer owned seam they actually use rather than pulling broad mixed-domain state from `GitContext`.
- Added `web-ui/src/providers/project-runtime-provider.tsx`, a second follow-up seam that moves runtime config, onboarding/access-gate state, config-derived values, and config mutation callbacks out of `ProjectContext`, leaving the base project provider focused on navigation, runtime stream state, and project sync/persistence ownership.
- Updated project-heavy consumers (`App.tsx`, dialog/project screens, board/git/terminal/interactions providers, and app orchestration hooks) to read project runtime/config concerns from `useProjectRuntimeContext()` instead of treating `ProjectContext` as a mixed-domain bag.
- Added focused regression coverage for the new provider seam and the affected detail-layout consumer path, then reran targeted frontend tests plus `web-ui` typecheck.
- Followed up on review with two small runtime-provider fixes: `handleSetDefaultBaseRef` now no-ops cleanly when no project is selected, and trash-worktree notice dismissal now reports failed config saves instead of failing silently.

### Refactor: make non-batched backend mutation effects explicit

- Added `src/trpc/runtime-mutation-effects.ts`, a narrow post-mutation effects layer that lets backend mutations declare concrete follow-up consequences such as project-state refreshes, project summary refreshes, task review signals, git metadata invalidation, lightweight task sync messages, and config/debug delivery effects without hand-assembling those calls inline.
- Moved the main project/task mutation family onto that pattern: board saves, task-title updates, git/staging/conflict mutations, project add/remove/reorder, hook-driven session transitions, task working-directory migration, metadata-driven base-ref sync, and log-level/poll-interval fanout now emit explicit effect sets instead of scattered follow-up broadcaster calls.
- Preserved the existing runtime stream contracts and board single-writer rule: board saves still fan out `project_state_updated` plus `projects_updated`, review hooks still emit `task_ready_for_review`, task migrations still send `task_working_directory_updated`, task/home git refreshes still flow through the metadata monitor rather than server-side board persistence, and config updates still reach the metadata/debug stream paths through the same runtime broadcaster.
- Added focused regression coverage for the new effect layer plus the migrated hook/runtime/config mutation paths, and revalidated targeted runtime/project streaming coverage with typecheck.

### Docs: consolidate refactor tracking docs

- Folded `optimization-shaped-architecture-followups.md` and `project-metadata-monitor-followups.md` into their parent docs (`refactor-roadmap-context.md` and `project-metadata-monitor-refactor-brief.md`).
- Expanded `refactor-roadmap-context.md` with status markers, recently completed list, and an extended backlog of 9 code-validated refactor targets.
- Restructured `todo.md` with active/historical separation and cross-links to roadmap context.
- Updated all cross-references in `docs/README.md`, `design-guardrails.md`, `design-weaknesses-roadmap.md`, and `terminal-ws-server-refactor-brief.md`.

> Prior entries (0.10.0 and earlier) in `docs/history/changelog-through-0.10.0.md` and `docs/history/changelog-through-0.9.4.md`.
