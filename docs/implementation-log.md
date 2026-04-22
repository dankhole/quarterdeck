# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Project/worktree identity normalization contract + UI slice (2026-04-22)

Expanded the project/worktree identity refactor from an initial `web-ui` display cleanup into a shared runtime-contract normalization pass. The key clarification is now explicit in both the contract and the UI vocabulary: Quarterdeck has a project root path, an assigned task path/git identity, and a session launch path, and those are not interchangeable. This pass keeps the useful session-location signal while stopping the runtime/session API from pretending it is generic “project path” identity. It also intentionally does **not** invent a fake live-cwd field; there is still no authoritative continuously streamed runtime-location signal for task agents.

**What changed:**

- Added `web-ui/src/utils/task-identity.ts` plus focused unit coverage in `web-ui/src/utils/task-identity.test.ts`. That module now normalizes task identity into explicit fields:
  - `projectRootPath`
  - `assignedPath`
  - `assignedBranch`
  - `assignedHeadCommit`
  - `assignedIsDetached`
  - `displayBranchLabel`
  - `isAssignedShared`
  - `sessionLaunchPath`
  - `isSessionLaunchShared`
  - `isSessionLaunchDiverged`
- Renamed the shared runtime session-summary field to `RuntimeTaskSessionSummary.sessionLaunchPath` in `src/core/api/task-session.ts`. The schema still accepts legacy persisted `projectPath` when loading older `sessions.json` files, so restart/persistence flows remain compatible while new code speaks the clearer vocabulary.
- Updated terminal/runtime plumbing to use the renamed field consistently:
  - `src/terminal/session-summary-store.ts`
  - `src/terminal/session-lifecycle.ts`
  - `src/trpc/handlers/start-task-session.ts`
  - `src/trpc/hooks-api.ts`
  - `web-ui/src/hooks/board/use-task-sessions.ts`
- Explicitly documented the important caveat that `RuntimeTaskSessionSummary.sessionLaunchPath` is not a continuously updated live cwd; it is the path the current agent session was launched in. The helper keeps that signal available for “this session started somewhere unexpected” warnings without letting it masquerade as assigned task identity.
- Switched `web-ui/src/hooks/board/board-card.ts` and `web-ui/src/components/board/board-card.tsx` to use the shared task-identity model for:
  - branch display fallback
  - shared-vs-isolated assignment badge
  - session-path divergence warning
  This is the clearest place where the old conflation showed up: a task can still be intentionally assigned to an isolated worktree even if the running session was launched from the home repo. The UI now models those as separate facts instead of one ambiguous “shared” state.
- Switched task-scoped branch/folder consumers to the same shared vocabulary:
  - `web-ui/src/providers/git-provider.tsx` top-bar branch label
  - `web-ui/src/hooks/app/use-navbar-state.ts` task folder path selection
  - `web-ui/src/hooks/board/use-card-detail-view.ts` task branch actions + branch-pill derivation
  - `web-ui/src/components/task/task-detail-repository-surface.tsx` task git/files branch display and file-browser root path
  - `web-ui/src/hooks/git/use-git-view-compare.ts` default task compare source ref
- Added regression coverage in:
  - `web-ui/src/components/board/board-card.test.tsx`
  - `web-ui/src/components/task/task-detail-repository-surface.test.tsx`
  - `web-ui/src/utils/task-identity.test.ts`
- Updated the broader runtime/frontend fixture surface so shared session-summary vocabulary is consistent in persistence, restart, shutdown, hook, notification, board-sync, and terminal tests/helpers rather than leaving the old field name hidden in factories.
- Verified the slice with:
  - `npm --prefix web-ui run test -- --run src/utils/task-identity.test.ts src/components/board/board-card.test.tsx src/components/task/task-detail-repository-surface.test.tsx`
  - `npm test -- --run test/runtime/trpc/runtime-api.test.ts test/runtime/trpc/project-api-state.test.ts test/runtime/trpc/project-api-changes.test.ts test/runtime/terminal/session-manager-shell.test.ts test/integration/project-state.integration.test.ts test/integration/server-restart.integration.test.ts test/runtime/core/task-indicators.test.ts test/runtime/trpc/hooks-api/permission-guard.test.ts`
  - `npm run web:typecheck`
  - `npm run typecheck`

**Why:** The user-facing bugs around wrong task branch pills, wrong task folder display, and confusing “shared” state were symptoms of the same modeling problem: code across the runtime and UI was not always choosing intentionally between assigned identity and session location. Renaming the shared session field removes one of the worst vocabulary traps, and the task-scoped UI now uses the assigned-vs-session distinction intentionally. This pass still does not rewrite every metadata consumer or add a true live-cwd stream, but it establishes the shared vocabulary and an end-to-end pattern for future slices.

**Files touched:**

- `AGENTS.md`
- `src/core/api/task-session.ts`
- `src/terminal/session-lifecycle.ts`
- `src/terminal/session-summary-store.ts`
- `src/trpc/handlers/start-task-session.ts`
- `src/trpc/hooks-api.ts`
- `test/integration/project-state.integration.test.ts`
- `test/integration/server-restart.integration.test.ts`
- `test/integration/shutdown-coordinator.integration.test.ts`
- `test/runtime/core/task-indicators.test.ts`
- `test/runtime/server/runtime-state-message-batcher.test.ts`
- `test/runtime/shutdown-coordinator-timeout.test.ts`
- `test/runtime/terminal/session-manager-interrupt-recovery.test.ts`
- `test/runtime/terminal/session-manager-reconciliation.test.ts`
- `test/runtime/terminal/session-manager-shell.test.ts`
- `test/runtime/terminal/session-manager.test.ts`
- `test/runtime/terminal/session-reconciliation.test.ts`
- `test/runtime/terminal/session-state-machine.test.ts`
- `test/runtime/terminal/ws-server.test.ts`
- `test/runtime/trpc/hooks-api/_helpers.ts`
- `test/runtime/trpc/project-api-changes.test.ts`
- `test/runtime/trpc/project-api-state.test.ts`
- `test/runtime/trpc/runtime-api.test.ts`
- `web-ui/src/components/board/board-card.test.tsx`
- `web-ui/src/components/board/board-card.tsx`
- `web-ui/src/components/task/task-detail-repository-surface.test.tsx`
- `web-ui/src/components/task/task-detail-repository-surface.tsx`
- `web-ui/src/hooks/app/use-navbar-state.ts`
- `web-ui/src/hooks/board/board-card.ts`
- `web-ui/src/hooks/board/card-detail-view.ts`
- `web-ui/src/hooks/board/session-column-sync.test.ts`
- `web-ui/src/hooks/board/use-review-auto-actions.test.tsx`
- `web-ui/src/hooks/board/use-task-sessions.test.tsx`
- `web-ui/src/hooks/board/use-task-sessions.ts`
- `web-ui/src/hooks/board/use-card-detail-view.ts`
- `web-ui/src/hooks/git/use-git-view-compare.ts`
- `web-ui/src/hooks/notifications/audible-notifications-test-utils.tsx`
- `web-ui/src/hooks/notifications/audible-notifications.test.ts`
- `web-ui/src/hooks/notifications/project-notifications.test.ts`
- `web-ui/src/hooks/project/project-sync.test.ts`
- `web-ui/src/hooks/project/use-project-sync.test.tsx`
- `web-ui/src/hooks/terminal/use-terminal-panels.test.tsx`
- `web-ui/src/providers/git-provider.tsx`
- `web-ui/src/runtime/runtime-state-stream-store.test.ts`
- `web-ui/src/utils/app-utils.tsx`
- `web-ui/src/utils/session-status.test.ts`
- `web-ui/src/utils/session-summary-utils.test.ts`
- `web-ui/src/utils/task-identity.test.ts`
- `web-ui/src/utils/task-identity.ts`
- `docs/todo.md`
- `CHANGELOG.md`
- `docs/implementation-log.md`

## Feature: agent terminal row multiplier config field (2026-04-22)

Added a user-facing `agentTerminalRowMultiplier` config field (default 5, range 1–20) that inflates the PTY row count reported to agent processes. The browser xterm.js viewport stays at its real pixel-derived height, but the PTY process believes the terminal is N× taller, causing agents to emit more content per “screen” before pausing or paginating.

**What changed:**

- `src/config/global-config-fields.ts`: Added `agentTerminalRowMultiplier` to the field registry (default 5, `numField`).
- `src/core/api/config.ts`: Added `z.number()` to the response schema and `z.number().min(1).max(20).optional()` to the save request schema.
- `src/terminal/session-manager-types.ts`: Added `agentTerminalRowMultiplier` to `StartTaskSessionRequest`, `ActiveProcessState`, and `CreateActiveProcessStateOptions` so the multiplier is stored per-session and available during resize.
- `src/terminal/session-lifecycle.ts`: `spawnTaskSession` reads `request.agentTerminalRowMultiplier` and applies it to the normalized rows. Passes the multiplier into `createActiveProcessState`. `spawnShellSession` is unchanged.
- `src/terminal/session-manager.ts`: `resize()` reads the multiplier from the active session state instead of hardcoding.
- `src/trpc/handlers/start-task-session.ts`, `src/trpc/handlers/migrate-task-working-directory.ts`, `src/server/project-registry.ts`: Thread the config field into `startTaskSession` requests.
- `web-ui/src/components/settings/display-sections.tsx`: Refactored `FontWeightInput` into a generic `NumericSettingsInput` and added an “Agent row multiplier” control in the Terminal section.
- `web-ui/src/hooks/settings/settings-form.ts`: Added `agentTerminalRowMultiplier` to `SettingsFormValues` and `resolveInitialValues`.
- `web-ui/src/test-utils/runtime-config-factory.ts`: Added field to test factory.
- `test/runtime/terminal/session-manager.test.ts`: Updated existing resize test and added a new test for the multiplier.

**Why:** Agent output in Quarterdeck is primarily consumed via scrollback, not a live fixed-height TUI. Inflating the PTY height makes agents (Claude Code, Codex) render significantly more content per turn. Making it a config field lets users tune it or set to 1 if the TUI looks broken.

## Fix: React infinite re-render loop crash (2026-04-21)

Fixed a "Maximum update depth exceeded" (React error #185) that crashed the app on load. The bug was introduced by `f261083f` (refactor: extract task-editor provider from board provider).

**Root cause:** `TaskEditorProvider.resetTaskEditorWorkflow` was wrapped in `useCallback([taskEditor])`, but `useTaskEditor()` returns a fresh object every render, so the callback got a new identity on every render. That unstable reference was passed through context into `useProjectSwitchCleanup`, which used it in `useLayoutEffect` dependency arrays. The layout effects called `resetTaskEditorWorkflow()` (setting state), which triggered a re-render, which produced a new `resetTaskEditorWorkflow`, which re-fired the layout effects — infinite synchronous loop.

The Radix `composeRefs` / `YC` frames in the minified stack trace were a red herring — React happened to hit the update depth limit while processing Radix ref composition, but the actual loop was in the provider/effect chain.

**What changed:**

- `web-ui/src/providers/task-editor-provider.tsx`: Destructured `resetTaskEditorState` from the `taskEditor` object and used that stable callback as the sole dependency for `resetTaskEditorWorkflow`, instead of depending on the whole `taskEditor` object.
- `web-ui/src/providers/board-provider.tsx`: Wrapped the inline `onWorkingDirectoryResolved` callback in `useCallback([setBoard, projectPath])` so `startTaskSession` (which depends on it via `useTaskSessions`) keeps a stable reference. This was a latent instability masked by other churn before the provider split.
- `web-ui/src/providers/task-editor-provider.test.tsx`: Added a regression test asserting `resetTaskEditorWorkflow` identity stays stable across re-renders when `useTaskEditor` returns a new object.

**Why:** The provider-split refactor was correct in ownership terms, but the new `resetTaskEditorWorkflow` callback captured the entire `taskEditor` return value as a dependency instead of just the stable `resetTaskEditorState` member. Before the split, this callback lived inside `BoardProvider` where the context value was already changing for other reasons (task editor state, branch options), so the instability was masked. After extraction, the remaining `BoardContext` deps became stable enough that the unstable callback became the dominant source of context-value churn and triggered the loop.

## Notification/indicator semantic model refactor (2026-04-21)

Landed the notification/indicator refactor pass by introducing one shared semantic derivation layer for UI-facing task state meaning instead of letting several consumers independently decode raw session summary and hook metadata. Before this change, permission/approval state, review-ready state, needs-input/attention, and failure semantics were inferred in parallel from `reviewReason`, `latestHookActivity.notificationType`, `hookEventName`, and even fallback activity text. That duplication made it easy for Claude/Codex differences to leak upward and for notification, badge, and auto-review behavior to drift apart. After this slice, the raw signals still arrive through the existing session summary model, but the meaning those signals imply is normalized once in the runtime contract and then reused by UI consumers.

**What changed:**

- Added `src/core/api/task-indicators.ts`, which now owns the shared semantic derivation for task indicator state. The module exposes:
  - `isPermissionActivity(...)` for normalized permission-request detection across Claude and Codex raw metadata.
  - `deriveTaskIndicatorState(summary)` for the shared semantic model covering `approval_required`, `review_ready`, `needs_input`, `completed`, `error`, `failed`, `stalled`, `interrupted`, `running`, and `idle`, along with the derived badge tone, notification event, approval-blocking flag, and notification column.
- Exported the new semantic helpers through the runtime contract in `src/core/api/index.ts`, making them available to both the backend and the `web-ui` via `@runtime-contract`.
- Refactored `src/terminal/session-reconciliation.ts` to reuse the shared `isPermissionActivity(...)` helper rather than keeping a backend-only copy of the permission-detection logic. This keeps stale-hook cleanup aligned with the same permission semantics used by UI indicators.
- Refactored `web-ui/src/utils/session-status.ts` so status labels, badge tones, stalled tooltip behavior, and the `isApprovalState(...)` helper now derive from `deriveTaskIndicatorState(...)` instead of inspecting raw hook/session fields directly.
- Refactored `web-ui/src/hooks/notifications/audible-notifications.ts` so settle-window choice, task notification column, and review/permission/failure sound selection all come from the shared semantic layer rather than a separate raw-field switch tree.
- Refactored `web-ui/src/hooks/notifications/project-notifications.ts` so project-scoped needs-input/approval aggregation now depends on the shared semantic model instead of re-deriving approval state locally.
- Added `test/runtime/core/task-indicators.test.ts` to lock in the core semantic layer, including explicit Claude vs Codex normalization cases for approval-required state.
- Followed up on review by preserving the old green badge tone for `attention` / “Waiting for input” sessions, tightening the shared `TaskColumn` typing in `audible-notifications.ts`, making the badge-style/tone bridge explicit in `session-status.ts`, and adding coverage for running, idle, failed, interrupted, stalled, and exit-code-driven completed states.
- Added a small `AGENTS.md` tribal-knowledge note directing future indicator work to the shared semantic layer so new consumers do not regress back to direct `reviewReason` / `notificationType` / `hookEventName` parsing.

**Why:** The project-scoping ownership refactor made notification ownership clearer, but the meaning of the indicator states themselves was still spread across multiple layers. This pass addresses that second problem without rewriting the whole session lifecycle system: agent-specific raw signals stay low in the stack, Claude and Codex normalize into the same semantic model, and the highest-value UI consumers now read that shared meaning instead of low-level fields.

**Files touched:**

- `AGENTS.md`
- `src/core/api/index.ts`
- `src/core/api/task-indicators.ts`
- `src/terminal/session-reconciliation.ts`
- `test/runtime/core/task-indicators.test.ts`
- `web-ui/src/hooks/notifications/audible-notifications.ts`
- `web-ui/src/hooks/notifications/project-notifications.ts`
- `web-ui/src/utils/session-status.ts`
- `docs/todo.md`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** Pending commit on `feature/notification-indicator-model` (branched from local `main` at `3f2b9099`).

## Notification/project-scoping ownership refactor (2026-04-21)

Landed the first notification ownership cleanup pass by making project boundaries first-class in frontend notification state instead of letting multiple consumers reconstruct project ownership from a flat cross-project session map plus a separate task-to-project lookup. Before this change, runtime ingress stored notification memory as two loosely coupled global maps, and navigation badges, toolbar indicators, and current-project sound suppression each had to infer ownership from those maps independently. After this slice, runtime notification memory is stored as project-owned buckets, and the provider layer exposes a narrow project notification projection for UI consumers.

**What changed:**

- Added `web-ui/src/runtime/runtime-notification-projects.ts`, which now owns the project-bucket notification memory helpers used by the runtime stream store: per-project session merges stay monotonic for notification semantics, project-state seeding stays explicit, and removed projects prune their notification buckets instead of leaving cross-project residue behind.
- Refactored `web-ui/src/runtime/runtime-state-stream-store.ts` and `web-ui/src/runtime/use-runtime-state-stream.ts` so notification memory is now `projects[projectId].sessions` rather than one flat `sessions` map plus `projectIds`. This keeps project ownership in the data model itself and makes current-project seeding/pruning an explicit reducer concern.
- Added `web-ui/src/hooks/notifications/project-notifications.ts`, a pure notification-domain module that derives the provider-owned UI projection (`needsInputByProject`, `currentProjectHasNeedsInput`, `otherProjectsHaveNeedsInput`, and current-project sessions) from the project buckets. This keeps project badge logic out of UI hooks/components that only need the projection, not the raw notification memory.
- Narrowed `web-ui/src/providers/project-provider.tsx` to expose that derived notification projection, updated `web-ui/src/hooks/app/use-app-action-models.ts` to read the provider-owned current/other-project flags for toolbar badges, and simplified `web-ui/src/components/app/project-navigation-panel.tsx` plus `web-ui/src/hooks/project/use-project-navigation-panel.ts` so the panel no longer owns notification aggregation logic.
- Updated `web-ui/src/hooks/notifications/use-audible-notifications.ts` to flatten the project-owned buckets internally. That keeps review/permission/failure audio behavior and current-project suppression stable while removing the separate task-to-project lookup map from the hook contract.
- Added the high-signal tribal-knowledge follow-up in `AGENTS.md` documenting that notification ownership is intentionally split between project-owned runtime buckets, provider-owned UI projection, and the audible-notification hook’s event-oriented flattening.
- Added/updated focused regression coverage in:
  - `web-ui/src/runtime/runtime-state-stream-store.test.ts`
  - `web-ui/src/hooks/notifications/project-notifications.test.ts`
  - `web-ui/src/hooks/project/use-project-navigation-panel.test.tsx`
  - `web-ui/src/components/app/project-navigation-panel.test.tsx`
  - Existing audible notification suites via `web-ui/src/hooks/notifications/audible-notifications-*.test*`
- Reran targeted frontend notification/navigation tests plus `npm run web:typecheck` and `npm run typecheck`.

**Why:** The old shape “worked” only because several layers happened to keep a flat notification session map and a separate task-to-project map in sync. That made it too easy for project-switch or project-removal bugs to show up as stale needs-input dots, badge leakage, or suppression logic depending on the wrong ownership source. This slice does not solve the whole later “notification / indicator state model” follow-up, but it removes one important structural weakness: project ownership is now explicit in notification state, and most UI consumers no longer need to re-derive it.

**Files touched:**

- `AGENTS.md`
- `web-ui/src/App.tsx`
- `web-ui/src/components/app/project-navigation-panel.test.tsx`
- `web-ui/src/components/app/project-navigation-panel.tsx`
- `web-ui/src/hooks/app/use-app-action-models.ts`
- `web-ui/src/hooks/app/use-app-side-effects.ts`
- `web-ui/src/hooks/notifications/audible-notifications-test-utils.tsx`
- `web-ui/src/hooks/notifications/project-notifications.test.ts`
- `web-ui/src/hooks/notifications/project-notifications.ts`
- `web-ui/src/hooks/notifications/use-audible-notifications.ts`
- `web-ui/src/hooks/project/use-project-navigation-panel.test.tsx`
- `web-ui/src/hooks/project/use-project-navigation-panel.ts`
- `web-ui/src/hooks/project/use-project-navigation.ts`
- `web-ui/src/providers/project-provider.tsx`
- `web-ui/src/runtime/runtime-notification-projects.ts`
- `web-ui/src/runtime/runtime-state-stream-store.test.ts`
- `web-ui/src/runtime/runtime-state-stream-store.ts`
- `web-ui/src/runtime/use-runtime-state-stream.ts`
- `docs/todo.md`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** Pending commit on `feature/notification-project-scoping` (branch created from local `main` at `f261083f`).

## Board/task-editor provider ownership follow-up (2026-04-21)

Landed the next provider-narrowing follow-up by extracting task editing out of `BoardProvider` into a dedicated `TaskEditorProvider`. Before this change, `BoardContext` mixed core board/selection/session ownership with task create/edit dialog state, branch-option derivation, and the “save edit, then auto-start once it lands back in backlog” bridge. After the split, `BoardProvider` reads as board + selection + task-session ownership, while the new task-editor seam owns task editing as its own coherent workflow.

**What changed:**

- Added `web-ui/src/providers/task-editor-provider.tsx`, which now owns `useTaskBranchOptions(...)`, `useTaskEditor(...)`, the pending edit-start bridge, and the reset helper for task-editor workflow state.
- Narrowed `web-ui/src/providers/board-provider.tsx` so it now exposes board state, selected-task state, runtime task-session actions, and board-loading flags without also acting as the task-editor provider.
- Updated the highest-leverage consumers to read the narrower ownership seam they actually use: `web-ui/src/App.tsx`, `web-ui/src/components/app/app-dialogs.tsx`, `web-ui/src/providers/dialog-provider.tsx`, `web-ui/src/providers/interactions-provider.tsx`, and `web-ui/src/hooks/app/use-app-side-effects.ts` now depend on `useTaskEditorContext()` for task-editing workflow concerns instead of treating `BoardContext` as a convenience bag.
- Clarified project-switch cleanup in `web-ui/src/hooks/project/use-project-switch-cleanup.ts` by replacing the board-owned `resetBoardUiState()` reach-through with the task-editor-owned `resetTaskEditorWorkflow()` seam.
- Added `web-ui/src/providers/task-editor-provider.test.tsx` to lock in the new seam’s branch-option wiring and edit-start reset behavior, updated `web-ui/src/components/task/card-detail-view.test.tsx` to match the narrowed board context, and reran targeted frontend coverage (`task-editor-provider`, `use-task-editor`, and `card-detail-view`) plus `npm run web:typecheck`.

**Why:** Of the remaining broad provider seams, `BoardProvider` had the clearest real subdomain hiding inside it. Task editing already had its own state machine, branch-option derivation, and consumer set, so pulling that workflow into a dedicated provider makes ownership easier to explain without fragmenting the rest of board/session behavior into tiny contexts.

**Files touched:**

- `web-ui/src/App.tsx`
- `web-ui/src/components/app/app-dialogs.tsx`
- `web-ui/src/components/task/card-detail-view.test.tsx`
- `web-ui/src/hooks/app/use-app-side-effects.ts`
- `web-ui/src/hooks/project/use-project-switch-cleanup.ts`
- `web-ui/src/providers/board-provider.tsx`
- `web-ui/src/providers/dialog-provider.tsx`
- `web-ui/src/providers/interactions-provider.tsx`
- `web-ui/src/providers/task-editor-provider.tsx`
- `web-ui/src/providers/task-editor-provider.test.tsx`
- `docs/todo.md`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** Pending commit on `feature/provider-ownership-followups` (branch created from local `main` at `fdc45c00`).

## Task-detail composition review follow-up (2026-04-21)

Applied the small contract-cleanup follow-up that came out of review on the task-detail composition refactor so the ownership seams read a little more honestly without changing behavior.

**What changed:**

- Updated `web-ui/src/components/task/task-detail-side-panel.tsx` so it no longer imports a `repositoryState` slice just to reach `navigateToFile`; that callback now comes directly through the side-panel contract in `task-detail-screen.ts`.
- Stopped threading `sessionSummary` through `terminalProps`. It now flows through an explicit shared task-detail prop because both the repository-facing `GitView` path and the terminal surface need it.
- Simplified `web-ui/src/components/task/task-detail-main-content.tsx` so it no longer accepts a grouped `detail` object it barely used. The component now takes explicit `layoutState`, `repositoryState`, and `terminalState` inputs and forwards each owned slice to the surface that needs it.
- Updated the focused task-detail tests to match the refined contracts and reran the same targeted frontend task-detail suite plus `web-ui` typecheck and build.

**Why:** The original refactor already improved the screen architecture, but review surfaced three small semantic mismatches in the new contracts. Fixing them keeps the ownership story cleaner without reopening the larger task-detail cleanup.

**Files touched:**

- `web-ui/src/App.tsx`
- `web-ui/src/components/task/card-detail-view.tsx`
- `web-ui/src/components/task/task-detail-main-content.tsx`
- `web-ui/src/components/task/task-detail-repository-surface.tsx`
- `web-ui/src/components/task/task-detail-screen.ts`
- `web-ui/src/components/task/task-detail-side-panel.tsx`
- `web-ui/src/components/task/card-detail-view.test.tsx`
- `web-ui/src/components/task/task-detail-repository-surface.test.tsx`
- `web-ui/src/components/task/task-detail-side-panel.test.tsx`
- `web-ui/src/components/task/task-detail-terminal-surface.test.tsx`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** Pending.

## Task-detail layout/composition follow-up (2026-04-21)

Landed the first architectural cleanup slice for the task-detail follow-up by narrowing the task-detail screen around owned sections instead of leaving `CardDetailView` and `TaskDetailMainContent` as one broad dependency funnel. Before this change, `CardDetailView` accepted a long flat list mixing layout state, side-panel callbacks, git/files scope concerns, branch-dialog wiring, and terminal-shell plumbing; `TaskDetailMainContent` still owned most of the old kitchen-sink git/files/template wiring. After this slice, the layout root reads more like a coordinator while the repository-facing half of task detail owns its own composition seam.

**What changed:**

- Added `web-ui/src/components/task/task-detail-screen.ts` to define the owned task-detail prop groups (`layoutProps`, `sidePanelProps`, `repositoryProps`, and `terminalProps`) and updated `web-ui/src/App.tsx` plus `web-ui/src/components/task/card-detail-view.tsx` to use those section contracts instead of one flat prop bag.
- Reshaped `web-ui/src/hooks/board/use-card-detail-view.ts` so it now returns grouped task-detail state (`layout`, `sidePanel`, `repository`, `terminal`) rather than one undifferentiated result. This makes repository-specific wiring, terminal-specific wiring, and layout-specific refs/actions easier to consume independently.
- Added `web-ui/src/components/task/task-detail-repository-surface.tsx`, a repository-owned task-detail boundary that now owns the git/files half of the screen: `GitView` vs `FilesView` routing, scope bar construction, branch pill wiring, branch actions, compare/file navigation plumbing, git history slot handoff, and the inline diff-to-terminal hooks all live there.
- Added `web-ui/src/components/task/task-detail-side-panel.tsx`, which now owns the task-detail side seam for commit-vs-column context, resize-handle placement, and the narrow bridge between side-panel props and the repository/file-navigation seam.
- Added `web-ui/src/components/task/task-detail-terminal-surface.tsx`, which now owns the terminal half of task detail: agent terminal setup, auto-review cancel affordance, and the bottom shell pane composition all moved out of `TaskDetailMainContent`.
- Simplified `web-ui/src/components/task/task-detail-main-content.tsx` into a layout router: it keeps top-bar placement and conflict-banner visibility while delegating repository vs terminal composition to the owned seams.
- Updated regression coverage in `web-ui/src/components/task/card-detail-view.test.tsx` for the regrouped screen contract and added focused tests for each new owned seam: `task-detail-repository-surface.test.tsx`, `task-detail-side-panel.test.tsx`, and `task-detail-terminal-surface.test.tsx`.
- Reran targeted frontend coverage (`card-detail-view`, all three task-detail sub-surface tests, `column-context-panel`, and `surface-navigation-provider`) plus `npm run web:typecheck` and `npm --prefix web-ui run build`.

**Why:** The earlier `0337d71c` cleanup moved workflow/state derivation out of `card-detail-view.tsx`, but the screen still read as one broad composition surface. This slice narrows the highest-churn part of task detail by giving the repository-facing sub-area clearer ownership without adding a new provider or scattering the same prop funnel across more JSX wrappers.

**Files touched:**

- `web-ui/src/App.tsx`
- `web-ui/src/components/task/card-detail-view.tsx`
- `web-ui/src/components/task/task-detail-main-content.tsx`
- `web-ui/src/components/task/task-detail-repository-surface.tsx`
- `web-ui/src/components/task/task-detail-side-panel.tsx`
- `web-ui/src/components/task/task-detail-screen.ts`
- `web-ui/src/components/task/task-detail-terminal-surface.tsx`
- `web-ui/src/hooks/board/use-card-detail-view.ts`
- `web-ui/src/components/task/card-detail-view.test.tsx`
- `web-ui/src/components/task/task-detail-repository-surface.test.tsx`
- `web-ui/src/components/task/task-detail-side-panel.test.tsx`
- `web-ui/src/components/task/task-detail-terminal-surface.test.tsx`
- `docs/todo.md`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** Pending commit on `feature/task-detail-layout-composition` (branch created from local `main` at `09225fa0`).

## Relocate project config out of target repo (2026-04-21)

Quarterdeck was dropping a `.quarterdeck/` directory inside the user's target repo to store per-project config (shortcuts, defaultBaseRef). Moved this to the existing state home at `~/.quarterdeck/projects/{projectId}/config.json`, where all other project state (board, sessions, meta, pinned branches) already lives.

**What changed:**

- `getRuntimeProjectConfigPath` now takes `projectId` instead of `cwd` and resolves via `getProjectDirectoryPath(projectId)`.
- `resolveRuntimeConfigPaths` takes `projectId: string | null` instead of `cwd: string | null`, eliminating the `homedir()` comparison that was needed to distinguish global-only scope.
- `loadRuntimeConfig`, `saveRuntimeConfig`, and `updateRuntimeConfig` all dropped their `cwd` parameter — they now take only `projectId` (plus config/updates).
- Added `getLegacyProjectConfigPath(cwd)` for migration reads and `migrateLegacyProjectConfig(entries)` for one-time startup migration.
- Lock cleanup Phase 2 no longer scans `{project}/.quarterdeck/` as an owned directory — the config now lives in the global state home which Phase 1 already covers.
- `writeRuntimeProjectConfigFile` no longer tries to `rmdir(dirname(configPath))` on empty config, since the parent directory is now shared with other project state files.
- Startup calls `migrateLegacyProjectConfig` after loading the project index to move existing configs and clean up old directories.

**Why:** Tools should not leave artifacts in the repos they operate on. The `.quarterdeck/` directory was the only Quarterdeck-owned directory inside the target repo. The remaining `.git/` artifacts (worktree setup lock, info/exclude managed block) are appropriate for `.git/` internals and were not changed.

**Files touched:**

- `src/config/runtime-config-persistence.ts` — path resolution, migration, write cleanup
- `src/config/runtime-config.ts` — public API signature changes
- `src/config/index.ts` — barrel export updates
- `src/state/index.ts` — added `getProjectDirectoryPath` export
- `src/server/project-registry.ts` — updated all `loadRuntimeConfig` call sites and deps type
- `src/trpc/handlers/save-config.ts` — updated `updateRuntimeConfig` call
- `src/fs/lock-cleanup.ts` — removed repo-local `.quarterdeck/` from Phase 2 targets
- `src/cli.ts` — wired migration into startup cleanup
- `test/runtime/config/config-persistence.test.ts` — adapted to new signatures
- `test/runtime/config/pinned-branches.test.ts` — adapted to new signatures
- `test/runtime/config/audible-notifications.test.ts` — adapted to new signatures
- `test/runtime/config/agent-selection.test.ts` — adapted to new signatures
- `test/runtime/config/prompt-shortcuts.test.ts` — adapted to new signatures
- `test/runtime/lock-cleanup.test.ts` — updated Phase 2 expectations
- `web-ui/src/test-utils/runtime-config-factory.ts` — updated fixture path

**Commit hash:** Pending.

## Base ref selector popover fix (2026-04-21)

**What changed:**

- Fixed the `BaseRefLabel` popover content background class from `bg-bg-secondary` (non-existent, resolved to transparent) to `bg-surface-1`, matching the main `BranchSelectorPopover`.
- Added `pinnedBranches` prop to `BaseRefLabel` and wired it from `projectRuntime.pinnedBranches`. The filtered branch list now sorts pinned branches to the top, consistent with the main branch selector's pinned section.

**Why:** The base ref dropdown was see-through after opening because `bg-bg-secondary` isn't a defined color token. Pinned branches were also ignored in this dropdown even though the main branch popover supports them.

**Files touched:**

- `web-ui/src/components/app/connected-top-bar.tsx`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** `11cdc4eb`.

## Provider/runtime review follow-up (2026-04-21)

Applied the small correctness/polish fixes that came out of review on the provider-context ownership refactor, and recorded the intentionally deferred architectural follow-ups in the roadmap instead of quietly expanding scope.

**What changed:**

- Updated `web-ui/src/providers/project-runtime-provider.tsx` so `handleSetDefaultBaseRef(...)` now exits early when there is no active project instead of routing a nullable project id through the runtime-config save path.
- Tightened the same provider’s `saveTrashWorktreeNoticeDismissed()` callback to match the surrounding runtime-config mutation handlers: it now skips when no project is selected and shows a danger toast if the config save fails instead of failing silently.
- Expanded `web-ui/src/providers/project-runtime-provider.test.tsx` with focused coverage for both review follow-ups: no save when no project exists for default-base-ref updates, and visible error handling when trash-worktree notice dismissal fails.
- Added a short “deferred follow-up notes” section under the completed provider/context roadmap item in `docs/refactor-roadmap-context.md` so the two lower-severity architectural observations stay visible without turning this review cleanup into another broad provider-splitting pass.

**Why:** The review surfaced two small provider inconsistencies worth fixing immediately, plus two broader observations that are better handled as future ownership decisions than as opportunistic churn. This keeps the refactor branch tidy, addresses the real local quality gaps, and leaves a clear breadcrumb for the next architectural pass.

**Files touched:**

- `web-ui/src/providers/project-runtime-provider.tsx`
- `web-ui/src/providers/project-runtime-provider.test.tsx`
- `docs/refactor-roadmap-context.md`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** Pending commit on `feature/provider-context-surfaces`.

## Project runtime/context follow-up slice (2026-04-21)

Landed a second provider-narrowing follow-up on top of the earlier surface-navigation split by extracting runtime config ownership out of `ProjectContext` into `ProjectRuntimeProvider`. Before this change, `ProjectContext` still mixed project navigation/runtime-stream state with runtime config loading, onboarding/access gating, config-derived UI flags, and config mutation callbacks. After the split, the base project provider reads as navigation + sync ownership, while the new runtime provider owns config/onboarding/runtime setup concerns.

**What changed:**

- Added `web-ui/src/providers/project-runtime-provider.tsx`, which now owns both `useRuntimeProjectConfig(...)` scopes, `useQuarterdeckAccessGate(...)`, `useStartupOnboarding(...)`, config-derived values like `selectedShortcutLabel`, `agentCommand`, notification settings, checkout-confirmation toggles, and the related runtime-config mutation callbacks.
- Narrowed `web-ui/src/providers/project-provider.tsx` so it now exposes project navigation, runtime stream state, project sync/persistence fields, hydrate/persist gates, and project metadata/session notification state without also acting as the runtime-config provider.
- Updated the highest-leverage consumers to read the narrower seam they actually need: `App.tsx`, `home-view.tsx`, `connected-top-bar.tsx`, `app-dialogs.tsx`, `project-dialogs.tsx`, `dialog-provider.tsx`, `board-provider.tsx`, `git-provider.tsx`, `terminal-provider.tsx`, `interactions-provider.tsx`, `use-app-action-models.ts`, and `use-app-side-effects.ts` now separate base project ownership from runtime-config ownership.
- Added `web-ui/src/providers/project-runtime-provider.test.tsx` to lock in the new seam’s settings-scope behavior and config-derived fallback behavior, then reran targeted frontend coverage (`project-runtime-provider`, `surface-navigation-provider`, `card-detail-view`, and `use-card-detail-layout`) plus both `web-ui` and repo-root typecheck.
- Updated the roadmap context so the completed provider/context item now records both landed slices: surface/layout navigation moved out of `GitProvider`, and runtime config/onboarding moved out of `ProjectContext`.

**Why:** The first pass removed the most obvious mixed-domain bag from `GitProvider`, but `ProjectContext` was still broad enough that ownership remained blurry for config-heavy consumers. This follow-up keeps composition ergonomic while making it much clearer which provider owns project navigation/sync versus project runtime/config concerns, which should make future provider-narrowing work smaller and less invasive.

**Files touched:**

- `web-ui/src/providers/project-runtime-provider.tsx`
- `web-ui/src/providers/project-runtime-provider.test.tsx`
- `web-ui/src/providers/project-provider.tsx`
- `web-ui/src/providers/board-provider.tsx`
- `web-ui/src/providers/git-provider.tsx`
- `web-ui/src/providers/terminal-provider.tsx`
- `web-ui/src/providers/dialog-provider.tsx`
- `web-ui/src/providers/interactions-provider.tsx`
- `web-ui/src/hooks/app/use-app-action-models.ts`
- `web-ui/src/hooks/app/use-app-side-effects.ts`
- `web-ui/src/components/app/app-dialogs.tsx`
- `web-ui/src/components/app/project-dialogs.tsx`
- `web-ui/src/components/app/home-view.tsx`
- `web-ui/src/components/app/connected-top-bar.tsx`
- `web-ui/src/App.tsx`
- `CHANGELOG.md`
- `docs/refactor-roadmap-context.md`
- `docs/implementation-log.md`

**Commit hash:** Pending commit on `feature/provider-context-surfaces` (branch created from local `main` at `814ce825`).

## Provider/context surface narrowing slice (2026-04-21)

Landed the first production slice of the provider/context-surface roadmap item by extracting toolbar/layout navigation out of `GitProvider` into a dedicated `SurfaceNavigationProvider`. Before this change, `GitContext` mixed git-domain ownership with surface selection (`mainView`, `sidebar`), git-history visibility, and compare/file navigation. After the split, git consumers ask one context for git state and a different context for surface navigation, which makes ownership much easier to explain without pushing logic back up into `App.tsx`.

**What changed:**

- Added `web-ui/src/providers/surface-navigation-provider.tsx`, which now owns `useCardDetailLayout`, git-history open/close state, and `useGitNavigation`’s compare/file-routing helpers behind a dedicated `SurfaceNavigationContext`.
- Narrowed `web-ui/src/providers/git-provider.tsx` so it now focuses on git actions/history data, file-browser scope, top-bar/file-browser branch actions, and the home file-browser data seam. Conflict navigation still works, but it now depends on the surface-navigation provider instead of a git-owned ref callback.
- Updated the highest-surface consumers to read the narrower owned seam they actually need: `web-ui/src/App.tsx` now gets toolbar/sidebar/layout state from `useSurfaceNavigationContext()`, `web-ui/src/components/app/home-view.tsx` and `connected-top-bar.tsx` use the new surface navigation for view switching and compare/file routing, and `web-ui/src/hooks/app/use-app-action-models.ts`, `use-app-side-effects.ts`, and `web-ui/src/hooks/board/use-card-detail-view.ts` now separate layout/history navigation from git-domain actions.
- Updated provider/consumer coverage by adding `web-ui/src/providers/surface-navigation-provider.test.tsx` and adapting `web-ui/src/components/task/card-detail-view.test.tsx` to the split seam, then reran targeted frontend tests (`surface-navigation-provider`, `card-detail-view`, and `use-card-detail-layout`) plus `npm --prefix web-ui run typecheck`.
- Synced the roadmap bookkeeping by removing the completed active todo item and marking the provider/context-surface item as completed in `docs/refactor-roadmap-context.md`, while leaving the remaining narrower provider cleanup to future slices rather than one broad umbrella task.

**Why:** The earlier provider migration successfully pulled state out of `App.tsx`, but `GitProvider` had started to regrow as a convenience bag that mixed real git ownership with top-level surface/layout concerns. Extracting a dedicated surface-navigation seam preserves ergonomic composition while making it much clearer which provider owns which responsibility, and gives later narrowing passes a concrete pattern to follow.

**Files touched:**

- `web-ui/src/providers/surface-navigation-provider.tsx`
- `web-ui/src/providers/surface-navigation-provider.test.tsx`
- `web-ui/src/providers/git-provider.tsx`
- `web-ui/src/providers/interactions-provider.tsx`
- `web-ui/src/hooks/app/use-app-action-models.ts`
- `web-ui/src/hooks/app/use-app-side-effects.ts`
- `web-ui/src/hooks/board/use-card-detail-view.ts`
- `web-ui/src/components/app/home-view.tsx`
- `web-ui/src/components/app/connected-top-bar.tsx`
- `web-ui/src/components/task/card-detail-view.test.tsx`
- `web-ui/src/App.tsx`
- `docs/todo.md`
- `docs/refactor-roadmap-context.md`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** Pending commit on `feature/provider-context-surfaces` (branch created from local `main` at `814ce825`).

## Manual broadcast choreography refactor slice (2026-04-21)

Landed the first production slice of the “manual broadcast choreography” roadmap item by moving the main non-batched backend mutation paths onto an explicit post-mutation effects layer. Instead of leaving correctness to a remembered chain of `broadcast X`, `refresh Y`, and `notify Z` follow-up calls, these mutations now declare a narrow set of concrete effects and run them through one delivery helper.

**What changed:**

- Added `src/trpc/runtime-mutation-effects.ts` with a fixed, responsibility-driven effect union for project-state refreshes, project-summary refreshes, task review signals, task title sync, task working-directory sync, task base-ref sync, task/home git metadata refresh requests, and config/debug delivery effects for poll intervals and log level.
- Migrated `src/trpc/project-api-state.ts` so board saves now emit `project_state_updated` + `projects_updated` together through `createBoardStateSavedEffects(...)`, auto-generated/manual task-title updates go through explicit title-sync effects, and display-summary writes use the same post-mutation path instead of direct broadcaster calls.
- Migrated the project/task git mutation family in `src/trpc/project-api-git-ops.ts`, `src/trpc/project-api-staging.ts`, and `src/trpc/project-api-conflict.ts` so success/conflict follow-up behavior is expressed as effect semantics (`createProjectStateUpdatedEffects(...)` or `createGitMetadataRefreshEffects(...)`) instead of repeated inline broadcaster choreography.
- Migrated `src/trpc/hooks-api.ts` so hook transitions now declare their follow-up consequences through `createHookTransitionEffects(...)`, preserving the existing `project_state_updated` + `task_ready_for_review` behavior for review transitions while making the semantics auditable in one place.
- Migrated `src/trpc/handlers/migrate-task-working-directory.ts` so the lightweight board/task sync websocket update is emitted via explicit task-working-directory effects, and migrated `src/trpc/projects-api.ts` project add/remove/reorder follow-up broadcasts onto the same effect layer.
- Followed up by converting the last worthwhile non-batched direct delivery sites: metadata-driven task base-ref updates in `src/server/runtime-state-hub.ts`, plus config/debug fanout in `src/trpc/handlers/save-config.ts` and `src/trpc/handlers/set-log-level.ts`, all now run through the same effect dispatcher.
- Added a clarifying comment in `src/trpc/project-api-state.ts` documenting why focused-task routing intentionally remains a direct metadata-monitor command rather than becoming a post-mutation effect.
- Updated targeted tests in `test/runtime/trpc/runtime-mutation-effects.test.ts`, `project-api-state.test.ts`, `runtime-api.test.ts`, and `hooks-api/transitions.test.ts` to cover the new boundary, then reran targeted git/project/streaming coverage to confirm behavior stayed intact.

**Why:** The runtime session-summary batcher already gave session transitions one explicit “event -> delivery” boundary, but many other backend mutations still depended on developers remembering ad hoc follow-up calls. This slice makes the project/task mutation family read more like “mutation semantics -> declared effects” while keeping delivery policy separate and preserving the existing websocket contracts, metadata refresh rules, and board single-writer invariants.

**Files touched:**

- `src/server/runtime-state-hub.ts`
- `src/trpc/runtime-mutation-effects.ts`
- `src/trpc/app-router-context.ts`
- `src/trpc/project-api-shared.ts`
- `src/trpc/project-api-state.ts`
- `src/trpc/project-api-git-ops.ts`
- `src/trpc/project-api-staging.ts`
- `src/trpc/project-api-conflict.ts`
- `src/trpc/hooks-api.ts`
- `src/trpc/handlers/migrate-task-working-directory.ts`
- `src/trpc/handlers/save-config.ts`
- `src/trpc/handlers/set-log-level.ts`
- `src/trpc/projects-api.ts`
- `src/trpc/runtime-api.ts`
- `test/runtime/trpc/runtime-mutation-effects.test.ts`
- `test/runtime/trpc/project-api-state.test.ts`
- `test/runtime/trpc/runtime-api.test.ts`
- `test/runtime/trpc/hooks-api/transitions.test.ts`

**Commit hash:** Pending commit on `feature/manual-broadcast-choreography` (branch created from local `main` at `5068447d52b4f5e15991a92a925b111cf82a9797`).

## Consolidate refactor tracking docs (2026-04-21)

Reduced the number of standalone refactor tracking documents by folding completed-item context back into parent docs and centralizing the backlog in fewer files.

**What changed:**

- Deleted `docs/optimization-shaped-architecture-followups.md` — its 4 subsystem descriptions and the optimization-shaped heuristic were inlined into `docs/refactor-roadmap-context.md` as a "Recently Closed Out" summary and per-item status markers.
- Deleted `docs/project-metadata-monitor-followups.md` — the two follow-up sections (shared mutable entry coupling and refresh overwrite races) were appended to `docs/project-metadata-monitor-refactor-brief.md` under a new "Post-landing Follow-ups" heading.
- Expanded `docs/refactor-roadmap-context.md` with: active-order list matching `todo.md`, status markers on all existing sections (completed vs active), a "Recently Completed Refactors" summary, and an "Extended Backlog" with 9 new code-validated refactor targets (#9–#17) covering terminal session lifecycle, project/worktree identity, notification scoping, LLM client abstraction, orphan cleanup, indicator state, branch/base-ref UX, file browser pipeline, and task-detail composition.
- Restructured `docs/todo.md` with a tracking note header, "Additional code-validated refactor backlog" section linking each new roadmap item, "Historical completed roadmap programs" separator, and "Broader refactor context" links on existing bug items.
- Updated `docs/README.md` with a quick-start shortcut section and removed references to deleted files.
- Fixed cross-references in `docs/design-guardrails.md`, `docs/design-weaknesses-roadmap.md`, and `docs/terminal-ws-server-refactor-brief.md` to point at `refactor-roadmap-context.md` instead of the deleted files.

**Why:** Two standalone follow-up docs had drifted into "completed but still tracked separately" status, and the refactor backlog was split across too many files. Consolidating reduces the number of docs a new agent or engineer needs to read to understand what's active vs done, and makes the roadmap context document the single entry point for both active and extended backlog items.
