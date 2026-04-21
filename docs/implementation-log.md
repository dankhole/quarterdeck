# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Base ref selector popover fix (2026-04-21)

**What changed:**

- Fixed the `BaseRefLabel` popover content background class from `bg-bg-secondary` (non-existent, resolved to transparent) to `bg-surface-1`, matching the main `BranchSelectorPopover`.
- Added `pinnedBranches` prop to `BaseRefLabel` and wired it from `projectRuntime.pinnedBranches`. The filtered branch list now sorts pinned branches to the top, consistent with the main branch selector's pinned section.

**Why:** The base ref dropdown was see-through after opening because `bg-bg-secondary` isn't a defined color token. Pinned branches were also ignored in this dropdown even though the main branch popover supports them.

**Files touched:**

- `web-ui/src/components/app/connected-top-bar.tsx`
- `CHANGELOG.md`
- `docs/implementation-log.md`

**Commit hash:** Pending.

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
