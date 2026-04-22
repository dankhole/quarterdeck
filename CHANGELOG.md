# Changelog

## [Unreleased]

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

## [0.10.0] — 2026-04-20

### Fix: resolve all lint warnings and flaky integration test

- Replaced 11 non-null assertions (`!`) across `statusline.ts`, `session-summary-store.ts`, `terminal-protocol-filter.ts`, `get-workdir-changes.ts`, and `git-stash.ts` with safe alternatives (`as` narrowing after guards, `?? fallback` for regex captures).
- Removed unused `RuntimeStateStreamTransport` type import from `runtime-state-stream-transport.test.ts`.
- Fixed flaky `task-command-exit.integration.test.ts` — the "join existing server" CLI path relied on Node’s natural event-loop drain after the `open` package spawned a browser subprocess, but under parallel test load the subprocess Promise listeners kept the loop alive past the 8-second timeout. Changed the terminal early-return to an explicit `process.exit(0)`.

### Fix: make authoritative project sync apply from one atomic board/session snapshot

- Reworked `web-ui/src/hooks/project/use-project-sync.ts` so authoritative project-state application no longer reconciles sessions from one snapshot and projects board state from another. The hook now computes one authoritative apply result from the latest queued local board+sessions state, then uses that single result for board projection, session reconciliation, hydration flags, cache updates, and revision/persistence re-entry.
- Added `applyAuthoritativeProjectState()` in `web-ui/src/hooks/project/project-sync.ts` as the explicit browser-side entry point for authoritative project state. This preserves the split-brain refactor’s ownership model: the browser still owns durable board state, the server still owns runtime session truth, and the browser still projects runtime truth onto the `in_progress`/`review` boundary without reintroducing broad repair behavior.
- Moved the app shell onto a shared `board + sessions` state seam for project sync so `use-project-sync` can read the latest queued local state instead of stale refs. This keeps authoritative replacement, delta merge, and local reset/delete paths distinct instead of letting them overlap accidentally under timing pressure.
- Added focused regression coverage for the new authoritative apply helper and the updated hook path, then revalidated project sync, runtime stream, persistence, reconnect, and restart coverage.
- Followed up on review by removing the redundant outer revision guard in `use-project-sync.ts`, dropping the duplicated `reconciledSessions` field from the authoritative apply result, trimming unnecessary ref dependencies, and adding direct coverage for the `confirm_cache` + session-driven reprojection case.

### Refactor: make the task-state ownership join point explicit

- Added an explicit browser-side runtime-session projection for the `in_progress` ⇄ `review` work-column boundary, so authoritative project hydrate no longer depends on a later repair effect to reconcile board placement with server-owned session state.
- Updated project hydration persistence gating so a pure authoritative hydrate still skips the next save, while a hydrate that needed runtime-owned column projection persists that reconciliation through the normal single-writer UI path.
- Added focused regression coverage for the pure projection rules, authoritative project sync hydrate behavior, and the project-persistence gate that protects optimistic-concurrency semantics.
- Narrowed the public persistence contract so browser `project.saveState` calls now persist only board truth; the server snapshots authoritative sessions from the terminal/session store when it writes project state, eliminating the browser round-trip of `sessions`.
- Tightened reconnect/project-switch behavior so authoritative project snapshots replace the browser's session keyset by task ID, dropping stale cached/browser-only sessions while still tolerating older replays for the same task, and added restart/stream/trpc regression coverage around the new ownership boundary.
- Followed up on review by projecting hydrated boards from the reconciled authoritative session set instead of raw snapshot sessions, re-projecting same-revision cached/current boards when runtime session truth disagrees, and atomically pairing hydration nonce updates with the skip-persist flag.

### Refactor: separate runtime stream state application from transport policy

- Refactored `web-ui/src/runtime/use-runtime-state-stream.ts` into a thinner composition hook over `runtime-state-stream-store.ts`, `runtime-stream-dispatch.ts`, and `runtime-state-stream-transport.ts`, so the core “receive runtime messages and apply them” path is easier to identify without reading reconnect/preload policy inline.
- Made snapshot-vs-delta behavior explicit in the extracted store: preloaded state, initial snapshots, project-state refreshes, task-session deltas, and monotonic notification memory now live behind named helpers with focused unit coverage.
- Preserved current project/runtime sync behavior by keeping the stream contract intact and re-validating targeted runtime-stream and `use-project-sync` coverage plus frontend/backend typecheck.

### Fix: isolate pinned base ref to the active project

- Removed the `defaultBaseRef` fallback from project config to global config in `src/config/runtime-config-normalizers.ts`, so a stale or leftover global value can no longer leak a pinned base ref from one project into another.
- Preserved the intended no-pin behavior: when a project has no explicit `defaultBaseRef`, the frontend still falls back to per-project git default-branch detection instead of inheriting another project’s pin.

### Refactor: finish the remaining workflow-heavy UI surface cleanup

- Refactored `web-ui/src/components/task/task-create-dialog.tsx` into a clearer presentation shell by moving create-flow orchestration into `web-ui/src/hooks/board/use-task-create-dialog.ts` and a companion pure domain module `web-ui/src/hooks/board/task-create-dialog.ts`.
- Refactored `web-ui/src/components/git/panels/branch-selector-popover.tsx` into a slimmer popover shell by moving ref filtering, pinned/unpinned section resolution, and close-and-act orchestration into `web-ui/src/hooks/git/use-branch-selector-popover.ts` plus the pure companion module `web-ui/src/hooks/git/branch-selector-popover.ts`.
- Refactored `web-ui/src/components/task/card-detail-view.tsx` into a clearer composition boundary by extracting task-detail orchestration into `web-ui/src/hooks/board/use-card-detail-view.ts`, moving pure derivation logic into `web-ui/src/hooks/board/card-detail-view.ts`, and splitting the large render body into `task-detail-main-content.tsx` and `task-branch-dialogs.tsx`.
- Refactored `web-ui/src/components/board/board-card.tsx` so card rendering no longer owns as much interaction/derived-state policy directly; those responsibilities now live in `web-ui/src/hooks/board/use-board-card.ts` and `web-ui/src/hooks/board/board-card.ts`.
- Extracted create/edit draft reset and save/create board mutations from `web-ui/src/hooks/board/use-task-editor.ts` into the pure companion module `web-ui/src/hooks/board/task-editor-drafts.ts`, with focused regression coverage for the new pure workflow helpers.
- Removed the `Start in plan mode` control and create-path wiring from `web-ui/src/components/task/task-create-dialog.tsx`, so dialog-created tasks now always use the standard start flow while edit-mode plan-mode behavior remains unchanged.
- Updated task creation base-ref reset behavior so the create dialog always returns to the resolved project default base ref after create/cancel/reopen instead of remembering the last branch used in that project.
- Followed up on review feedback by moving the pure board-card display helpers out of `components/`, fixing a stale default-branch capture in `use-task-editor.ts`, stabilizing `use-branch-selector-popover.ts` action handlers, and tightening a redundant status-badge null branch in `board-card.tsx`.

### Refactor: reduce app-shell integration gravity around git history and edit-start flow

- Moved git-history ownership into `GitProvider`, so top-level app composition no longer threads raw git-history state/setters across `App.tsx`, `GitProvider`, and `InteractionsProvider`.
- Moved “save edited task, then auto-start it once it lands back in backlog” ownership into the board/interactions seam: `BoardProvider` now owns the pending edit-start state and `InteractionsProvider` consumes it where task-start workflow already lives.
- Replaced top-level task-editor reset reach-through with a board-owned `resetBoardUiState()` seam, making project-switch cleanup read more like provider reset choreography and less like app-shell ref plumbing.
- Tightened the follow-up timing/ownership semantics by making project-switch cleanup and git-history closure run in layout effects before paint, and by narrowing the edited-task auto-start effect to track only the pending task's column instead of every board change.

### Refactor: clarify runtime-state message semantics vs batching policy

- Refactored `src/server/runtime-state-message-batcher.ts` into explicit task-session event delivery plus dedicated task-session and debug-log batch queues, so the meaning of a runtime event is easier to inspect before the timer/coalescing policy.
- Preserved the existing websocket behavior: `task_sessions_updated`, `task_notification`, and project-summary refreshes still flush together on the existing task-session batch window, and debug log batching still uses its existing client-gated window.
- Added regression coverage for disposing a project while task-session updates are still queued, alongside targeted runtime-state and websocket integration validation.

### Fix: base branch resolution bugs

- Removed `develop` from the hard-coded candidate list in `resolveBaseRefForBranch` — it was winning over `main` in repos that have both, since it's often a closer ancestor. Users who want develop-based workflows set `defaultBaseRef` in project config.
- Fixed `detectGitDefaultBranch` returning a branch name from `origin/HEAD` even when that branch doesn't exist locally — now falls through to the `main`/`master`/first-branch fallback.
- Moved `defaultBaseRef` from global config (`~/.quarterdeck/config.json`) to per-project config (`.quarterdeck/config.json` in the project dir) so each project gets its own default base branch. Reads from global config as fallback for migration.

### Fix: "Mute focused project" suppresses sounds even when tab/browser is unfocused

- Per-project sound suppression (`isEventSuppressedForProject`) now checks tab visibility before suppressing — if the user isn't looking at the board, the "currently viewed project" concept doesn't apply and sounds play normally.

### Fix: base ref dropdown loads branches independently

- Fixed the top bar base-ref dropdown showing an empty branch list on first open — it now triggers its own branch fetch via `requestBranches()` instead of relying on the main branch pill popover having been opened first.
- Added a loading spinner to the base-ref dropdown while branches are being fetched.
- Fixed stale branches from a previous project appearing after project switch — `useTrpcQuery` now clears cached data when the query becomes disabled.
- Added background fill and padding to the base-ref trigger button so it's readable when active.

### Refactor: tighten project metadata monitor mutation ownership and freshness

- Moved project-metadata writes behind `ProjectMetadataController` commit semantics so `ProjectMetadataRefresher` now loads results and asks the controller to apply them instead of mutating the shared project entry directly.
- Made task metadata commits freshness-aware: a full-project refresh now applies a task result only if that task has not received a newer targeted/identity-changing write since the full refresh began, preventing stale full-refresh results from overwriting newer focused/manual task metadata.
- Kept the runtime stream contract, focused/background refresh behavior, branch/base-ref follow-ups, disconnect-driven churn shutdown, and shared `p-limit(3)` git probe cap intact while adding direct regression coverage for the stale overwrite race in `test/runtime/server/project-metadata-monitor.test.ts`.

### Refactor: clarify authoritative project sync vs cached board restore

- Refactored `web-ui/src/hooks/project/use-project-sync.ts` so authoritative runtime project-state application is now explicit and cache restore is tracked as a subordinate display policy instead of mutating the same revision model that drives persistence gating.
- Updated `web-ui/src/runtime/project-board-cache.ts` to store the authoritative revision a cached board was last aligned with, making it clearer that a restored board can be shown optimistically without being treated as authoritative for persistence.
- Added project-sync regression coverage for cached restore confirmation and stale previous-project updates during switches, alongside updated pure-domain tests for the authoritative board-application policy.

### Fix: terminal scroll-before-visible on task switch

- Fixed terminal revealing stale buffer at wrong scroll position when switching back to a previously-viewed task. `requestRestore()` now clears `restoreCompleted` so `show()` defers reveal until the fresh snapshot arrives with proper bottom-scroll positioning.

### Fix: terminal scroll-to-bottom on task load/untrash

- Fixed a race condition where the terminal would not scroll to the bottom when a task was first loaded (most noticeable after untrashing). The ResizeObserver could consume the `pendingScrollToBottom` flag before the reveal animation frame fired, leaving the terminal visible at the wrong scroll position.
- Removed a now-redundant non-initial-fit scroll block from the ResizeObserver callback in `SlotResizeManager`.

### Docs: flesh out next-wave refactor roadmap context

- Added `docs/refactor-roadmap-context.md`, a structured pickup guide for the current next 9 refactors after the recent terminal websocket bridge and project metadata monitor work.
- Linked the roadmap context from `docs/todo.md` and `docs/README.md`, and added concrete todo items for the broader design-roadmap work that previously existed only as high-level architectural ranking.

### Docs: capture project metadata monitor post-refactor follow-ups

- Added `docs/project-metadata-monitor-followups.md` to record the two remaining metadata-monitor follow-ups that surfaced after the refactor: shared mutable `ProjectMetadataEntry` coupling and `refreshProject()` vs per-task refresh overwrite races.
- Linked the new follow-up doc from `docs/README.md` and added a fresh todo entry in `docs/todo.md` so those architectural questions stay visible without reopening the completed refactor brief.

### Refactor: split project metadata monitor ownership from refresh policy

- Refactored `src/server/project-metadata-monitor.ts` into a thin registry/facade over `project-metadata-controller.ts`, `project-metadata-refresher.ts`, `project-metadata-poller.ts`, and `project-metadata-remote-fetch.ts`, so per-project metadata state/lifecycle is separated from polling cadence and remote-fetch freshness policy.
- Replaced module-scoped refresh/fetch guards with per-project dedupe while preserving the shared `p-limit(3)` git probe concurrency cap across all connected projects.
- Unified manual `requestTaskRefresh()` with the same per-task refresh path used by focused/background refreshes, including branch-change base-ref detection for non-focused tasks.
- Added `test/runtime/server/project-metadata-monitor.test.ts` to lock in multi-project independence, focused-vs-background cadence, manual task refresh behavior, and remote-fetch follow-up refresh behavior alongside the existing runtime stream integration coverage.

### Docs: add project metadata monitor refactor brief

- Added `docs/project-metadata-monitor-refactor-brief.md`, a dedicated design brief for refactoring `src/server/project-metadata-monitor.ts` so metadata ownership can be separated from polling cadence, focused/background prioritization, and remote-fetch policy without losing current stream semantics.
- Linked the new brief from `docs/README.md`, `docs/optimization-shaped-architecture-followups.md`, and the active todo item in `docs/todo.md`.

### Refactor: terminal websocket bridge ownership / policy split

- Split `src/terminal/ws-server.ts` into a thinner websocket orchestrator plus focused collaborators: `terminal-ws-connection-registry.ts`, `terminal-ws-output-fanout.ts`, `terminal-ws-restore-coordinator.ts`, `terminal-ws-backpressure-policy.ts`, `terminal-ws-protocol.ts`, and `terminal-ws-types.ts`.
- Preserved the existing terminal websocket behavior while making the bridge read task-stream ownership first and transport policy second: multi-viewer fanout, same-`clientId` socket replacement, restore-after-resize timing, restore-gap buffering, shared PTY pause/resume, and `recoverStaleSession(taskId)` on connect all remain intact.
- Expanded `test/runtime/terminal/ws-server.test.ts` to cover restore timing, restore-gap buffering, same-client socket replacement, last-viewer backpressure disconnect resume, and invalid control payload handling.

### Docs: terminal websocket bridge refactor brief

- Added `docs/terminal-ws-server-refactor-brief.md` — a dedicated planning brief for refactoring `src/terminal/ws-server.ts` without changing runtime behavior. It captures current responsibilities, transport-vs-policy boundaries, multi-viewer/backpressure/restore invariants, proposed backend module split, rollout order, acceptance criteria, and migration risks.
- Linked the new brief from the refactor docs map, the optimization-shaped architecture follow-up tracker, and the todo section that tracks this work.

### Fix: task switch and untrash terminal width/scroll restoration

- Reused pooled task terminals now request a fresh server restore snapshot whenever a non-active warm slot is promoted back to the visible task view. This makes normal task switches use the same repair path as the manual "Re-sync terminal content" action instead of showing stale hidden-slot geometry.
- Restored task terminals now defer reveal until a post-layout resize pass runs, reducing half-width first-frame rendering during untrash/remount flows and preserving bottom scroll before the terminal becomes visible.
- Added focused pool-acquire regression coverage to lock in restore-on-promotion behavior for `READY`, `PRELOADING`, and `PREVIOUS` task slots.

### Fix: untrash does not always restart agent session

- Untrashing a card while another card animation was in flight silently failed — `handleRestoreTaskFromTrash` bailed on `"blocked"` without ever calling `resumeTaskFromTrash`, leaving the card stuck in trash with no feedback.
- Resume fallback restart was gated on non-zero exit code — if `--continue` exited cleanly (code 0) because the conversation was garbage-collected, the session stayed dead in `awaiting_review` with no recovery path.

### Enhancement: restart button on review cards

- Hovering a review card with a live session now shows the restart button — previously only shown for dead/failed sessions. Matches the stop & trash pattern on running cards so users can restart a session from review without moving it back to in-progress first.

### Feature: single-tab guard

- Prevents multiple browser tabs from running Quarterdeck against the same server simultaneously. A second tab sees a "Quarterdeck is open in another tab" screen with a "Use here instead" button to transfer ownership. Uses localStorage heartbeat + BroadcastChannel — scoped per origin, so dogfood runs on different ports are unaffected.

### Fix: truncate schema validation errors in state file logging

- `formatSchemaIssues` now caps output at 5 issues with a `(N more)` suffix — prevents shutdown logs from dumping hundreds of identical validation errors when a stale `sessions.json` has many entries with the same missing/invalid field.

### Fix: base ref dropdown shows "(default)" only when explicitly pinned

- The base ref dropdown no longer labels the git-detected default branch (e.g. `main`) with "(default)" unless the user has explicitly pinned it via the pin icon. Previously, the auto-detected git default always showed the "(default)" suffix, implying the user had set it.

### Housekeeping: remove stale todo items

- Removed "Investigate and fix statusline counters vs task card stats" and "Audit default branch resolution" from the todo list.

### Enhancement: ghost-until-open base ref branch selector

- Base ref branch dropdown in inline task creation now renders transparent until clicked, reducing visual noise in the create card. The task creation dialog keeps the standard button style.

### Fix: ghost-until-open scope

- Removed `ghostUntilOpen` from the task creation dialog — the ghost style was only intended for the inline create card in the top bar, not full dialogs where the dropdown should remain visible.

### Docs: refactor agent instruction docs around AGENTS.md

- Established `AGENTS.md` as the canonical shared agent-instructions file — slimmed `CLAUDE.md` from ~140 lines to an 11-line compatibility shim that imports `@AGENTS.md` and points to human-facing docs.
- Moved duplicated content (quick reference, repo orientation, CI/CD notes) from `CLAUDE.md` to `DEVELOPMENT.md` and `README.md` where it belongs.
- Added `scripts/check-agent-instructions.mjs` — validates the AGENTS.md/CLAUDE.md bridge invariants (canonical heading, shim shape, no code blocks, line cap). Wired into `npm run check`.
- Rewrote the Codex todo section — replaced the monolithic status dump with four focused, actionable items reflecting Codex's native hook support.
- Updated worktree system prompt example to reference `AGENTS.md` instead of `CLAUDE.md`.

### Refactor: fix workspace→project/worktree rename oversights

- Fixed identifiers that were renamed from "workspace" to "project" but should have been "worktree" (per-task git worktree metadata): `RuntimeTaskProjectMetadata` → `RuntimeTaskWorktreeMetadata`, `TrackedTaskProject` → `TrackedTaskWorktree`, `CachedTaskProjectMetadata` → `CachedTaskWorktreeMetadata`, `loadTaskProjectMetadata` → `loadTaskWorktreeMetadata`, `ReviewTaskProjectSnapshot` → `ReviewTaskWorktreeSnapshot`, and all associated store hooks/functions.
- Fixed remaining stale "workspace" identifiers: `WORKSPACE_STATE_FILENAMES` → `PROJECT_STATE_FILENAMES`, `WORKSPACE_STATE_PERSIST_DEBOUNCE_MS` → `PROJECT_STATE_PERSIST_DEBOUNCE_MS`, `WORKSPACE_ID` → `PROJECT_ID` in test fixture, `NOOP_FETCH_WORKSPACE_INFO` → `NOOP_FETCH_WORKTREE_INFO`.
- Fixed stale `createWorkspaceTrpcClient` reference in biome.json lint rule (function was already renamed to `createProjectTrpcClient`).

### Refactor: terminal architecture split into session / viewport / attachment / reuse / prewarm layers

- Extracted `terminal-session-handle.ts`, `terminal-viewport.ts`, `terminal-attachment-controller.ts`, `terminal-reuse-manager.ts`, and `terminal-prewarm-policy.ts` so terminal correctness is separated more clearly from optimization policy.
- Slimmed `terminal-slot.ts` into a compatibility wrapper over the new layers while preserving reconnect, restore, quick switch-back, and buffer inspection behavior.
- Split shell-vs-agent terminal UI surfaces via `shell-terminal-panel.tsx` and `persistent-terminal-panel-layout.tsx`, keeping dedicated shell behavior distinct from pooled task agent terminals.
- Moved app-facing pooled terminal consumers off raw pool verbs and behind reuse/policy seams, so prewarm can be replaced or disabled for testing/measurement without changing correctness paths.

### Refactor: app shell component decomposition and design guardrails

- Decomposed `project-navigation-panel.tsx` (679L → 74L) into `project-navigation-list.tsx`, `project-navigation-row.tsx`, `project-navigation-removal-dialog.tsx`, and `project-navigation-sidebar-sections.tsx`.
- Decomposed `top-bar.tsx` (624L → 176L) into `top-bar-scope-section.tsx`, `top-bar-project-shortcut-control.tsx`, `top-bar-prompt-shortcut-control.tsx`, and `git-branch-status-control.tsx`.
- Added design guardrails doc, design weaknesses roadmap, optimization-shaped architecture follow-ups, and terminal architecture refactor brief.
- Fixed pre-existing type error in `orphan-cleanup.ts` (`comm` possibly undefined).
- Completed the `isWorkspacePathLoading` → `isProjectPathLoading` prop rename across `TopBar` and `ConnectedTopBar`.

### Refactor: rename "workspace" to "project" throughout codebase

- Unified the state-container concept under "project" — the backend previously used "workspace" while the UI/API layer used "project", causing confusion. All types, files, functions, variables, API routes, wire protocol strings, HTTP headers, and on-disk paths now consistently use "project".
- Renamed `src/workspace/` to `src/workdir/` with updated function names (`*Workspace*` → `*Workdir*`) for working directory operations. Agent workspace trust files (`claude-workspace-trust.ts`, etc.) intentionally unchanged — "workspace" is the agent's own terminology.
- On-disk state path changed from `~/.quarterdeck/workspaces/` to `~/.quarterdeck/projects/`. Manual migration: `cp -r ~/.quarterdeck/workspaces ~/.quarterdeck/projects` and rename `workspaceId` to `projectId` in `index.json`.
- Completed remaining renames across 106 files: `notificationWorkspaceIds` → `notificationProjectIds`, `cleanupTaskWorkspace` → `cleanupTaskWorktree`, `disposeTrackedWorkspace` → `disposeTrackedProject`, `SearchWorkspaceTextOptions` → `SearchWorkdirTextOptions`, `@runtime-task-worktree-path` alias fix, plus full sweep of all remaining workspace→project/worktree/workdir identifiers, string literals, comments, Zod messages, env vars (`QUARTERDECK_HOOK_WORKSPACE_ID` → `QUARTERDECK_HOOK_PROJECT_ID`), and test fixtures.

### Feature: file finder (Cmd+P) and text search (Cmd+Shift+F)

- Added two VS Code-style search overlays — file finder (Cmd+P) for fuzzy filename search and text search (Cmd+Shift+F) for full-text grep across the workspace. Both open as centered floating panels with keyboard navigation (arrow keys, Enter, Escape) and outside-click dismiss.
- File finder uses the existing `workspace.searchFiles` endpoint with 150ms debounce and request-ID race protection. Text search uses a new `workspace.searchText` endpoint backed by `git grep`, with case sensitivity and regex toggles, results grouped by file with match highlighting, and truncation at 100 matches.
- Selecting a result in either modal opens the file in the file content viewer via the existing `pendingFileNavigation` mechanism. Both modals are only active when a workspace is selected and close on project switch.
- Follow-up fixes from sanity review: added request-ID race protection to text search hook, replaced mutable render-time counter with precomputed `useMemo` array for flat-index mapping, removed dead `onDismiss` parameter from hook interfaces, stabilized Escape listener with ref to avoid re-registration on every render.

### Feature: scroll-to-line on text search result click

- Clicking a text search result now scrolls the file content viewer to the matched line. The line number is passed through `pendingFileNavigation` to `FileContentViewer`, which calls `scrollToIndex()` on the virtualizer after the file loads.

### Enhancement: notification muting — "Mute project viewed"

- Renamed "Mute focused project" to "Mute project viewed" in the notification settings grid.
- Per-project notification suppression now only applies while the tab is visible — sounds always play when the user has tabbed away, even for the viewed project.
- Defaulted review event suppression to `true` for new users — review sounds are muted for the project you're actively watching, reducing noise without missing anything.

### Chore: dead code cleanup

- Deleted orphaned `task-chat.ts` API contract (unimplemented feature) and `OpenWorkspaceButton` component (unused).
- Removed dead `getGitSummary` and `notifyStateUpdated` tRPC procedures — full chain through router, context interface, and factory functions.
- Removed deprecated `mcp` and `update` CLI command stubs.
- Removed legacy `QUARTERDECK_TITLE_MODEL` env var alias — use `QUARTERDECK_LLM_MODEL` instead.
- Removed unused `neverthrow` and `mitt` npm dependencies.
- Removed dead `.kb-line-clamp-2` / `.kb-line-clamp-5` CSS classes.
- Pruned barrel re-exports with no external consumers from `core/`, `state/`, and `config/` index files.

### Fix: terminal restore snapshot renders at wrong dimensions

- Deferred the initial restore snapshot on the server until the client's first resize message arrives (100ms timeout fallback). Previously, the snapshot was serialized before the resize updated the server-side mirror, causing cursor-positioned content (status bars, prompts) to appear garbled or half-wide.
- Added resize-on-connect to the control socket open handler — every new control socket connection now sends the client's current terminal dimensions to the server. Fixes terminals rendering at default PTY dimensions after server restart or sleep/wake reconnect.
- Armed `pendingScrollToBottom` in the restore handler to prevent a debounced ResizeObserver callback from undoing the scroll position after the terminal becomes visible.

### Feature: syntax highlighting in file browser

- Added Prism syntax highlighting to the file content viewer — code lines are highlighted using the same language/grammar resolution and token theme already used by the diff viewer. Fenced code blocks in the markdown preview are also highlighted via a custom `code` component.
- Renamed `diff-highlighting.ts` → `syntax-highlighting.ts` to reflect shared usage across diffs, file viewer, and markdown preview. Added `resolvePrismLanguageByAlias()` for resolving short language aliases (`ts`, `py`, `sh`, `yml`) used in markdown fences.
- Collapsed duplicated Prism token CSS selectors using `:is()` — adding future token groups is now a single rule instead of a duplicated pair.

### Refactor: runtime barrel exports

- Added `index.ts` barrel files to 9 runtime directories (`core/`, `terminal/`, `workspace/`, `server/`, `config/`, `state/`, `trpc/`, `fs/`, `title/`) — each re-exports the directory's public surface. Updated ~150 import paths across `src/` and `test/` to use directory-level imports instead of specific module paths. Three source files (`lock-cleanup.ts`, `task-worktree-lifecycle.ts`, `task-worktree-patch.ts`, `claude-workspace-trust.ts`) retain direct imports to preserve vitest mock compatibility.

### Refactor: git action toast helpers and loading guard

- Added `showGitErrorToast`/`showGitWarningToast`/`showGitSuccessToast` helpers to `hooks/git/git-actions.ts` — standardize icon, intent, and timeout defaults across all git toast calls. Normalized `use-branch-actions.ts` error toasts to include `warning-sign` icon and 7s timeout (previously inconsistent with `use-git-actions.ts`).
- Added `useLoadingGuard` hook to `utils/react-use.ts` — replaces the repeated `useState(false)` + `try/finally` pattern with a ref-guarded async wrapper that prevents double-clicks and auto-resets. Includes `reset()` for force-clearing on project switch.
- Applied both to `use-git-actions.ts` (626→515 lines) and `use-branch-actions.ts` (520→493 lines). Net ~56 line reduction across the two hooks.

### Refactor: split terminal slot hosting and visibility lifecycle

- Refactored `web-ui/src/terminal/terminal-slot.ts` so the main class now reads primarily as terminal orchestration. Constructor/setup work is grouped behind named helper methods for xterm creation, addon wiring, socket/write-queue setup, and restore handling.
- Added `slot-dom-host.ts` to own the persistent parking-root host element, stage-container attachment, reveal/hide behavior, and parking transitions. Added `slot-visibility-lifecycle.ts` to own the tab-visibility refresh and reconnect-on-return behavior that previously lived inline in `TerminalSlot`.
- Added focused regression coverage for the extracted collaborators and kept the existing terminal pool/session tests green to verify that reconnect, restore, and hosting behavior stayed stable.

### Refactor: split dedicated terminal registry from terminal pool

- Kept the shared-slot allocation and lifecycle state machine in `web-ui/src/terminal/terminal-pool.ts`, where the `FREE/PRELOADING/READY/ACTIVE/PREVIOUS` policy and eviction invariants are easier to inspect together.
- Extracted dedicated-terminal ownership into `web-ui/src/terminal/terminal-dedicated-registry.ts`, separating the home/detail terminal registry from shared pool allocation and making the pool module read more clearly as shared-slot policy plus cross-terminal utilities.

### Refactor: extract `updateCardInBoard` helper in board-state

- Extracted repeated nested `columns.map → cards.map` pattern into a single `updateCardInBoard` helper. Refactored `updateTask`, `reconcileTaskWorkingDirectory`, `reconcileTaskBranch`, and `toggleTaskPinned` to use it. ~33 line net reduction, zero behavior changes.

### Refactor: decompose CLI startup into named bootstrap phases

- Split `src/cli.ts` startup flow into focused helpers for lazy runtime module loading, startup cleanup, orphaned-agent cleanup, runtime bootstrap state, and runtime server handle creation. Preserved the existing lazy import boundary and startup behavior while making `startServer()` read as a small bootstrap pipeline.

### Refactor: extract App.tsx composition hooks

- Broke `web-ui/src/App.tsx` orchestration into named app hooks for side effects, card action models, and home side-panel resize. The render tree stays intact, but the top-level app component now reads more like a composition root and less like a merged effect/callback registry.

### Refactor: extract board-state parser/schema helpers

- Moved the persisted board hydration path in `web-ui/src/state/board-state.ts` into a companion `board-state-parser.ts` module built around named `zod` schemas and parser helpers for board payloads, cards, dependencies, and task images. Behavior stays the same, but the browser normalization flow now reads as parse-and-assemble instead of inline `unknown` inspection. Added direct parser coverage in the board-state normalization tests.

### Refactor: consolidate board rules behind the runtime board module

- Trimmed `web-ui/src/state/board-state.ts` so task update, task deletion, column clearing, pinned-state toggling, and post-parse dependency cleanup all delegate to `src/core/task-board-mutations.ts` instead of re-implementing nearby board rules in the browser layer. Persisted dependency parsing now only normalizes raw saved records; the runtime module canonically drops invalid links, reorients backlog-linked pairs, and dedupes adjacent dependency concepts after hydration. The browser module keeps parsing, drag/drop placement, and metadata reconciliation concerns. Added regression coverage for the thinner browser adapters and the runtime-owned board canonicalization path.

### Refactor: slim project navigation panel composition

- Moved project sidebar orchestration into `useProjectNavigationPanel`, consolidating optimistic reorder state, drag/drop handling, removal confirmation state, and needs-input badge counts behind a named project hook.
- Split the render surface in `project-navigation-panel.tsx` into smaller view sections for the draggable list and portal-backed drag row, so the main component now reads as UI composition instead of mixed controller/render logic.
- Added focused hook coverage for approval-count derivation, optimistic reorder reset, and removal confirmation flow.

### Refactor: split runtime state hub coordination

- Split `src/server/runtime-state-hub.ts` into a slimmer coordinator plus two focused collaborators: `runtime-state-client-registry.ts` now owns websocket client registration, workspace-scoped tracking, and cleanup, while `runtime-state-message-batcher.ts` owns task-summary and debug-log batching. Public hub behavior, websocket payload shapes, and workspace disposal semantics stay the same.
- Added targeted server-side unit coverage for the extracted registry and batching helpers, including workspace client disconnect cleanup and summary/debug-log batch timing.

> Prior entries (0.9.4 and earlier) in `docs/changelog-through-0.9.4.md`, `docs/changelog-through-0.8.0.md`, and `docs/changelog-through-0.5.0.md`.
