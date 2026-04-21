# Refactor Roadmap Context

Purpose: capture enough context for the current refactor queue and backlog that a fresh agent can pick the next item up without reconstructing the architectural story from chat history.

This is intentionally lighter than the dedicated implementation briefs such as:

- `docs/project-metadata-monitor-refactor-brief.md`
- `docs/terminal-ws-server-refactor-brief.md`

Use this document when:

- choosing what to work on next
- orienting a fresh agent to one of the queued refactors
- deciding whether a bug fix belongs in a local patch or a broader ownership-boundary cleanup

Execution tracking note:

- `docs/todo.md` remains the source of truth for active work.
- Every active refactor listed here should have a corresponding todo item.

Backlog note:

- The "Current active order" list below is the live refactor queue and should match `docs/todo.md`.
- The numbered sections that follow include both active items and recently completed items that are still worth keeping as context.
- The extended backlog later in this document captures additional code-validated refactor targets that are worth tracking, but are not at the very top of the current order.

## Current Active Order

1. Notification / project-scoping ownership
2. Notification / indicator state model
3. Project / worktree identity normalization
4. Branch / base-ref UX state model
5. File browser + diff viewer data pipeline
6. Terminal session manager / lifecycle boundaries
7. Orphan cleanup / reconciliation boundary
8. Shared LLM client abstraction

That sequence is deliberate:

- 1 through 5 are the most concrete next backlog items once the provider-surface and task-detail cleanup landed.
- 6 through 8 are still important, but they are better treated as later-wave cleanup once the more user-visible ownership seams are clearer.

In other words: yes, this order is intentional. It is sequenced by dependency and leverage, not just by how interesting each item sounds in isolation.

## Optimization-shaped Refactors Recently Closed Out

Quarterdeck has had a repeating pattern where a subsystem starts with a simple job, then gains enough caching, polling, batching, reconnect, preload, or recovery behavior that the optimization starts to define the architecture.

That pattern produced several of the recently completed refactors:

- project metadata monitor
- project sync plus board cache restore
- terminal websocket bridge
- frontend runtime state stream store

The rule of thumb is:

- keep the clever behavior if it materially helps UX or performance
- but move that clever behavior behind a clearer policy boundary so the subsystem can still be explained in terms of ownership first

If a subsystem is hard to explain without leading with timers, cache states, batching windows, or prioritization rules, it is probably becoming optimization-shaped.

## Recently Completed Refactors

These landed recently enough that they are still useful context for what remains:

- Broad provider / context surfaces
- Task-detail layout / composition follow-up
- Manual broadcast choreography / post-mutation effects
- Project metadata monitor follow-ups
- Project sync plus board cache restore
- Frontend runtime state stream store
- Split-brain task state
- App-shell integration gravity
- Remaining workflow-heavy UI surfaces

## 1. Project Metadata Monitor Follow-ups

Status:

- Completed on 2026-04-20. See `CHANGELOG.md` and `docs/implementation-log.md` for the landed freshness/ownership follow-up.

Primary files:

- `src/server/project-metadata-monitor.ts`
- `src/server/project-metadata-controller.ts`
- `src/server/project-metadata-refresher.ts`
- `src/server/project-metadata-poller.ts`
- `src/server/project-metadata-remote-fetch.ts`

Existing docs:

- `docs/project-metadata-monitor-refactor-brief.md`

What this follow-up closed out:

- clarify mutation ownership around shared mutable `ProjectMetadataEntry`
- make full-project refreshes and targeted task refreshes freshness-aware so stale full refreshes do not overwrite newer task results

Why it was worth doing:

- the main refactor landed, but the remaining coupling is now easier to see
- metadata correctness still influences branch pills, working-directory healing, and task/worktree status everywhere else in the app
- this is the smallest remaining state-ownership cleanup with clear local boundaries

What “good” looks like:

- one clear mutation owner for per-project metadata state
- explicit merge/freshness rules for task results
- tests that cover at least one stale-overwrite race directly

Suggested first slice:

- add a controller-owned commit path for task metadata updates
- stop replacing the whole task metadata map blindly on `refreshProject()`
- make targeted task refreshes win intentionally for that task when newer

Key risk:

- fixing the overwrite race by over-serializing everything could make focused-task refreshes feel slower or more coupled to background work

## 2. Project Sync Plus Board Cache Restore

Status:

- Completed on 2026-04-20. See `CHANGELOG.md` and `docs/implementation-log.md` for the authoritative-sync vs cache-restore cleanup.

Primary files:

- `web-ui/src/hooks/project/use-project-sync.ts`
- `web-ui/src/runtime/project-board-cache.ts`
- `web-ui/src/hooks/project/use-project-switch-cleanup.ts`
- `web-ui/src/hooks/board/use-board-metadata-sync.ts`

Historical smell:

- the hook that should simply apply authoritative project state also owns cache restore, stale-write protection, request invalidation, and hydration policy
- the cache is no longer just an acceleration layer; it shapes how project switch behavior is explained

Why it matters:

- this is the frontend half of the split-brain task-state problem
- project switching is one of the most frequent state-boundary transitions in the app
- the current model is easy to accidentally expand with “one more exception” logic

What “good” looks like:

- one explicit path applies authoritative project state
- cache restore is clearly optional and clearly subordinate to that authoritative path
- the “can this be persisted yet?” rules are easier to explain without talking through the entire switch lifecycle

Suggested first slice:

- document or codify the contract between authoritative project state and cached board restore
- isolate cache hit/restore policy into a smaller module or policy layer
- keep `use-project-sync.ts` reading primarily as state application and resync orchestration

Key invariants:

- cached boards must never be persisted back as if they were authoritative
- project switching should still feel fast
- switch cancellation / stale request protection must remain intact

## 3. Frontend Runtime State Stream Store

Status:

- Completed on 2026-04-20. See `CHANGELOG.md` and `docs/implementation-log.md` for the stream-store vs transport-policy split.

Primary files:

- `web-ui/src/runtime/use-runtime-state-stream.ts`
- `web-ui/src/runtime/runtime-stream-dispatch.ts`
- related runtime state stores / reducers used by the hook

Historical smell:

- this store is doing more than “receive runtime messages and apply them”
- preload handling, reconnect logic, snapshot merge policy, and notification memory all live close enough together that transport policy feels like part of state ownership

Why it matters:

- this hook is the central runtime ingress path for the frontend
- any ambiguity here amplifies downstream into board state, notification state, project metadata, and session rendering

What “good” looks like:

- the core stream reducer/store path is obvious
- reconnect and preload policy are optional layers around it
- snapshot vs delta application rules are explicit

Suggested first slice:

- identify the smallest “receive/apply runtime stream” core
- split reconnect/preload bookkeeping from message-application logic
- make notification memory state a separately explainable concern

Key invariants:

- initial snapshot handling must remain compatible with the server stream contract
- reconnect behavior cannot regress into duplicate state application or missed deltas

## 4. Split-brain Task State

Status:

- Completed on 2026-04-20 via the explicit hydrate-time `in_progress`/`review` projection, board-only public persistence contract, server-owned session persistence, and authoritative snapshot-vs-delta session reconciliation. See `docs/task-state-system.md`, `CHANGELOG.md`, and `docs/implementation-log.md` for the landed contract.

Primary files:

- `src/state/project-state-index.ts`
- `src/terminal/session-summary-store.ts`
- `src/core/task-board-mutations.ts`
- `web-ui/src/state/board-state.ts`
- `web-ui/src/hooks/project/use-project-sync.ts`
- `web-ui/src/runtime/use-runtime-state-stream.ts`

Supporting doc:

- `docs/task-state-system.md`

Historical smell:

- task truth is still spread across persistence, in-memory runtime state, websocket deltas, browser board state, and client-side restore/cache behavior

Why it matters:

- this is still the number one architectural weakness in `docs/design-weaknesses-roadmap.md`
- many smaller bugs are really symptoms of ambiguous truth ownership rather than isolated mistakes

What “good” looks like:

- it is easy to answer “what is authoritative for task X right now?”
- automatic column motion, session state, and persisted board state follow a clearer contract
- fewer repair/reconciliation paths are needed because fewer ambiguous overlaps exist

Outcome:

- browser-owned board truth and server-owned session truth now meet at an explicit, narrow join point
- reconnect/project-switch/restart no longer rely on browser `sessions` payloads or stale cached session maps as competing authorities

## 5. Manual Broadcast Choreography / Domain-event Boundaries

Status:

- Completed on 2026-04-21 via the explicit post-mutation effects layer in `src/trpc/runtime-mutation-effects.ts`. See `CHANGELOG.md` and `docs/implementation-log.md` for the landed first slice.

Primary files:

- `src/server/runtime-state-hub.ts`
- `src/trpc/*`
- mutation-heavy runtime/server modules that currently need explicit follow-up broadcasts or refresh requests

Historical smell:

- many mutations were correct only because the developer remembered which follow-up websocket messages, refreshes, or lightweight notifications to send afterward

Why it mattered:

- correctness was protected by convention more than by structure
- this is the second-highest weakness in the design roadmap

Outcome:

- non-batched project/task mutation flows now express their follow-up semantics through a narrow post-mutation effects layer instead of scattered inline broadcaster choreography
- the session-summary batcher remains the owner of batched session/notification/project-summary delivery, while the new effect layer covers the mutation paths that previously bypassed that structure
- project-state refreshes, project-summary refreshes, task review signals, git metadata invalidations, task title sync, and task working-directory sync now have one auditable delivery path in `src/trpc/runtime-mutation-effects.ts`

Remaining follow-up worth watching:

- the first slice established the pattern for the main project/task mutation family, but other mutation-heavy runtime paths should still prefer this effect model instead of reintroducing ad hoc broadcaster sequences

## 6. App-shell Integration Gravity

Status:

- Completed on 2026-04-20. See `CHANGELOG.md` and `docs/implementation-log.md` for the provider-owned wiring cleanup around git history and edit-start flow.

Primary files:

- `web-ui/src/App.tsx`
- `web-ui/src/AppContent.tsx` or current app-shell composition surfaces
- top-level providers and app-facing orchestration hooks

Historical smell:

- even after provider extraction, top-level orchestration remains the place where many cross-feature interactions meet
- the app shell is healthier than it used to be, but it is still an attractive place to wire “just one more cross-cutting thing”

Why it matters:

- broad integration gravity tends to re-centralize architecture after local cleanups
- app-wide behavior becomes expensive to change when too many feature seams meet only at the top

What “good” looks like:

- more app-shell wiring becomes declarative composition rather than hand-threaded behavior
- cross-feature coordination happens in narrower surfaces closer to the owning domain

Suggested first slice:

- identify current top-level wires that could be pushed one layer closer to their owning provider or domain
- avoid chasing file length alone; focus on integration gravity and ownership clarity

Key risk:

- it is easy to replace one broad top-level file with many tiny pass-through components/hooks that do not improve ownership at all

## 7. Broad Provider / Context Surfaces

Status:

- Completed on 2026-04-21 as the first ownership-boundary narrowing pass. The main landed slice extracted surface/layout navigation out of `GitProvider` into `web-ui/src/providers/surface-navigation-provider.tsx`, so git action/state ownership is no longer mixed with toolbar/main-view/sidebar state, git-history visibility, and cross-surface compare/file navigation.

Primary files:

- project-, git-, board-, and interaction-related providers under `web-ui/src/providers/`
- high-surface hooks that expose broad mixed-domain objects

Current smell:

- some provider/context surfaces still bundle multiple concerns behind one hook or object
- the result is convenient to consume but blurry to own

Why it matters:

- this is how god-contexts regrow after a provider migration
- broad surfaces make testing and reuse harder because consumers depend on more than they really need

What “good” looks like:

- provider surfaces are narrower and map more clearly to domain ownership
- consuming code asks for the smallest useful interface instead of a large mixed bag

Outcome:

- git consumers now read layout/history/file-navigation state from a dedicated surface-navigation seam instead of from `GitContext`
- project consumers now read runtime config/onboarding/access-gate concerns from `ProjectRuntimeContext` instead of from `ProjectContext`
- `GitProvider` is materially narrower and easier to explain as git-domain ownership
- `ProjectProvider` is materially narrower and easier to explain as navigation + sync ownership
- the remaining provider/context cleanup can continue as smaller follow-on slices instead of one broad umbrella item

Deferred follow-up notes:

- `ProjectRuntimeContext` is still a broad runtime/config seam. That is acceptable for now because the ownership is domain-coherent, but if future churn or rerender pressure justifies another pass, the first candidate split is likely runtime-config data versus runtime-config mutation/actions, or settings-scope config versus onboarding/access-gate concerns.
- `SurfaceNavigationProvider` still depends on `ProjectContext` and `BoardContext` for project-switch reset behavior and selected-task layout coordination. Keep that coupling under watch, but do not split it further unless a clearer ownership seam emerges than “make the provider rerender less.”

Key risk:

- over-fragmenting providers can make app composition noisy; narrower ownership matters more than the raw count of contexts

## 8. Remaining Workflow-heavy UI Surfaces

Status:

- Completed on 2026-04-20 as the broad decomposition pass. The remaining follow-up is narrower and is captured below as `17. Task-detail Layout / Composition Follow-up`.

Primary files:

- `web-ui/src/components/board/board-card.tsx`
- `web-ui/src/components/task/task-create-dialog.tsx`
- `web-ui/src/components/git/branch-selector-popover.tsx`
- `web-ui/src/components/task/card-detail-view.tsx`

Current smell:

- these are the largest remaining UI surfaces that still risk becoming de facto workflow boundaries instead of presentation boundaries

Why it matters:

- this is the most concrete follow-on to the earlier large-component cleanup work
- these files are frequent change hotspots, so unclear rendering/workflow boundaries create merge risk and regression risk quickly

What “good” looks like:

- decomposition is driven by workflow/state ownership, not just line count
- domain logic moves into hooks or domain modules when appropriate
- the remaining component shell reads primarily as composition/rendering

Suggested first slice:

- choose one component at a time
- identify which logic is true workflow/orchestration and which is pure JSX extraction
- follow the existing `web-ui` hook/domain-module conventions instead of inventing a new pattern

Key risk:

- pure file splitting without clarifying ownership creates more files without reducing architectural pressure

## Extended Backlog

These are still real refactor targets confirmed against implementation files, but they sit behind the active roadmap above.

## 9. Terminal Session Manager / Lifecycle Boundaries

Primary files:

- `src/terminal/session-manager.ts`
- `src/terminal/session-lifecycle.ts`
- `src/terminal/session-summary-store.ts`
- `src/terminal/session-reconciliation.ts`
- `src/terminal/session-reconciliation-sweep.ts`

Current smell:

- `TerminalSessionManager` is much healthier than it used to be, but it still coordinates listener fanout, restart ownership, attach/restore behavior, spawn routing, input/output flow, stale recovery, and reconciliation timer lifecycle
- session truth, process ownership, restart policy, and reconciliation policy still meet at one coordinator seam

Why it matters:

- recurring restart, interrupted-session, and restore bugs still naturally centralize here
- the file reads more like a composed system now, but not yet like a pure composition root

What “good” looks like:

- session truth, process lifecycle, and reconciliation policy are easier to explain independently
- the manager owns registry/wiring responsibilities more than indirect transition rules

Suggested first slice:

- inventory which transitions are true lifecycle rules vs orchestration glue
- push one cohesive responsibility, likely restart/recovery orchestration or reconciliation action application, behind a clearer ownership seam

Key risk:

- splitting into more helper files without clarifying transition ownership would add indirection without improving lifecycle reasoning

## 10. Project / Worktree Identity Normalization

Primary files:

- `src/server/project-metadata-controller.ts`
- `src/server/project-metadata-refresher.ts`
- `web-ui/src/hooks/board/use-board-metadata-sync.ts`
- `web-ui/src/state/board-state.ts`
- `web-ui/src/stores/project-metadata-store.ts`
- `src/commands/statusline.ts`

Current smell:

- assigned worktree path, live agent cwd, displayed branch, displayed project folder, and shared-vs-isolated task state still blur together
- task-scoped UI sometimes wants assigned worktree identity, while other surfaces want live execution identity, but the code does not model that distinction explicitly

Why it matters:

- recurring bugs around wrong branch pills, wrong folder labels, and stale “shared” indicators all point at the same missing identity layer

What “good” looks like:

- the code distinguishes project root path, assigned task worktree path, live agent cwd, and displayed task git identity explicitly
- task-scoped UI can intentionally choose assigned identity vs live execution identity

Suggested first slice:

- define a small shared vocabulary for task path identity in metadata + UI layers
- fix one end-to-end path, likely task-scoped branch/folder display, so it no longer relies on raw `cwd`

Key risk:

- forcing everything to use either assigned worktree or live cwd globally would erase a real distinction instead of modeling it

## 11. Notification / Project-scoping Ownership

Primary files:

- `web-ui/src/runtime/runtime-state-stream-store.ts`
- `web-ui/src/providers/project-provider.tsx`
- `web-ui/src/hooks/project/use-project-navigation-panel.ts`
- `web-ui/src/hooks/notifications/use-audible-notifications.ts`
- `web-ui/src/hooks/notifications/use-review-ready-notifications.ts`

Current smell:

- notification state crosses project boundaries through broad global session and project-id maps
- project-scoping rules are distributed across runtime ingress, provider state, sidebar aggregation, and playback suppression

Why it matters:

- bugs like the wrong yellow-dot state following a project switch strongly suggest the scoping model is still too implicit

What “good” looks like:

- notification ownership is easier to explain per project and per task
- navigation badges, audible notifications, and review-ready memory stop depending on loosely related maps staying in sync

Suggested first slice:

- define the minimal notification projection the UI actually needs instead of passing broad runtime-session memory around
- separate global notification memory from per-project derived indicators

Key risk:

- folding everything into one global notification store would make scoping even harder unless project boundaries are first-class in that model

## 12. Shared LLM Client Abstraction

Primary file:

- `src/title/llm-client.ts`

Current smell:

- the shared helper client hardcodes Anthropic/Bedrock-style environment variables and a Bedrock Haiku default model
- availability checks are based on one provider-specific env pair even though the app now supports more than one agent/runtime

Why it matters:

- titles, summaries, and lightweight helper generations are auxiliary UX that should not disappear when the primary agent changes

What “good” looks like:

- auxiliary LLM features choose provider/model through config rather than env-name assumptions
- the shared client exposes a provider-neutral request shape and capability check

Suggested first slice:

- introduce a small config-driven provider descriptor for lightweight completions
- preserve the current Bedrock path as one implementation, not the only model

Key risk:

- trying to solve full multi-provider agent launching and auxiliary LLM generation in one pass would broaden scope too far

## 13. Orphan Cleanup / Reconciliation Boundary

Primary files:

- `src/terminal/session-reconciliation.ts`
- `src/terminal/session-reconciliation-sweep.ts`
- `src/fs/lock-cleanup.ts`

Current smell:

- session reconciliation and broader filesystem/worktree cleanup are adjacent but not clearly owned by one lifecycle model
- some orphan cleanup is session-driven, some is periodic, and some lives in one-off repair paths

Why it matters:

- the current shape works, but it invites “just add another sweep here” fixes

What “good” looks like:

- process/session reconciliation and broader orphan cleanup are separate, named responsibilities
- new stale artifact classes have an obvious home instead of getting attached to whichever timer already exists

Suggested first slice:

- document the cleanup taxonomy: session drift, process artifacts, filesystem locks, orphan worktrees, orphan state references
- decide which classes belong on the session reconciliation timer vs a separate maintenance sweep

Key risk:

- centralizing all cleanup under one loop would make maintenance behavior harder to reason about and harder to test

## 14. Notification / Indicator State Model

Primary files:

- `web-ui/src/utils/session-status.ts`
- `src/terminal/session-reconciliation.ts`
- `web-ui/src/hooks/project/use-project-navigation-panel.ts`
- `web-ui/src/components/app/project-navigation-panel.tsx`

Current smell:

- the permission-request / needs-input concept is inferred from session summary hook metadata in more than one layer
- visual indicators are coupled directly to low-level hook metadata shape and session summaries

Why it matters:

- small badge bugs can require reasoning across runtime summaries, hook payloads, and navigation-level aggregation

What “good” looks like:

- approval / review / failure / needs-input indicators have a clearer domain model
- UI badges and dots consume a narrower, easier-to-test derived state

Suggested first slice:

- isolate the approval/needs-input derivation into one shared semantic layer or one clearly owned UI projection
- use the yellow-dot project-switch bug as a validation case for the new boundary

Key risk:

- replacing summaries with an overly lossy “status enum” would hide useful detail; the goal is a clearer derived model, not less information

## 15. Branch / Base-ref UX State Model

Primary files:

- `src/workdir/git-utils.ts`
- `src/server/project-metadata-refresher.ts`
- `web-ui/src/hooks/board/use-task-base-ref-sync.ts`
- `web-ui/src/hooks/git/use-task-branch-options.ts`

Current smell:

- branch identity, default base branch, inferred base ref, pinned base ref, detached-head display, and integration-branch behavior still feel like separate fixes rather than one domain model

Why it matters:

- recurring base-ref bugs are usually symptoms of this missing model

What “good” looks like:

- the code distinguishes explicit user choice, inferred base ref, unresolved state, and detached-head display cleanly
- top-bar/base-ref pills and branch-change sync rules consume the same model

Suggested first slice:

- formalize the “unresolved base ref” state instead of treating it as a skipped update
- make one UI surface, likely the top-bar/base-ref pill, render directly from that clearer state model

Key risk:

- conflating task creation defaults with ongoing branch/base-ref synchronization would mix two related but distinct workflows

## 16. File Browser + Diff Viewer Data Pipeline

Primary files:

- `src/trpc/project-api-changes.ts`
- `web-ui/src/hooks/git/use-file-browser-data.ts`
- `web-ui/src/components/git/files-view.tsx`
- `web-ui/src/components/git/git-view.tsx`

Current smell:

- file tree state, diff loading, caching, scope identity, and transport timing are intertwined
- it is not yet obvious which work should happen server-side, which should be cached, and which should stay view-local

Why it matters:

- the performance issues here are not just “needs optimization”; the data-flow boundary is still fuzzy

What “good” looks like:

- file tree listing, file-content loading, and diff loading are separable concerns
- mutable-worktree vs fixed-ref browsing semantics are explicit

Suggested first slice:

- instrument the current data path for first-open tree load, file selection, and diff selection
- separate scope resolution from content loading in the frontend hook layer

Key risk:

- optimizing one hot path locally without clarifying scope identity and transport boundaries would just move the lag to another interaction

## 17. Task-detail Layout / Composition Follow-up

Status:

- Completed on 2026-04-21. See `CHANGELOG.md` and `docs/implementation-log.md` for the landed repository-surface ownership slice.

Primary files:

- `web-ui/src/components/task/card-detail-view.tsx`
- `web-ui/src/components/task/task-detail-main-content.tsx`
- `web-ui/src/components/task/task-branch-dialogs.tsx`
- `web-ui/src/hooks/board/use-card-detail-view.ts`

Current smell:

- `0337d71c` improved logic ownership by moving workflow/state derivation out of `card-detail-view.tsx`
- but `CardDetailView` still carries a very broad prop surface, and `TaskDetailMainContent` still holds most of the old template complexity
- the remaining problem is now layout/composition ownership, not “one more hook extraction”

Why it matters:

- the task detail surface is still a high-churn screen where several semi-independent sub-areas meet
- broad prop threading makes the whole screen feel like one dependency funnel
- this is the clearest remaining example of “presentation shell got healthier, but the screen architecture is still too broad”

What “good” looks like:

- `CardDetailView` reads as a layout/composition root, not a broad dependency funnel
- task-detail sub-areas own narrower seams, for example side context, git/files scope, terminal/detail layout, and branch/dialog concerns
- the next person changing one panel does not need to mentally load the entire detail screen

Suggested first slice:

- map the current `CardDetailView` prop surface into responsibility groups
- separate true layout-root concerns from sub-panel-owned concerns
- extract one coherent sub-panel boundary with a meaningfully narrower contract

What this slice landed:

- regrouped `CardDetailView` around owned section contracts (`layoutProps`, `sidePanelProps`, `repositoryProps`, `terminalProps`) instead of one flat screen-level prop funnel
- added a repository-owned task-detail seam for git/files routing, scope bar + branch pill wiring, git history handoff, compare/file navigation, and diff-to-terminal actions
- added owned side-panel and terminal seams so commit-vs-column context and agent-terminal-plus-shell composition no longer live inline in the layout root/router
- simplified `TaskDetailMainContent` so it now reads primarily as a layout router coordinating the repository surface versus the terminal surface

Key risk:

- splitting JSX without changing ownership will just recreate the same kitchen-sink screen across more files
- adding a task-detail provider too early could create another broad context surface instead of a cleaner layout seam

## How To Use This Doc

Use this document together with:

- `docs/todo.md`
- `docs/design-weaknesses-roadmap.md`
- `docs/design-guardrails.md`

Use a dedicated refactor brief when one exists. Use this roadmap context when the item is important enough to queue next, but not yet justified for a full implementation brief.
