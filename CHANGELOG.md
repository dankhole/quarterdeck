# Changelog

## [Unreleased]

### Refactor: always show running-task stop/trash actions

- Removed the `showRunningTaskEmergencyActions` setting and its config/schema/settings wiring, so running task cards now always expose the stop/restart and trash escape hatches on hover instead of hiding them behind an opt-in toggle.

### Fix: harden Codex CLI detection with version gating

- Replaced the old "Codex binary exists on PATH" launch gate with a minimal compatibility check that still uses PATH for discovery but also runs `codex --version` and requires `0.30.0` or newer before Quarterdeck treats Codex as runnable.
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

> Prior entries (0.10.0 and earlier) in `docs/changelog-through-0.10.0.md`, `docs/changelog-through-0.9.4.md`, `docs/changelog-through-0.8.0.md`, and `docs/changelog-through-0.5.0.md`.
