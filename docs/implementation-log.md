# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

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
