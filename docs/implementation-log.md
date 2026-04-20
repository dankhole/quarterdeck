# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Fix: base branch resolution bugs (2026-04-20)

**What:** Fixed three related issues with default base branch detection: `develop` auto-resolving over `main`, `detectGitDefaultBranch` reporting a non-existent local branch, and `defaultBaseRef` being global instead of per-project.

**Why:** In repos with both `main` and `develop`, `resolveBaseRefForBranch` always included `develop` in the candidate set and picked the closest ancestor by commit distance — which is typically `develop` for feature branches forked from it. This meant even when the user pinned `main` as their default, auto-resolution on branch changes could override it with `develop`. Separately, `detectGitDefaultBranch` trusted `origin/HEAD` without checking if the target existed as a local branch, so repos with only remote tracking refs could report `main` as the default even when no local `main` branch existed. Finally, `defaultBaseRef` was stored in the global config file, so setting it in one project would affect all projects.

**How:**
- Removed `"develop"` from the well-known candidate array in `resolveBaseRefForBranch`. Users who want develop-based resolution set `defaultBaseRef` in project config, which is still added to candidates.
- Added `branches.includes(normalized)` guard in `detectGitDefaultBranch` so `origin/HEAD` targets that don't exist locally fall through to the `main`/`master`/first-branch fallback.
- Moved `defaultBaseRef` out of `GLOBAL_CONFIG_FIELDS` (which writes to `~/.quarterdeck/config.json`) and into `RuntimeProjectConfigFileShape` (which writes to `<project>/.quarterdeck/config.json`). Updated `toRuntimeConfigState` to read from project config first with a global-config fallback for migration. Updated `writeRuntimeProjectConfigFile`, `applyConfigUpdates`, `saveRuntimeConfig`, `buildRuntimeConfigResponse`, `createRuntimeConfigStateFromValues`, `toGlobalRuntimeConfigState`, and `CONFIG_DEFAULTS` to route the field through the project-config path alongside `shortcuts`.

**Files touched:** `src/workdir/git-utils.ts`, `src/state/project-state-utils.ts`, `src/config/global-config-fields.ts`, `src/config/runtime-config-normalizers.ts`, `src/config/runtime-config-persistence.ts`, `src/config/runtime-config.ts`, `src/config/agent-registry.ts`, `src/config/config-defaults.ts`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Fix: "Mute focused project" plays sounds when tab/browser is unfocused (2026-04-20)

**What:** The "Mute focused project" per-event toggle now only suppresses sounds when the user is actually looking at the board. When the tab is hidden or the browser loses focus, per-project suppression is bypassed and sounds play normally.

**Why:** The suppression was unconditional — it checked whether the task belonged to the currently selected project, but didn't consider whether the user was actually viewing it. If a user switched to another app or tab, they'd miss notifications for the project they were working on, defeating the purpose of audible notifications.

**How:** Added an `isTabVisible()` early-return in `isEventSuppressedForProject()`. When the tab is hidden or unfocused, the function returns `false` (not suppressed) immediately, letting the sound play. Removed the redundant caller-side `isTabVisible()` guard in `fireSound` so visibility logic lives in one place. Updated the unit tests to mock tab visibility state (jsdom defaults to hidden/unfocused) and added a dedicated integration test verifying sounds play for a suppressed-project task when the tab is hidden.

**Files touched:** `web-ui/src/hooks/notifications/audible-notifications.ts`, `web-ui/src/hooks/notifications/audible-notifications.test.ts`, `web-ui/src/hooks/notifications/audible-notifications-suppress.test.tsx`, `web-ui/src/hooks/notifications/use-audible-notifications.ts`.

## Fix: base ref dropdown loads branches independently (2026-04-20)

**What:** Fixed the top bar base-ref dropdown opening empty and added loading state, stale-data clearing on project switch, and trigger button styling.

**Why:** `BaseRefLabel` consumed `git.topbarBranchActions.branches`, but only the `BranchSelectorPopover` (branch pill) called `setBranchPopoverOpen(true)` which enabled the `getGitRefs` query. Opening the base-ref dropdown without first opening the branch pill left the query disabled and the dropdown empty. Additionally, `useTrpcQuery` never cleared cached data when the query became disabled, so stale branches from a previous project persisted across switches. The trigger button also lacked background/padding, making it unreadable against the dark top bar.

**How:** Added an `isRefsRequested` flag to `useBranchActions` that stays true once any consumer requests branches. `wrappedSetBranchPopoverOpen` sets it on open (existing path), and a new `requestBranches()` callback sets it independently (new path for BaseRefLabel). The query's `enabled` check now uses `(isBranchPopoverOpen || isRefsRequested) && projectId !== null`, so either popover triggers and keeps the query hot. Exposed `isLoadingBranches` and `refetchBranches` from the hook. In `BaseRefLabel`, `handleOpen` calls `requestBranches()` on open, the dropdown shows a `<Spinner>` when `isLoadingBranches && !branches`, and the trigger button uses `cn()` with conditional `bg-surface-2` when open. In `useTrpcQuery`, the disabled-path effect now clears `data`, `isError`, and `error` (previously only cleared `isLoading`), preventing stale data from surviving across project switches.

**Files touched:** `web-ui/src/hooks/git/use-branch-actions.ts`, `web-ui/src/components/app/connected-top-bar.tsx`, `web-ui/src/runtime/use-trpc-query.ts`, `web-ui/src/components/task/card-detail-view.test.tsx`, `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Refactor: tighten project metadata monitor mutation ownership and freshness (2026-04-20)

**What:** Finished the remaining post-refactor `project-metadata-monitor` follow-up work by moving metadata application behind controller-owned commit semantics and making task metadata writes freshness-aware so stale full refreshes cannot overwrite newer targeted task refreshes.

**Why:** The previous split into controller/refresher/poller/fetch-policy made two remaining design problems easier to see: `ProjectMetadataRefresher` still mutated the shared `ProjectMetadataEntry` directly, and `refreshProject()` could snapshot task metadata, load results asynchronously, then replace the whole task metadata map after a focused/manual task refresh had already committed newer data for one task. That left the runtime depending on incidental “last async writer wins” behavior instead of an explicit freshness rule.

**How:** Kept the existing public monitor API and shared `p-limit(3)` probe concurrency cap, but changed the refresh boundary so `ProjectMetadataRefresher` reads project state through controller-supplied getters and commits results through controller-owned `commitHomeGit` / `commitTaskMetadata` callbacks instead of mutating `entry.homeGit` and `entry.taskMetadataByTaskId` itself. Narrowed `loadHomeGitMetadata()` so it takes `projectPath` plus the current cached home metadata, which let invalidation stay local to the refresh attempt instead of mutating shared state before the load. Added per-task freshness counters in `ProjectMetadataController`; targeted task refreshes capture the current task freshness and bump it when they successfully commit, while full refreshes capture each task's freshness at refresh start and only apply a loaded task result if that task's freshness is unchanged when the commit is attempted. `updateTrackedState()` now also bumps task freshness when a tracked task's `baseRef` or `workingDirectory` changes, so in-flight refreshes loaded against stale task identity do not overwrite newer task descriptors. Added a focused monitor regression test that forces `refreshProject()` and `requestTaskRefresh()` to interleave and proves the newer targeted task metadata survives when the stale full refresh resolves later. Re-ran the targeted monitor test suite, the runtime stream integration test that covers project metadata streaming behavior, `npm run typecheck`, and a changed-files Biome check.

**Files touched:** `src/server/project-metadata-controller.ts`, `src/server/project-metadata-refresher.ts`, `src/server/project-metadata-loaders.ts`, `test/runtime/server/project-metadata-monitor.test.ts`, `test/integration/state-streaming.integration.test.ts`, `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Refactor: clarify authoritative project sync vs cached board restore (2026-04-20)

**What:** Refactored `use-project-sync` and `project-board-cache` so there is one explicit authoritative project-state apply path, while cached board restore is handled as a clearly subordinate switch/display policy. Added regression coverage for cached restore confirmation and stale previous-project updates during a switch.

**Why:** The prior hook mixed together authoritative runtime project state, cache restore, hydration rules, request invalidation, and persistence gating tightly enough that the board cache was shaping the sync architecture instead of remaining an optional speedup. In particular, cache restore mutated the same revision/version tracking that authoritative updates use, which made it hard to audit when the UI was merely showing cached data versus when it had re-entered authoritative mode.

**How:** Updated `web-ui/src/runtime/project-board-cache.ts` to store `authoritativeRevision`, documenting that the cached board may include local UI changes while only the revision remains authoritative. Expanded `web-ui/src/hooks/project/project-sync.ts` with an explicit `resolveAuthoritativeBoardAction()` policy that distinguishes between hydrating from the server, confirming a matching cached board, and skipping a redundant re-hydration. Reworked `web-ui/src/hooks/project/use-project-sync.ts` to track an authoritative version separately from cached-restore state, keep `projectRevision` null while a cached board is displayed, reject old-project streamed updates after a switch reset targets a new project, and only re-enable persistence after authoritative project state arrives. Updated `web-ui/src/hooks/project/project-sync.test.ts`, `web-ui/src/hooks/project/use-project-sync.test.tsx`, and `web-ui/src/runtime/project-board-cache.test.ts`, removed the completed todo item from `docs/todo.md`, and added the changelog entry.

**Files touched:** `web-ui/src/hooks/project/use-project-sync.ts`, `web-ui/src/hooks/project/project-sync.ts`, `web-ui/src/hooks/project/use-project-sync.test.tsx`, `web-ui/src/hooks/project/project-sync.test.ts`, `web-ui/src/runtime/project-board-cache.ts`, `web-ui/src/runtime/project-board-cache.test.ts`, `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Fix: terminal scroll-to-bottom on task load/untrash (2026-04-20)

**What:** Fixed a race condition where the agent terminal would not scroll to the bottom when a task was first loaded, most noticeable on untrash.

**Why:** `scheduleRevealAfterLayout` uses a double-`requestAnimationFrame` to defer its final fit + reveal. Between the moment `pendingScrollToBottom` was armed (in `finalizeRestorePresentation` or `show()`) and the rAF callback, the ResizeObserver could fire — consuming the flag. When the rAF finally ran, it called `fit()` (potentially reshaping the terminal) but skipped `scrollToBottom()` because the flag was already cleared. The terminal then became visible at the wrong scroll position.

**How:** Made `scheduleRevealAfterLayout` unconditionally call `terminal.scrollToBottom()` before `domHost.reveal()`. This method is only invoked at “present content to the user” transitions (initial restore or task switch), so unconditional scroll is always correct. Removed the now-dead non-initial-fit `pendingScrollToBottom` block from `SlotResizeManager`'s ResizeObserver callback. The initial-fit fast-path remains for flicker prevention (it fires one frame earlier than the rAF reveal).

**Files touched:** `web-ui/src/terminal/terminal-viewport.ts`, `web-ui/src/terminal/slot-resize-manager.ts`.

## Docs: flesh out next-wave refactor roadmap context (2026-04-19)

**What:** Added a roadmap-context document for the current next 9 refactors and wired each one into `docs/todo.md` so the active queue is no longer split between a few detailed briefs and several high-level roadmap rankings.

**Why:** The repo had enough context to rank the next refactors, but not enough consistently written context for a fresh agent to pick up the broader design-roadmap items without reconstructing the story from chat, changelog history, or vague one-line todo entries. The goal here was not to create full implementation briefs for every item, but to give each queued refactor a stable home with primary files, current smell, desired outcome, first-slice guidance, and key risks.

**How:** Added `docs/refactor-roadmap-context.md` with sections for: project metadata monitor follow-ups, project sync plus board cache restore, runtime state message batcher, frontend runtime state stream store, split-brain task state, manual broadcast choreography/domain-event boundaries, app-shell integration gravity, broad provider/context surfaces, and the remaining workflow-heavy UI surfaces. Updated `docs/todo.md` so each of those items now links directly to either an existing detailed doc or the new roadmap-context sections. Updated `docs/README.md` so the new context doc appears in the refactor docs map, and added a short changelog entry for the planning/docs work.

**Files touched:** `docs/refactor-roadmap-context.md`, `docs/todo.md`, `docs/README.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Docs: capture project metadata monitor post-refactor follow-ups (2026-04-19)

**Commit:** `(uncommitted in worktree)`

**What:** Added a focused follow-up doc for the two remaining metadata-monitor architecture questions that came out of the refactor review: shared mutable `ProjectMetadataEntry` coupling and `refreshProject()` vs per-task refresh overwrite races.

**Why:** Those two issues are worth preserving as explicit follow-up work, but they are deeper ownership/concurrency design questions rather than immediate refactor bugs. Without a dedicated note, they are easy to lose now that the main refactor brief has been completed and removed from the active todo list.

**How:** Added `docs/project-metadata-monitor-followups.md` as a narrow post-refactor note rather than expanding the original refactor brief. The new doc explains the current shape of each issue, why it was not addressed in the refactor pass, healthy future directions, and acceptance criteria for a later pass. Linked it from `docs/README.md` and added a new optimization-shaped follow-up entry in `docs/todo.md` so the remaining work is discoverable from both the docs index and the active backlog.

**Files touched:** `docs/project-metadata-monitor-followups.md`, `docs/README.md`, `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Refactor: split project metadata monitor into controller / refresher / poller / fetch policy (2026-04-19)

**Commit:** `84de6043`

**What:** Refactored `src/server/project-metadata-monitor.ts` from a single module that owned metadata state, timers, task prioritization, remote fetch cadence, and in-flight guards into a thin registry over four focused backend pieces: `project-metadata-controller.ts`, `project-metadata-refresher.ts`, `project-metadata-poller.ts`, and `project-metadata-remote-fetch.ts`. Added monitor-specific regression coverage in `test/runtime/server/project-metadata-monitor.test.ts`.

**Why:** The previous monitor made it hard to reason about correctness without also reasoning about polling and fetch policy, and its module-scoped in-flight guards let one project's refresh block another project's refresh of the same kind. The refactor keeps the existing runtime stream contract and git metadata behavior while making ownership boundaries explicit and moving scheduling/freshness policy behind narrower seams.

**How:** Kept `ProjectMetadataMonitor`'s public API stable and preserved the shared `p-limit(3)` probe cap at the facade level. Moved per-project mutable state and subscriber lifecycle into `ProjectMetadataController`; moved home/task refresh logic, snapshot-change broadcasting, and task branch/base-ref detection into `ProjectMetadataRefresher`; moved cadence timers into `ProjectMetadataPoller`; and moved `git fetch --all --prune` cadence plus follow-up invalidation/refresh into `ProjectMetadataRemoteFetchPolicy`. Reworked manual `requestTaskRefresh()` to use the same per-task refresh path as focused/background refreshes, so non-focused tasks now share the same dedupe and branch-change handling. Added targeted tests for independent multi-project refreshes, focused-vs-background cadence, manual task refreshes, and remote-fetch follow-up refreshes, then verified the stream contract with the existing runtime state streaming integration test.

**Files touched:** `src/server/project-metadata-monitor.ts`, `src/server/project-metadata-controller.ts`, `src/server/project-metadata-refresher.ts`, `src/server/project-metadata-poller.ts`, `src/server/project-metadata-remote-fetch.ts`, `src/server/project-metadata-loaders.ts`, `test/runtime/server/project-metadata-monitor.test.ts`, `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Docs: add project metadata monitor refactor brief (2026-04-19)

**Commit:** `1c147a9e`

**What:** Added a dedicated design brief for refactoring `src/server/project-metadata-monitor.ts`, then linked it from the docs index, optimization follow-up tracker, and active todo item.

**Why:** The project metadata monitor had the same “optimization-shaped architecture” smell already documented for the terminal system, but it lacked a self-contained planning brief. That made the refactor direction clear in conversation and roadmap docs, but not mechanically discoverable for the next person picking up the work.

**How:** Added `docs/project-metadata-monitor-refactor-brief.md` in the same style as the existing terminal refactor brief. The new doc captures the current mental model, non-negotiable behaviors, gotchas, target architecture, rollout order, test expectations, and acceptance criteria. Updated `docs/README.md`, `docs/optimization-shaped-architecture-followups.md`, and `docs/todo.md` so the brief is discoverable from the existing planning surfaces. Added a short changelog entry describing the new planning artifact.

**Files touched:** `docs/project-metadata-monitor-refactor-brief.md`, `docs/README.md`, `docs/optimization-shaped-architecture-followups.md`, `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Fix: task switch and untrash terminal restore sizing follow-up (2026-04-19)

**Commit:** `6f1cf9f8`

**What:** Tightened the post-refactor task-terminal restore path so pooled agent terminals repair themselves correctly when reused from hidden warm states, and restored terminals wait to reveal until after a post-layout resize pass. This specifically updates pooled task-slot promotion in `terminal-pool.ts`, deferred reveal behavior in `terminal-viewport.ts`, and adds regression coverage in `terminal-pool-acquire.test.ts`.

**Why:** Two visible regressions remained after the architecture split. First, switching back to a task with a warmed `READY` / `PRELOADING` / `PREVIOUS` slot did not always repair stale hidden-slot geometry, even though the manual “Re-sync terminal content” action fixed it. Second, untrash/remount flows could reveal the terminal before layout had settled, producing a half-width first frame and imperfect bottom-scroll positioning.

**Changes:**
- `web-ui/src/terminal/terminal-pool.ts` — request a fresh restore snapshot whenever any non-`ACTIVE` pooled task slot is promoted back to `ACTIVE`, not just when reusing a `PREVIOUS` slot
- `web-ui/src/terminal/terminal-viewport.ts` — defer reveal for restored terminals until a scheduled post-layout resize pass, preserve bottom-scroll through that reveal, and cancel pending reveal frames on hide/park/dispose
- `web-ui/src/terminal/terminal-pool-acquire.test.ts` — added focused coverage proving restore-on-promotion for warmed and previous slots while leaving already-active reacquisition alone
- `CHANGELOG.md` — added unreleased note for the task-switch/untrash sizing follow-up

**Verification:** `npm --prefix web-ui run test -- src/terminal/terminal-pool-acquire.test.ts src/terminal/use-persistent-terminal-session.test.tsx src/terminal/terminal-pool-lifecycle.test.ts src/terminal/terminal-pool-dedicated.test.ts`; `npm --prefix web-ui run typecheck`; `npx @biomejs/biome check web-ui/src/terminal/terminal-viewport.ts web-ui/src/terminal/terminal-pool.ts web-ui/src/terminal/terminal-pool-acquire.test.ts`

## Refactor: terminal websocket bridge ownership / policy split (2026-04-19)

**Commit:** `f59a66c1`

**What:** Completed the backend websocket-bridge refactor described in `docs/terminal-ws-server-refactor-brief.md`. `src/terminal/ws-server.ts` is now a thin orchestrator over extracted collaborators for connection ownership, output fanout, restore coordination, backpressure policy, and protocol/state helpers.

**Why:** The old bridge mixed upgrade routing, viewer identity, PTY fanout, restore timing, buffering, backpressure, and cleanup in one file. That preserved good runtime behavior, but it made the primary mental model feel like “backpressure and restore timers” instead of “who owns which viewer connection to which task stream.” This refactor keeps the current UX and coordination semantics intact while making policy layers explicit.

**Details:**
- Added `src/terminal/terminal-ws-connection-registry.ts` to own task-stream records, viewer records, same-`clientId` socket replacement, listener/socket detach, and last-viewer cleanup.
- Added `src/terminal/terminal-ws-output-fanout.ts` to keep PTY output attachment task-scoped and distribute chunks to active viewers through the restore coordinator.
- Added `src/terminal/terminal-ws-restore-coordinator.ts` to own resize-before-restore sequencing, deferred initial snapshot timeout, `request_restore` / `restore_complete`, and per-viewer buffering while restore is incomplete.
- Added `src/terminal/terminal-ws-backpressure-policy.ts` to keep outbound batching, ACK accounting, websocket-buffer checks, and shared PTY pause/resume coordination out of the bridge shell.
- Added `src/terminal/terminal-ws-protocol.ts` and `src/terminal/terminal-ws-types.ts` so websocket parsing/sending helpers, connection context, and stream/viewer state shape are no longer embedded inline in `ws-server.ts`.
- Rewrote `src/terminal/ws-server.ts` as a smaller orchestrator that resolves managers, routes IO/control upgrades, delegates connection lifecycle to the registry, delegates restore/backpressure behavior to the extracted collaborators, and preserves `recoverStaleSession(taskId)` on both IO and control connect.
- Expanded `test/runtime/terminal/ws-server.test.ts` with coverage for initial restore-after-resize, timeout fallback restore, restore-gap output buffering, no buffering while IO is absent, same-`clientId` IO/control replacement, last-backpressured-viewer disconnect resume, and invalid control payload isolation.

**Files touched:** `src/terminal/ws-server.ts`, `src/terminal/terminal-ws-backpressure-policy.ts`, `src/terminal/terminal-ws-connection-registry.ts`, `src/terminal/terminal-ws-output-fanout.ts`, `src/terminal/terminal-ws-protocol.ts`, `src/terminal/terminal-ws-restore-coordinator.ts`, `src/terminal/terminal-ws-types.ts`, `test/runtime/terminal/ws-server.test.ts`, `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Docs: add terminal websocket bridge refactor brief (2026-04-19)

**What:** Added a dedicated planning brief for refactoring `src/terminal/ws-server.ts` at `docs/terminal-ws-server-refactor-brief.md`.

**Why:** The existing terminal architecture brief covers the broader terminal system, but `ws-server.ts` now deserves its own planning artifact. The websocket bridge still carries task-stream ownership, per-viewer lifecycle, restore timing, batching, and backpressure coordination in one file. A dedicated brief makes the current responsibilities, invariants, target backend module split, rollout order, and test plan explicit enough for a future agent to execute the refactor without relying on chat history.

**Files touched:** `docs/terminal-ws-server-refactor-brief.md`, `docs/optimization-shaped-architecture-followups.md`, `docs/README.md`, `docs/todo.md`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Fix: untrash does not always restart agent session (2026-04-19)

**What:** Two bugs prevented untrashing a task card from reliably restarting the agent session.

**Bug 1 — “blocked” bailout in `handleRestoreTaskFromTrash`:** When `tryProgrammaticCardMove` returned `”blocked”` (another card animation already in flight), the handler returned early without ever calling `resumeTaskFromTrash`. The card stayed in trash with no user feedback. Fix: only bail on `”started”` (animation accepted — `handleDragEnd` will handle resume). For `”blocked”`, fall through to the manual `moveTaskToColumn` + `resumeTaskFromTrash` path.

**Bug 2 — exit code 0 gate on resume fallback:** When an untrashed card's session started with `--continue` but the agent exited cleanly (code 0) while still in `awaiting_review/attention`, the fallback restart was gated on `exitCode !== 0`. Since `--continue` exits 0 when there's no conversation to resume (e.g. conversation garbage-collected), the card was left stuck in review with a dead process. Fix: removed the non-zero exit code requirement. The remaining condition set (`preExitState === “awaiting_review”` + `reviewReason === “attention”`) already ensures this only fires when the agent never started working.

**Files touched:** `web-ui/src/hooks/board/use-trash-workflow.ts` (removed `”blocked”` from early-return guard), `src/terminal/session-lifecycle.ts` (removed `exitCode !== 0` from resume fallback condition), `CHANGELOG.md`, `docs/implementation-log.md`.

## Enhancement: restart button on review cards (2026-04-19)

**What:** Review cards now show a restart button on hover for live sessions (awaiting_review), not just dead/failed ones.

**Why:** Running cards show stop & trash on hover, but review cards only showed restart for dead sessions. Users had no quick way to restart a healthy session from review — they'd have to drag it back to in-progress or use other workarounds.

**How:** Changed the restart button condition in `BoardCardActions` from `isSessionRestartable` (dead sessions only, after 1s delay) to `isSessionRestartable || (isHovered && !isSessionDead)`, so hovering a live review card surfaces the restart action.

**Files touched:** `web-ui/src/components/board/board-card-actions.tsx`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Refactor: terminal architecture session / viewport / attachment / reuse / prewarm split (2026-04-19)

**Commit:** `907d1e22`

**What:** Completed the frontend terminal architecture refactor described in `docs/terminal-architecture-refactor-brief.md`. The old `TerminalSlot`-centered design is now decomposed into `terminal-session-handle.ts` for task/project identity and socket lifecycle, `terminal-viewport.ts` for xterm/DOM/rendering/resize concerns, `terminal-attachment-controller.ts` for binding session to viewport and owning restore/show coordination, `terminal-reuse-manager.ts` for the app-facing pooled-task acquisition surface, and `terminal-prewarm-policy.ts` for optional hover-prewarm policy. The UI layer was also split so task agent terminals stay in `agent-terminal-panel.tsx` while dedicated shell terminals use `shell-terminal-panel.tsx` with shared rendering in `persistent-terminal-panel-layout.tsx`.

**Why:** The previous design had correctness and optimization concerns intertwined closely enough that pool roles and warmup policy felt like the primary model of the terminal system. This refactor keeps reconnect, restore, quick task switching, dedicated shell behavior, and pooled agent behavior intact while making the core mental model “attach a viewport to a session” and treating reuse/prewarm as optional policy layers.

**Approach:** Landed in five incremental passes on `feature/terminal-refactor`:
- Phase 1: extracted `TerminalSessionHandle` from slot-owned socket and restore logic.
- Phase 2: extracted `TerminalViewport` from xterm/DOM/rendering/resize responsibilities.
- Phase 3: introduced `TerminalAttachmentController` so restore sequencing and session-to-viewport routing are explicit.
- Phase 4: added `TerminalReuseManager` so app-facing pooled task-terminal callers no longer import raw pool verbs directly.
- Phase 5: added `TerminalPrewarmPolicy` so hover-based prewarm behavior is expressed as optional policy rather than ambient app logic. The default remains enabled, and the policy can now also be swapped out for testing or measurement without changing correctness flows.

**Files touched:**
- `web-ui/src/terminal/terminal-session-handle.ts`
- `web-ui/src/terminal/terminal-viewport.ts`
- `web-ui/src/terminal/terminal-attachment-controller.ts`
- `web-ui/src/terminal/terminal-reuse-manager.ts`
- `web-ui/src/terminal/terminal-prewarm-policy.ts`
- `web-ui/src/terminal/terminal-slot.ts`
- `web-ui/src/terminal/use-persistent-terminal-session.ts`
- `web-ui/src/terminal/use-persistent-terminal-session.test.tsx`
- `web-ui/src/components/terminal/agent-terminal-panel.tsx`
- `web-ui/src/components/terminal/shell-terminal-panel.tsx`
- `web-ui/src/components/terminal/persistent-terminal-panel-layout.tsx`
- `web-ui/src/components/terminal/index.ts`
- `web-ui/src/components/app/home-view.tsx`
- `web-ui/src/components/task/card-detail-view.tsx`
- `web-ui/src/hooks/app/use-app-action-models.ts`
- `AGENTS.md`
- `docs/terminal-architecture-refactor-handoff-phase-2.md`
- `docs/todo.md`
- `CHANGELOG.md`

## Feature: single-tab guard (2026-04-19)

**What:** Added a guard that prevents multiple browser tabs from running Quarterdeck against the same server. The second tab shows a fallback screen instead of mounting the app; a “Use here instead” button transfers ownership via BroadcastChannel.

**Why:** Multiple tabs sharing WebSocket connections, terminal sessions, and optimistic-concurrency board state causes conflicts — duplicate state writes, terminal attachment races, and confusing “Project changed elsewhere” toasts from revision mismatches.

**How it works:** `useSingleTabGuard` writes a localStorage heartbeat (every 2s, stale after 5s) keyed by origin. A new tab checks the lock before mounting providers. BroadcastChannel enables instant “yield” messaging for the takeover button. If the owning tab closes or crashes, the blocked tab auto-recovers via stale detection. Dogfood is unaffected because localStorage is scoped per origin (different ports = different locks).

**Files touched:** `web-ui/src/hooks/app/use-single-tab-guard.ts` (new — lock lifecycle hook), `web-ui/src/components/app/already-open-fallback.tsx` (new — blocked tab UI), `web-ui/src/App.tsx` (split into `App` + `AppInner` to gate before provider tree), `web-ui/src/hooks/app/index.ts` (barrel export), `web-ui/src/components/app/index.ts` (barrel export), `CHANGELOG.md`, `docs/implementation-log.md`.

## Fix: truncate schema validation errors in state file logging (2026-04-19)

**What:** `formatSchemaIssues` in `project-state-index.ts` now limits output to 5 issues and appends `(N more)` for the remainder.

**Why:** When a stale `sessions.json` has many entries failing the same validation (e.g. 25+ entries all missing `projectPath` after the workspace→project rename), the shutdown cleanup log dumped every single error — producing a wall of identical lines. The actual signal was one unique error repeated across entries.

**Files touched:** `src/state/project-state-index.ts`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Fix: ghost-until-open scope — dialog should use standard button (2026-04-19)

**What:** Removed `ghostUntilOpen` from the `BranchSelectDropdown` in `task-create-dialog.tsx`.

**Why:** The ghost-until-open styling was intended only for the inline create card in the top bar, where the dropdown should blend in. The task creation dialog is a focused form where the branch selector should remain visually prominent. The prop was mistakenly applied to both call sites.

**Files touched:** `web-ui/src/components/task/task-create-dialog.tsx`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Fix: base ref dropdown “(default)” label only for pinned branches (2026-04-19)

**What:** Changed `use-task-branch-options.ts` so the "(default)" label and "(current, default)" composite label only appear when the user has explicitly pinned a default base ref via config. Removed two stale todo items (statusline counter desync investigation, default branch resolution audit).

**Why:** The dropdown was labeling the git-detected default branch (typically `main`) with "(default)" even when the user hadn't pinned anything. This was misleading — the pin icon correctly showed nothing was pinned, but the label implied otherwise. The "(default)" label should only reflect an explicit user choice.

**Files touched:** `web-ui/src/hooks/git/use-task-branch-options.ts` (added `hasConfigPin` guard around default labeling), `docs/todo.md` (removed 2 items), `CHANGELOG.md`, `docs/implementation-log.md`.

## Enhancement: ghost-until-open base ref branch selector (2026-04-19)

**What:** The base ref `BranchSelectDropdown` in task creation views now renders as a transparent ghost button until the popover is opened.

**Why:** The solid button drew too much visual attention in the create card, competing with the primary input. A ghost button blends with the surrounding UI until the user interacts with it.

**Changes:**
- Added `ghostUntilOpen` prop to `SearchSelectDropdown` — when true, the trigger uses the `ghost` Button variant while closed and switches to `default` when the popover opens.
- Threaded the prop through `BranchSelectDropdown`.
- Enabled `ghostUntilOpen` on the inline create card (`task-inline-create-card.tsx`).

**Files touched:** `web-ui/src/components/search-select-dropdown.tsx`, `web-ui/src/components/git/branch-select-dropdown.tsx`, `web-ui/src/components/task/task-inline-create-card.tsx`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Docs: refactor agent instruction docs around AGENTS.md (2026-04-19)

**What:** Established `AGENTS.md` as the single canonical agent-instructions file. Slimmed `CLAUDE.md` to a minimal compatibility shim. Moved duplicated developer content to human-facing docs. Added a CI check script to prevent drift. Rewrote the Codex todo items to reflect native hook support.

**Why:** `CLAUDE.md` had grown to ~140 lines duplicating content that belonged in `README.md`, `DEVELOPMENT.md`, and `AGENTS.md`. This created maintenance drift — updates to one file didn't propagate to the other. The Codex todo section was a stale status dump rather than actionable work items.

**Changes:**
- `CLAUDE.md` — replaced ~140 lines with an 11-line shim that imports `@AGENTS.md` and points to `@README.md`, `@DEVELOPMENT.md`, `@docs/README.md`.
- `AGENTS.md` — added "Agent instruction files" section documenting the canonical/shim relationship and the check script. Added `docs/archive/` gitignored note.
- `DEVELOPMENT.md` — added quick reference, repo orientation, and CI/CD sections (content relocated from `CLAUDE.md`).
- `README.md` — added "Contributor docs" section linking to `DEVELOPMENT.md`, `docs/README.md`, and `AGENTS.md`.
- `docs/README.md` — added `DEVELOPMENT.md` and `AGENTS.md` to the file-purpose list.
- `scripts/check-agent-instructions.mjs` — new CI check validating AGENTS.md canonical marker, CLAUDE.md shim shape (heading, imports, no code blocks, line cap).
- `package.json` — added `check:agent-instructions` script, wired it into `npm run check`.
- `docs/todo.md` — replaced monolithic "Full Codex support" section with four focused items: native hooks, provider-neutral LLM, capability detection, worktree system prompt.
- `src/prompts/prompt-templates.ts` — updated worktree system prompt example from `CLAUDE.md` to `AGENTS.md`.

**Files touched:** `AGENTS.md`, `CLAUDE.md`, `DEVELOPMENT.md`, `README.md`, `docs/README.md`, `docs/todo.md`, `package.json`, `scripts/check-agent-instructions.mjs`, `src/prompts/prompt-templates.ts`.

## Refactor: fix workspace→project/worktree rename oversights (2026-04-19)

**What:** Corrected identifiers that the prior rename pass mis-categorized, plus a handful of stale "workspace" leftovers.

**Why:** The bulk rename (ac1001b0) converted all "workspace" to "project", but several identifiers describe per-task git worktree state (branch, changes, detached HEAD, conflict state) — not the high-level project concept. Using "project" for these muddied the semantic distinction between the project (board/state) and its worktrees (per-task git isolation).

**Changes:**
- **→ worktree** (over-corrected from workspace→project): `RuntimeTaskProjectMetadata` → `RuntimeTaskWorktreeMetadata`, `runtimeTaskProjectMetadataSchema` → `runtimeTaskWorktreeMetadataSchema`, `TrackedTaskProject` → `TrackedTaskWorktree`, `CachedTaskProjectMetadata` → `CachedTaskWorktreeMetadata`, `loadTaskProjectMetadata` → `loadTaskWorktreeMetadata`, `ReviewTaskProjectSnapshot` → `ReviewTaskWorktreeSnapshot`, `useTaskProjectSnapshotValue` → `useTaskWorktreeSnapshotValue`, `useTaskProjectStateVersionValue` → `useTaskWorktreeStateVersionValue`, plus get/set/clear store functions and all local variable names referencing these types.
- **→ project** (stale workspace leftovers): `WORKSPACE_STATE_FILENAMES`, `WORKSPACE_STATE_PERSIST_DEBOUNCE_MS`, `WORKSPACE_ID` test constant.
- **→ worktree** (stale workspace leftover): `NOOP_FETCH_WORKSPACE_INFO` → `NOOP_FETCH_WORKTREE_INFO`.
- **biome.json**: Updated lint rule to reference `createProjectTrpcClient` (function was already renamed).

**Files touched:** 28 files across `src/`, `web-ui/src/`, `test/`, `biome.json`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Refactor: complete workspace → project/worktree/workdir rename (2026-04-17)

**What:** Eliminated all remaining "workspace" references in source, tests, and config — except agent workspace-trust files where "workspace" is the agent's own terminology.

**Why:** The prior rename pass (709e05e7) covered files, directories, API routes, and wire protocol but left ~980 occurrences across 96 files: identifiers, string literals, Zod validation messages, comments, env vars, and test fixture IDs. These created confusion about whether "workspace" meant a project, a git worktree, or a working directory.

**Approach:** Categorized each identifier by its actual semantic role:
- **→ project**: state management, IDs, persistence, sync, settings scope, index entries, env vars
- **→ worktree**: task git worktree operations (`ensureTaskWorktree`, `cleanupTaskWorktree`, `taskWorktreeInfo`)
- **→ workdir**: file change queries (`getWorkdirChanges`, `loadWorkdirChanges`)
- **kept as workspace**: agent workspace trust (Claude/Codex concept)

Also fixed: `@runtime-task-worktree-path` Vite alias pointing to deleted `src/workspace/` directory, stale `workspace-state-query.ts` reference in `biome.json`, stale interface names in `docs/todo.md`.

**Files touched:** 106 files across `src/`, `web-ui/src/`, `test/`, `biome.json`, `web-ui/tsconfig.json`, `web-ui/vite.config.ts`, `web-ui/vitest.config.ts`, `docs/todo.md`, `CHANGELOG.md`.

## Refactor: app shell component decomposition and design guardrails (2026-04-17)

**What:** Split two large app-shell components (`project-navigation-panel.tsx` and `top-bar.tsx`) into focused sub-components, added four design/architecture docs, fixed a pre-existing TS error, and completed a stale workspace→project prop rename.

**Why:** Both components were 600+ lines with multiple independent concerns (drag-and-drop list, removal dialog, onboarding tips, shortcut controls, scope indicators). The design docs capture recurring architectural patterns (optimization-shaped architecture) observed during recent refactor work, giving future agents self-contained context for planned terminal and state-management refactors.

**Approach:** Mechanical extraction — no behavior changes except one minor improvement: the removal dialog now guards `onOpenChange` during pending removal to prevent closing mid-operation. The `isWorkspacePathLoading` prop was renamed to `isProjectPathLoading` at both the `TopBar` interface and the `ConnectedTopBar` call site to complete the workspace→project migration for this surface.

**Files touched:**
- `web-ui/src/components/app/project-navigation-panel.tsx` — gutted to 74L shell importing 4 new files
- `web-ui/src/components/app/project-navigation-list.tsx` — new: drag-and-drop project list + add button
- `web-ui/src/components/app/project-navigation-row.tsx` — new: single project row + skeleton + badge logic
- `web-ui/src/components/app/project-navigation-removal-dialog.tsx` — new: removal confirmation dialog
- `web-ui/src/components/app/project-navigation-sidebar-sections.tsx` — new: onboarding tips, shortcuts card, beta notice
- `web-ui/src/components/app/top-bar.tsx` — reduced to 176L shell importing 3 new files
- `web-ui/src/components/app/top-bar-scope-section.tsx` — new: back button, task title, project path, hints
- `web-ui/src/components/app/top-bar-project-shortcut-control.tsx` — new: project shortcut split-button + create dialog
- `web-ui/src/components/app/top-bar-prompt-shortcut-control.tsx` — new: prompt shortcut split-button
- `web-ui/src/components/app/git-branch-status-control.tsx` — new: git branch pill (moved from top-bar.tsx)
- `web-ui/src/components/app/connected-top-bar.tsx` — prop rename `isWorkspacePathLoading` → `isProjectPathLoading`
- `web-ui/src/components/app/index.ts` — barrel export updated
- `src/terminal/orphan-cleanup.ts` — added `if (!comm) continue` guard fixing TS2345/TS18048
- `docs/design-guardrails.md` — new: reusable rules for preventing optimization-shaped architecture
- `docs/design-weaknesses-roadmap.md` — new: ranked architectural weaknesses
- `docs/optimization-shaped-architecture-followups.md` — new: subsystem-level follow-up tracker
- `docs/terminal-architecture-refactor-brief.md` — new: self-contained terminal refactor planning brief
- `docs/README.md` — added refactor docs map
- `docs/todo.md` — added optimization follow-ups section, updated Phase 3 status
- `docs/plan-design-investigation.md` — marked item 4 done
- `CHANGELOG.md` — added entry
- `package-lock.json` — removed unused `mitt`, `neverthrow` entries

## Refactor: rename "workspace" to "project" throughout codebase (2026-04-17)

**What:** Unified the state-container concept under "project". Previously the backend used "workspace" while the UI/API layer used "project". All types, files, functions, variables, API routes, wire protocol strings, HTTP headers, WebSocket messages, and on-disk paths now consistently use "project". Renamed `src/workspace/` to `src/workdir/` for working directory operations. Agent workspace trust files left unchanged intentionally.

**Why:** The dual terminology was a constant source of confusion — the same concept had two names depending on which layer you were in. Grepping for "workspace" returned a mix of state-container references and agent trust references, making navigation harder.

**Approach:** Used forge to generate a spec, research inventory, and 8-task execution plan. The build phase used bulk `find | xargs sed` for the initial pass (~4900 occurrences across ~290 files), then manual cleanup of ~260 remaining local variables, interface members, comments, and error messages. Migration code was spec'd but dropped in favor of manual migration (3 known installations). Completeness verified with a grep that returns zero results outside the intentional workspace-trust exclusions.

**Key changes:**
- State files: `workspace-state*.ts` → `project-state*.ts`
- Server: `workspace-registry.ts` → `project-registry.ts`, metadata monitor/loaders renamed
- tRPC: `workspace` router → `project` router, all procedure files renamed
- API contracts: Zod schemas, wire protocol strings (`workspace_state_updated` → `project_state_updated`), HTTP header (`x-quarterdeck-workspace-id` → `x-quarterdeck-project-id`)
- Frontend: stores, hooks, providers, runtime queries, all local variables and props
- Working dir ops: `src/workspace/` → `src/workdir/`, functions from `*Workspace*` to `*Workdir*`
- On-disk path: `~/.quarterdeck/workspaces/` → `~/.quarterdeck/projects/`
- Documentation: `CLAUDE.md`, `AGENTS.md`, `docs/ui-layout-architecture.md`, `docs/web-ui-conventions.md`

**Files touched:** 289 files changed. 288 in the committed diff plus the lessons file. All tests pass (1535 total — 733 runtime, 802 web-ui), typecheck/lint/build clean.

## Enhancement: notification muting — "Mute project viewed" (2026-04-17)

**What:** Renamed "Mute focused project" to "Mute project viewed" and changed per-project notification suppression to only apply while the tab is visible. Defaulted review suppression to `true` for new users.

**Why:** The previous behavior muted sounds even when the user had tabbed away from Quarterdeck, defeating the purpose of audio notifications. The "focused" label was also misleading — it's about the project being viewed, not window focus.

**Approach:** Moved the `isTabVisible()` guard from inside `isEventSuppressedForProject` (which would have mixed browser concerns into a pure config predicate) to the `fireSound` call site in `use-audible-notifications.ts`. This keeps the domain function testable without DOM mocking and puts the visibility decision at the orchestration layer alongside the existing `areSoundsSuppressed` global gate.

**Files touched:**
- `src/config/config-defaults.ts` — `review` default changed to `true` in `DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT`
- `test/runtime/config/runtime-config-helpers.ts` — aligned hardcoded test fixture with new default
- `web-ui/src/components/settings/display-sections.tsx` — label and comment rename
- `web-ui/src/hooks/notifications/use-audible-notifications.ts` — added `isTabVisible()` guard at `fireSound` call site
- `web-ui/src/hooks/notifications/audible-notifications-suppress.test.tsx` — tests mock tab as visible and use `onlyWhenHidden: false` to test suppression in isolation

## Feature: scroll-to-line on text search result click (2026-04-17)

**What:** Clicking a text search result (Cmd+Shift+F) now scrolls the file content viewer to the matched line number.

**Why:** Previously, selecting a search result opened the file but left the user at the top — they had to manually scroll to find the match. This closes the loop on the text search UX.

**Approach:** Extended `onSelect` in `use-text-search.ts` to pass `match.line` alongside `match.path`. The line number flows through `pendingFileNavigation` in `App.tsx` → `useGitNavigation` → `FilesView` → `FileContentViewer`, which calls `virtualizer.scrollToIndex(lineNumber - 1)` after the file content loads.

**Files touched:**
- `web-ui/src/hooks/search/use-text-search.ts` — `onSelect` signature extended with optional `lineNumber`
- `web-ui/src/components/search/text-search-overlay.tsx` — passes line number through to `onSelect`
- `web-ui/src/App.tsx` — `pendingFileNavigation` state extended with `lineNumber`, wired to git navigation
- `web-ui/src/hooks/git/use-git-navigation.ts` — `NavigateToFileOptions` extended with `lineNumber`
- `web-ui/src/components/git/files-view.tsx` — passes `lineNumber` to `FileContentViewer`
- `web-ui/src/components/git/panels/file-content-viewer.tsx` — `useEffect` scrolls virtualizer to line on mount/change

## Feature: file finder (Cmd+P) and text search (Cmd+Shift+F) (2026-04-17)

**What:** Added two VS Code-style search overlays to the web UI — a file finder opened via Cmd+P for fuzzy filename search, and a text search opened via Cmd+Shift+F for full-text grep across the workspace using `git grep`.

**Why:** Users could only browse files via the tree sidebar and had no way to search file contents from the UI. Both features are standard IDE navigation patterns that significantly speed up file discovery in large worktrees.

**Approach:**

1. **Backend — text search endpoint** (`src/workspace/search-workspace-text.ts`): New `searchWorkspaceText()` function using `runGit` to execute `git grep -rn --null --no-color` with flags for case sensitivity (`-i`), fixed-string (`-F`) vs extended regex (`-E`), and `--` separator to prevent flag injection. Parses NUL-delimited output (`--null` avoids colon ambiguity in file paths), groups matches by file, truncates at configurable limit (default 100). Exit code 1 returns empty results; exit code 2 throws `TRPCError({ code: "BAD_REQUEST" })` with stderr message. Wired through standard workspace procedure pattern: Zod schemas in `workspace-files.ts`, method on `workspaceApi` interface in `app-router-context.ts`, implementation in `workspace-api-changes.ts`, query procedure in `workspace-procedures.ts`.

2. **Frontend — shared overlay shell** (`web-ui/src/components/search/search-overlay-shell.tsx`): Reusable component rendering a full-viewport backdrop with a centered floating panel. Escape key handled via capture-phase `keydown` listener on `document` (fires before the bubbling-phase `useEscapeHandler` in App.tsx that deselects tasks). Outside-click dismisses; panel click stops propagation. No Radix Dialog — avoids focus trap complications with hotkey toggle.

3. **Frontend — file finder** (`use-file-finder.ts` + `file-finder-overlay.tsx`): Hook uses `useDebouncedEffect` (150ms) to call existing `workspace.searchFiles` endpoint with request-ID race protection (same pattern as `task-prompt-composer.tsx`). Component renders auto-focused input, scrollable results with file name/path/changed-indicator, keyboard navigation with wrap-around, selected row highlighting and `scrollIntoView`.

4. **Frontend — text search** (`use-text-search.ts` + `text-search-overlay.tsx`): Hook manages query, case/regex toggles, `executeSearch()` triggered on Enter (minimum 2 characters), flat-index keyboard navigation across grouped results, and automatic re-search when toggles change. Component renders input with toggle buttons, match count summary with truncation indicator, results grouped by file with sticky headers, and inline match highlighting using regex split/match with try/catch for invalid patterns.

5. **Integration** (`use-app-hotkeys.ts` + `App.tsx`): Two new `useHotkeys` calls (`mod+p` with `preventDefault: true` to suppress browser print dialog, `mod+shift+f`), both guarded by `currentProjectId !== null`. App.tsx owns `isFileFinderOpen`/`isTextSearchOpen` state with mutual exclusion (opening one closes the other). File selection calls `git.navigateToFile({ targetView: "files", filePath })` via existing `pendingFileNavigation` mechanism. Both modals close on project switch via `searchOverlayResetRef`.

**Files touched:**
- `src/core/api/workspace-files.ts` — 4 new Zod schemas (request, match, file group, response) with inferred types
- `src/workspace/search-workspace-text.ts` — new, `searchWorkspaceText()` implementation
- `src/workspace/index.ts` — barrel export
- `src/trpc/app-router-context.ts` — `searchText` method on workspace API interface
- `src/trpc/workspace-api-changes.ts` — implementation in `createChangesOps`, added to `ChangesOps` pick
- `src/trpc/workspace-procedures.ts` — `searchText` query procedure
- `web-ui/src/components/search/search-overlay-shell.tsx` — new, shared overlay shell
- `web-ui/src/components/search/file-finder-overlay.tsx` — new, file finder component
- `web-ui/src/components/search/text-search-overlay.tsx` — new, text search component
- `web-ui/src/hooks/search/use-file-finder.ts` — new, file finder hook
- `web-ui/src/hooks/search/use-text-search.ts` — new, text search hook
- `web-ui/src/hooks/search/index.ts` — barrel export
- `web-ui/src/hooks/app/use-app-hotkeys.ts` — `mod+p` and `mod+shift+f` hotkey registration
- `web-ui/src/hooks/app/use-app-hotkeys.test.tsx` — added new required props to test harness
- `web-ui/src/App.tsx` — overlay state, toggle handlers, file navigation integration, project-switch cleanup
- `docs/todo.md` — added scroll-to-line and live preview pane follow-up items

**Verification:** Biome lint clean, TypeScript clean, 729 runtime tests pass, 787 web-ui tests pass. Commit fca96c38.

**Follow-up fixes (sanity review, commit f9cd214e):**
- `use-text-search.ts` — Added `requestIdRef` with stale-response guards to `executeSearch`, matching the pattern in `use-file-finder.ts`. Prevents overlapping searches (e.g. toggle-triggered re-search racing a manual search) from producing stale results. Removed dead `onDismiss` parameter and its ref from the hook interface.
- `text-search-overlay.tsx` — Replaced mutable `let flatIndex` counter (mutated inside `.map()` IIFE during render) with a precomputed `flatIndexStarts` array via `useMemo`, making the data flow explicit and safe under memoization/StrictMode.
- `use-file-finder.ts` — Removed dead `onDismiss` parameter from hook interface (dismissal handled entirely by `SearchOverlayShell`).
- `search-overlay-shell.tsx` — Stabilized Escape `keydown` listener with `onDismissRef` so it registers once on mount instead of re-attaching every render (the inline arrow `onDismiss` from App.tsx was causing needless listener churn).
- `file-finder-overlay.tsx` — Updated `useFileFinder` call site to drop removed `onDismiss` prop.

## Refactor: separate dedicated terminals from shared pool policy (2026-04-17)

**What:** Reassessed `web-ui/src/terminal/terminal-pool.ts` and kept the shared-slot allocation/lifecycle state machine intact, but extracted the dedicated-terminal registry into `web-ui/src/terminal/terminal-dedicated-registry.ts`. The new module now owns dedicated-terminal keying, home/detail task classification, dedicated slot creation/reuse, per-workspace disposal, dedicated iteration, and dedicated lookup helpers. `terminal-pool.ts` now stays focused on shared-slot role transitions, warmup/previous eviction timers, rotation, and the public shared-pool API, while still exposing the existing dedicated-terminal API through stable exports.

**Why:** This completed the `terminal-pool.ts` reassessment item from `docs/plan-csharp-readability-followups.md`. The review showed that most of the file's size is justified by the pool state machine: allocation policy, warmup promotion, `PREVIOUS` retention, timed eviction, and free-slot rotation are tightly coupled and safer to read together. The removable coupling was the separate dedicated-terminal lifecycle, which follows different ownership rules and was making the pool invariants harder to discover.

**Files touched:**
- `web-ui/src/terminal/terminal-pool.ts` — narrowed the module to shared-pool policy plus cross-terminal helpers, with dedicated concerns delegated out
- `web-ui/src/terminal/terminal-dedicated-registry.ts` — new dedicated-terminal ownership module for home/detail terminal lookup, reuse, disposal, and iteration
- `docs/plan-csharp-readability-followups.md` — marked the terminal-pool reassessment item done and recorded the conclusion
- `docs/todo.md` — removed the completed reassessment item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the reassessment result and extracted ownership boundary

**Verification:** `npm --prefix web-ui run test -- src/terminal/terminal-pool-acquire.test.ts src/terminal/terminal-pool-lifecycle.test.ts src/terminal/terminal-pool-dedicated.test.ts src/terminal/use-persistent-terminal-session.test.tsx`; `npm --prefix web-ui run typecheck`; `npx @biomejs/biome check web-ui/src/terminal/terminal-pool.ts web-ui/src/terminal/terminal-dedicated-registry.ts docs/plan-csharp-readability-followups.md docs/todo.md CHANGELOG.md docs/implementation-log.md`

**Commit:** Pending user-requested commit (current HEAD: `511a3075`).

## Refactor: split terminal slot hosting and visibility lifecycle (2026-04-17)

**What:** Refactored `web-ui/src/terminal/terminal-slot.ts` so the class now reads more clearly as the orchestrator over terminal collaborators instead of as the implementation home for each concern. Added `web-ui/src/terminal/slot-dom-host.ts` to own the persistent parking-root host element, stage-container attachment, visibility/reveal state, and parking transitions. Added `web-ui/src/terminal/slot-visibility-lifecycle.ts` to own the document visibility listener, tab-return repaint, and reconnect-on-return behavior for dead sockets. Inside `TerminalSlot`, grouped constructor work behind named helpers for xterm creation, addon wiring, socket manager creation, write-queue creation, IO forwarding, key handling, disconnect state reset, and restore application/finalization. Added focused unit coverage for the extracted collaborators while keeping the existing pool and persistent-session terminal tests green.

**Why:** This completed the `terminal-slot.ts` readability item from `docs/plan-csharp-readability-followups.md`. Before the refactor, DOM parking, xterm setup, reconnect-on-visibility logic, restore sequencing, and general slot orchestration were mixed together in one large class body and especially in a noisy constructor. Pulling the DOM-hosting and visibility lifecycle concerns into named collaborators makes reconnect, restore, and hosting responsibilities easier to find without changing the slot's runtime contract.

**Files touched:**
- `web-ui/src/terminal/terminal-slot.ts` — slimmed the slot into a clearer orchestrator with named setup and restore helpers
- `web-ui/src/terminal/slot-dom-host.ts` — new DOM-hosting and parking collaborator
- `web-ui/src/terminal/slot-visibility-lifecycle.ts` — new visibility refresh and reconnect collaborator
- `web-ui/src/terminal/slot-dom-host.test.ts` — regression coverage for staging, reveal/hide, and parking behavior
- `web-ui/src/terminal/slot-visibility-lifecycle.test.ts` — regression coverage for tab-return refresh and reconnect behavior
- `docs/plan-csharp-readability-followups.md` — marked the terminal-slot readability item done
- `docs/todo.md` — removed the completed terminal-slot readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm --prefix web-ui run test -- src/terminal/slot-dom-host.test.ts src/terminal/slot-visibility-lifecycle.test.ts src/terminal/terminal-pool-acquire.test.ts src/terminal/terminal-pool-lifecycle.test.ts src/terminal/terminal-pool-dedicated.test.ts src/terminal/use-persistent-terminal-session.test.tsx`; `npm --prefix web-ui run typecheck`; `npx @biomejs/biome check web-ui/src/terminal/terminal-slot.ts web-ui/src/terminal/slot-dom-host.ts web-ui/src/terminal/slot-visibility-lifecycle.ts web-ui/src/terminal/slot-dom-host.test.ts web-ui/src/terminal/slot-visibility-lifecycle.test.ts`

**Commit:** Pending user-requested commit (current HEAD: `30ad3201`).

## Refactor: split runtime state hub coordination helpers (2026-04-17)

**What:** Refactored `src/server/runtime-state-hub.ts` so the main hub now reads primarily as high-level connection and broadcast coordination. Added `src/server/runtime-state-client-registry.ts` to own websocket client registration, workspace-scoped membership, disconnect cleanup, final error payload delivery, and shutdown termination. Added `src/server/runtime-state-message-batcher.ts` to own task-session summary batching, debug-log batching, timer cleanup, and terminal-manager subscription lifecycle. The hub now composes those collaborators with the existing workspace metadata monitor and snapshot/broadcast APIs, while preserving the public `RuntimeStateHub` surface. Added focused tests for the extracted collaborators under `test/runtime/server/`.

**Why:** This completed the `runtime-state-hub.ts` readability item from `docs/plan-csharp-readability-followups.md`. Before the refactor, websocket client bookkeeping, workspace client tracking, summary batching, debug-log batching, metadata-monitor integration, and high-level broadcast APIs were all interleaved inside one class. Splitting the client registry and batching concerns into named modules makes the main runtime hub substantially easier to navigate without changing websocket timing or workspace disposal behavior.

**Files touched:**
- `src/server/runtime-state-hub.ts` — slimmed the hub into a coordinator over extracted client-registry and batching helpers
- `src/server/runtime-state-client-registry.ts` — new websocket client bookkeeping and cleanup module
- `src/server/runtime-state-message-batcher.ts` — new summary/debug-log batching module
- `test/runtime/server/runtime-state-client-registry.test.ts` — regression coverage for workspace client tracking, targeted broadcasts, and disconnect cleanup
- `test/runtime/server/runtime-state-message-batcher.test.ts` — regression coverage for task-summary coalescing and debug-log batching
- `docs/plan-csharp-readability-followups.md` — marked the runtime-state-hub readability item done
- `docs/todo.md` — removed the completed runtime-state-hub readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm run test -- test/runtime/server/runtime-state-client-registry.test.ts test/runtime/server/runtime-state-message-batcher.test.ts`; `npm run typecheck`; `npx @biomejs/biome check src/server/runtime-state-hub.ts src/server/runtime-state-client-registry.ts src/server/runtime-state-message-batcher.ts test/runtime/server/runtime-state-client-registry.test.ts test/runtime/server/runtime-state-message-batcher.test.ts`

**Commit:** Pending user-requested commit (current HEAD: `20cbc414`).

## Refactor: decompose project navigation panel into a composition hook (2026-04-17)

**What:** Refactored `web-ui/src/components/app/project-navigation-panel.tsx` so the sidebar panel now reads as a composition surface instead of keeping its local controller logic inline. Added `web-ui/src/hooks/project/use-project-navigation-panel.ts` to own optimistic project reorder state, drag/drop reorder handling, permission-request badge counts, and removal confirmation dialog state. In the component file, extracted the draggable list into `ProjectList` and `DraggableProjectRow`, gave the portal-backed drag rendering a named helper, and moved task badge derivation behind `buildTaskCountBadges()` so the row component stays focused on rendering and event wiring. Added a dedicated hook test file covering the new orchestration paths.

**Why:** This completed the `project-navigation-panel.tsx` readability item from `docs/plan-csharp-readability-followups.md`. Before the refactor, the panel mixed optimistic ordering, drag controller behavior, removal workflow state, badge derivation, and the full render tree in one component body. Pulling the stateful behavior into a named hook makes the main panel easier to scan top-to-bottom and makes the drag/removal rules easier to find in isolation.

**Files touched:**
- `web-ui/src/components/app/project-navigation-panel.tsx` — replaced inline orchestration with the new hook and slimmer view sections
- `web-ui/src/hooks/project/use-project-navigation-panel.ts` — new composition hook for reorder/removal/badge state
- `web-ui/src/hooks/project/use-project-navigation-panel.test.tsx` — regression coverage for the extracted hook behavior
- `web-ui/src/hooks/project/index.ts` — exported the new hook
- `docs/plan-csharp-readability-followups.md` — marked the project navigation panel item done
- `docs/todo.md` — removed the completed project navigation panel readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm --prefix web-ui run test -- project-navigation-panel.test.tsx use-project-navigation-panel.test.tsx`; `npm --prefix web-ui run typecheck`

**Commit:** Pending user-requested commit (current HEAD: `b9e3418d`).

## Chore: dead code cleanup (2026-04-17)

**What:** Comprehensive sweep to remove dead code, orphaned files, unused dependencies, and vestigial barrel re-exports.

**Why:** Accumulated dead code from removed features (MCP integration, auto-update, task chat) and unused dependencies (`neverthrow`, `mitt`) were adding confusion and install weight with no benefit.

**What was removed:**

1. **Orphaned files:** `src/core/api/task-chat.ts` (88 lines — full API contract for a never-built task chat feature) and `web-ui/src/components/open-workspace-button.tsx` (110 lines — complete component rendered nowhere).

2. **Dead tRPC procedures:** `workspace.getGitSummary` and `workspace.notifyStateUpdated` — removed from router (`workspace-procedures.ts`), context interface (`app-router-context.ts`), and factory functions (`workspace-api-git-ops.ts`, `workspace-api-state.ts`). The frontend never called either; git operations go through `runGitSyncAction` and state notifications go through the single-writer `saveState` flow.

3. **Deprecated CLI stubs:** `mcp` and `update` subcommands that only printed deprecation warnings. The MCP integration and auto-update features they referenced no longer exist.

4. **Legacy env var:** `QUARTERDECK_TITLE_MODEL` — backward-compat alias for `QUARTERDECK_LLM_MODEL` in `src/title/llm-client.ts`. Removed from code, doc comment, and test.

5. **Unused npm dependencies:** `neverthrow` and `mitt` — zero imports anywhere in the codebase.

6. **Dead CSS:** `.kb-line-clamp-2` and `.kb-line-clamp-5` in `web-ui/src/styles/utilities.css` — only `.kb-line-clamp-1` was used.

7. **Barrel export pruning:** Removed re-exports with no external consumers — `parseTaskWorkspaceInfoRequest`, `parseWorkspaceStateSaveRequest`, 6 task mutation result/input types, `RuntimeAddTaskDependencyResult`, `RuntimeRemoveTaskDependencyResult`, `RuntimeTrashTaskResult` from `core/index.ts`; 6 internal path helpers from `state/index.ts`; `DEFAULT_SQUASH_MERGE_PROMPT_TEMPLATE` from `config/index.ts`.

**Files touched:**
- Deleted: `src/core/api/task-chat.ts`, `web-ui/src/components/open-workspace-button.tsx`
- Modified: `package.json`, `src/cli.ts`, `src/config/index.ts`, `src/core/api/index.ts`, `src/core/index.ts`, `src/state/index.ts`, `src/title/llm-client.ts`, `src/trpc/app-router-context.ts`, `src/trpc/workspace-api-git-ops.ts`, `src/trpc/workspace-api-state.ts`, `src/trpc/workspace-procedures.ts`, `web-ui/src/styles/utilities.css`, `test/runtime/title-generator.test.ts`

**Commit:** `82c5155d`

## Refactor: consolidate board rules behind the runtime board module (2026-04-17)

**What:** Refactored `web-ui/src/state/board-state.ts` so several browser-side wrappers now defer directly to `src/core/task-board-mutations.ts` instead of maintaining adjacent board-rule logic locally. `updateTask()` now builds a runtime update payload from the selected card and delegates to the runtime task updater; `removeTask()` and `clearColumnTasks()` now use `deleteTasksFromBoard()` for task/dependency cleanup; `toggleTaskPinned()` now routes through the runtime updater rather than mutating board cards inline. The follow-up cleanup in this slice also moved post-parse board canonicalization behind a new runtime helper, `canonicalizeTaskBoard()`: persisted dependency parsing in `board-state-parser.ts` now only trims and validates raw saved dependency records, while the runtime module owns the canonical rule pass that drops invalid links, reorients backlog-linked pairs, and removes duplicates after hydration. The browser file still owns browser-specific responsibilities: persisted-board parsing, drag/drop placement, browser UUID generation, and task metadata reconciliation (`branch`, `workingDirectory`).

**Why:** This completed the remaining board-related item from `docs/plan-csharp-readability-followups.md`. Before this change, readers still had to compare the runtime board mutation module with `web-ui/src/state/board-state.ts` to understand which task update/delete rules were authoritative. Delegating shared mutation behavior back to the runtime module makes ownership clearer: the core module is the canonical source of board mutation rules, and the browser layer is mostly an adapter around browser-only concerns.

**Files touched:**
- `src/core/task-board-mutations.ts` — added the runtime-owned `canonicalizeTaskBoard()` entry point for post-parse board cleanup
- `src/core/index.ts`, `src/state/workspace-state-index.ts` — exported and adopted the canonicalization helper so runtime hydration also reads through the named board-rules entry point
- `web-ui/src/state/board-state.ts` — routed task update/delete/pin wrappers and normalization cleanup through runtime board mutations
- `web-ui/src/state/board-state-parser.ts` — narrowed persisted dependency parsing to raw-record normalization instead of task-existence/domain cleanup
- `web-ui/src/state/board-state-mutations.test.ts`, `web-ui/src/state/board-state-normalization.test.ts`, `test/runtime/task-board-mutations.test.ts` — added regression coverage for the thinner browser adapters, parser boundary, and runtime canonicalization path
- `docs/todo.md` — removed the completed board-rule consolidation item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm --prefix web-ui run test -- board-state-mutations.test.ts board-state-dependencies.test.ts board-state-drag.test.ts board-state-normalization.test.ts`; `npm run test -- test/runtime/task-board-mutations.test.ts`; `npm --prefix web-ui run typecheck`

**Commit:** Pending user-requested commit (current HEAD: `b9f398b1`).

## Refactor: extract board-state parser/schema helpers (2026-04-17)

**What:** Refactored the persisted board hydration path in `web-ui/src/state/board-state.ts` by moving raw `unknown` parsing into a new companion module, `web-ui/src/state/board-state-parser.ts`. The new module defines named `zod`-backed parser helpers for persisted board payloads, cards, dependencies, and task images, while preserving the existing permissive normalization semantics such as trimmed prompt/base-ref requirements, generated fallback ids, nullable branch handling, and filtering invalid images/dependencies. Updated `normalizeBoardData()` to consume those helpers instead of inlining long manual shape checks, and expanded `board-state-normalization.test.ts` with direct parser coverage.

**Why:** This completed the next C# readability follow-up item from `docs/plan-csharp-readability-followups.md`. The old hydration path mixed persistence-contract parsing with board assembly logic, forcing readers to infer accepted payload shapes from repeated `typeof`, `Array.isArray`, and ad hoc casts. Extracting named parser/schema helpers makes the accepted persisted shape discoverable beside `board-state.ts` and leaves the browser board module smaller and easier to scan.

**Files touched:**
- `web-ui/src/state/board-state.ts` — replaced inline normalization helpers with calls into the new parser module
- `web-ui/src/state/board-state-parser.ts` — new companion parser/schema module for persisted board payloads
- `web-ui/src/state/board-state-normalization.test.ts` — added parser-focused regression coverage
- `docs/todo.md` — removed the completed board-state parser/schema readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm --prefix web-ui run test -- board-state-normalization.test.ts board-state-dependencies.test.ts`; `npm --prefix web-ui run typecheck`

**Commit:** Pending user-requested commit (current HEAD: `b9f398b1`).

## Refactor: extract App.tsx composition hooks (2026-04-17)

**What:** Refactored `web-ui/src/App.tsx` by moving three dense orchestration areas into named hooks under `web-ui/src/hooks/app/`: `use-app-side-effects.ts` (notification wiring, metadata sync, workspace persistence, hotkeys, cleanup, and pending-start effect), `use-app-action-models.ts` (card action callbacks, migrate dialog state, badge colors, detail session selection, and main-view/card-selection handlers), and `use-home-side-panel-resize.ts` (sidebar resize state + drag handling). Updated `hooks/app/index.ts` exports and rewired `App.tsx` to use the new composition hooks while keeping the JSX surface and provider structure intact.

**Why:** This completed the `App.tsx` readability item from the C# follow-up plan. `App.tsx` had accumulated several different responsibilities at once: context reads, global side effects, persistence wiring, callback assembly, badge derivation, and resize plumbing. Pulling those concerns into named hooks makes the file read more like a composition root and reduces the amount of local state a reader has to hold in their head.

**Files touched:**
- `web-ui/src/App.tsx` — removed large inline orchestration blocks and switched to the new composition hooks
- `web-ui/src/hooks/app/use-app-side-effects.ts` — new side-effect orchestration hook
- `web-ui/src/hooks/app/use-app-action-models.ts` — new action/view-model hook for card actions and app-level handlers
- `web-ui/src/hooks/app/use-home-side-panel-resize.ts` — new resize hook for the home side panel
- `web-ui/src/hooks/app/index.ts` — exported the new hooks
- `docs/todo.md` — removed the completed `App.tsx` readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Commit:** Pending user-requested commit (working tree only).

## Refactor: decompose CLI startup into named bootstrap phases (2026-04-17)

**What:** Refactored `src/cli.ts` so the runtime startup path is now expressed as a small pipeline of named helpers instead of one long `startServer()` function. Added helper functions for prefixed runtime warnings, lazy startup module loading, startup cleanup phases, orphaned agent cleanup, runtime bootstrap state creation, and runtime server handle creation. The lazy import boundary remains in place for command-style invocations, and the runtime startup order is unchanged.

**Why:** This completed the lowest-risk item from the C# readability follow-up plan. The existing startup logic was correct, but it required readers to scroll through one large procedural block to understand the boot sequence. The new helper structure makes the control flow more legible for developers used to bootstrapper/service initialization patterns.

**Files touched:**
- `src/cli.ts` — extracted the CLI startup pipeline into named helpers and simplified `startServer()`
- `docs/todo.md` — removed the completed CLI startup readability item from the C# follow-up section
- `CHANGELOG.md` — added an unreleased refactor entry for the CLI startup decomposition
- `docs/implementation-log.md` — recorded the change and rationale

**Commit:** Pending user-requested commit (working tree only).

## Feature: syntax highlighting in file browser (2026-04-17)

**What:** Added Prism-based syntax highlighting to two surfaces in the file browser: the plain code view (virtualized lines) and fenced code blocks inside the markdown preview.

**Why:** The diff viewer already had full Prism infrastructure (language resolution, grammar loading, token CSS). The file browser rendered plain monospace — adding highlighting was a small lift that reuses existing work.

**Approach:**

1. **File viewer code lines** (`file-content-viewer.tsx`): Resolves Prism language from file path via `resolvePrismLanguage`, builds a `highlightedLines` array in a `useMemo`, renders via `dangerouslySetInnerHTML` with the `kb-syntax` CSS class. Falls back to plain text for unsupported extensions.

2. **Markdown fenced code blocks** (`file-content-viewer.tsx`): Custom `MarkdownCodeBlock` component passed to react-markdown's `components.code` prop. Extracts the language from the `language-xxx` className, resolves via `resolvePrismLanguageByAlias` (handles short aliases like `ts`, `py`, `sh`), highlights with `Prism.highlight`.

3. **Shared infrastructure** (`syntax-highlighting.ts`, renamed from `diff-highlighting.ts`): Added `resolvePrismLanguageByAlias()` — checks `Prism.languages` directly for full names, falls back to `PRISM_LANGUAGE_BY_EXTENSION` for short aliases. Refactored `resolvePrismLanguage` to delegate to it internally. Re-exported through `diff-renderer.tsx` for backward compatibility.

4. **CSS** (`diff.css`): Collapsed duplicated token selectors using `:is(.kb-diff-text, .kb-syntax)` — reduced from 48 lines to 24. Adding future token groups now requires one rule, not two.

5. **Docs** (`ui-component-cheatsheet.md`): Updated stale path reference from `diff-highlighting.ts` to `syntax-highlighting.ts`.

**Files touched:**
- `web-ui/src/components/git/panels/file-content-viewer.tsx` — new imports, `MarkdownCodeBlock` component, `highlightedLines` memo, `dangerouslySetInnerHTML` rendering
- `web-ui/src/components/shared/syntax-highlighting.ts` — renamed from `diff-highlighting.ts`, added `resolvePrismLanguageByAlias`
- `web-ui/src/components/shared/diff-renderer.tsx` — updated import path, added `resolvePrismLanguageByAlias` re-export
- `web-ui/src/styles/diff.css` — collapsed token CSS with `:is()`, added `kb-syntax` class
- `docs/ui-component-cheatsheet.md` — updated stale path

**Verification:** TypeScript clean, Biome lint clean, all 86 web-ui test files / 787 tests pass.

## Fix: terminal restore snapshot renders at wrong dimensions (2026-04-16)

**What:** Fixed three related terminal rendering issues — garbled/half-wide content on initial connection, wrong dimensions after server restart, and post-restore scroll position jank.

**Why:** On initial connection (or after slot eviction), the server serialized the restore snapshot before the client's resize message updated the server-side `TerminalStateMirror`. The snapshot content was rendered at stale PTY dimensions (e.g. 120 cols instead of the actual container's 180 cols). Cursor-positioned output (agent status bars, prompts) doesn't reflow on client-side resize, so it stayed garbled. The "Re-sync terminal content" button in settings worked because by then the mirror was already at correct dimensions.

**Root cause:** Race condition between snapshot serialization and resize processing. `sendRestoreSnapshot()` calls `getSnapshot()` which awaits the mirror's operation queue. The client's resize message arrives on the same control socket but gets processed after the snapshot await started, so the resize operation is enqueued after `getSnapshot()` was already waiting — it serializes at old dimensions.

**Approach:**

1. **Server-side deferred snapshot** (`ws-server.ts`): Instead of calling `sendRestoreSnapshot()` immediately on control socket open, set a 100ms deferred timer. When the first resize message arrives, cancel the timer, apply the resize to the mirror (synchronously enqueuing onto the operation queue), then call `sendRestoreSnapshot()`. Since `getSnapshot()` awaits the queue, the resize executes before serialization. The 100ms fallback handles cases where no resize is needed (reconnecting idle sessions, dimensions already correct).

2. **Resize on control socket open** (`slot-socket-manager.ts`): Added `invalidateResize()` + `requestResize()` in the control socket `onopen` handler. `invalidateResize()` bumps the resize epoch so the request isn't deduped by `SlotResizeManager`. This ensures the server learns the actual container dimensions on every new connection — including after server restart or sleep/wake reconnect, where previously no resize was ever sent.

3. **Post-restore scroll guard** (`terminal-slot.ts`): Armed `pendingScrollToBottom` in `handleRestore()` after `scrollToBottom()`. The existing ResizeObserver callback in `SlotResizeManager` checks this one-shot flag and does fit+scroll synchronously, preventing a debounced reflow from undoing the scroll position after the terminal becomes visible. This is the same pattern `show()` already uses for the reveal path.

**Files touched:**
- `src/terminal/ws-server.ts` — deferred snapshot timer, resize-triggered snapshot, timer cleanup on socket close
- `web-ui/src/terminal/slot-socket-manager.ts` — invalidateResize + requestResize on control socket open
- `web-ui/src/terminal/terminal-slot.ts` — pendingScrollToBottom in handleRestore

## Refactor: runtime barrel exports (2026-04-16)

**What:** Added `index.ts` barrel files to 9 directories under `src/`: `core/`, `terminal/`, `workspace/`, `server/`, `config/`, `state/`, `trpc/`, `fs/`, `title/`. Each barrel re-exports the directory's public surface (types, classes, functions, constants used by files outside the directory). Updated ~150 import paths across `src/` and `test/` from specific module paths (e.g., `../core/api-contract`) to directory-level imports (e.g., `../core`). The original plan listed 8 directories; added `core/` (152 external imports, the most-imported directory) as a 9th. `commands/` (4 imports), `projects/` (0), and `prompts/` (1) were too low-traffic to justify barrels.

**Why:** Improve codebase navigability and reduce import path churn. With barrels, adding/renaming/moving a file within a directory doesn't require updating every external consumer — only the barrel. Matches the pattern already established on the frontend (`components/` and `hooks/` Phase 4 barrels).

**Vitest mock compatibility:** Three source files retain direct module imports instead of barrel imports: `src/fs/lock-cleanup.ts`, `src/workspace/task-worktree-lifecycle.ts`, `src/workspace/task-worktree-patch.ts`, and `src/terminal/claude-workspace-trust.ts`. Their test suites use `vi.mock()` targeting specific module paths (e.g., `../../src/state/workspace-state.js`). When the source imported through a barrel, vitest's module cache from prior tests in the same worker pool would supply the unmocked barrel module instead of the mock, causing test failures. Keeping direct imports for these files preserves mock isolation.

**Files touched:**
- 9 new `index.ts` barrel files (one per directory)
- ~85 source files in `src/` with updated import paths
- ~65 test files in `test/` with updated import paths
- `src/index.ts` — kept pointing at `./core/api-contract` (not `./core`) to preserve the package's intentionally narrow public API

**Verification:** TypeScript clean, Biome lint clean, all 72 test files / 700 tests pass.

## Refactor: git action toast helpers and useLoadingGuard (2026-04-16)

**Problem:** `use-git-actions.ts` (626 lines) and `use-branch-actions.ts` (520 lines) had extensive boilerplate: every `showAppToast` call specified `intent`, `icon`, `message`, and `timeout` inline, and every async mutation used a manual `useState(false)` + `if (isLoading) return` + `try/finally { setIsLoading(false) }` loading guard. The two files were inconsistent — `use-git-actions.ts` set `icon: "warning-sign"` on error toasts while `use-branch-actions.ts` omitted it; `use-git-actions.ts` used 7000ms timeouts while `use-branch-actions.ts` used Sonner's 5000ms default.

**Approach:** Two orthogonal helpers:

1. **Toast helpers** (`showGitErrorToast`, `showGitWarningToast`, `showGitSuccessToast`) in `hooks/git/git-actions.ts` — thin wrappers over `showAppToast` with standardized defaults (danger: `warning-sign` icon + 7000ms, success: no icon + 3000ms). The `showGitErrorToast` overload accepts an optional `action` button for the dirty-tree "Stash & Switch" case. Placed in `git-actions.ts` (the existing domain module) rather than a new file since the helpers are git-specific and the module already has pragmatic scope.

2. **`useLoadingGuard`** in `utils/react-use.ts` — returns `{ isLoading, run, reset }`. Uses both a `useRef` (synchronous double-click prevention — two rapid clicks could both see `isLoading === false` before either `setState` takes effect) and `useState` (for React re-renders). The return object is wrapped in `useMemo([isLoading, run, reset])` so identity only changes when `isLoading` flips, preventing cascading re-renders through dependency arrays. `reset()` is exposed for `resetGitActionState` which force-clears all loading flags on project switch.

**Files:** `web-ui/src/hooks/git/git-actions.ts` (+43 lines), `web-ui/src/hooks/git/use-git-actions.ts` (626→519 lines), `web-ui/src/hooks/git/use-branch-actions.ts` (520→493 lines), `web-ui/src/utils/react-use.ts` (+29 lines). Net ~56 line reduction. 787 web-ui tests pass, all typechecks clean.

## Extract `updateCardInBoard` helper — 2026-04-16

**What:** Added a private `updateCardInBoard(board, taskId, updater)` helper to `web-ui/src/state/board-state.ts` that encapsulates the repeated nested `columns.map → cards.map` pattern with `taskId` matching and `columnUpdated`/`updated` flag tracking. The updater callback returns a new `BoardCard` or `null` to signal no-op (for early-return-if-unchanged cases).

**Why:** Four functions (`updateTask`, `reconcileTaskWorkingDirectory`, `reconcileTaskBranch`, `toggleTaskPinned`) all duplicated the same 6-line scaffolding pattern. Completing a todo item from the runtime readability refactors plan.

**Files touched:**
- `web-ui/src/state/board-state.ts` — added `updateCardInBoard` helper (lines 60–80), refactored 4 call sites

**Verification:** TypeScript clean, all 67 board-state tests pass (5 test files).
