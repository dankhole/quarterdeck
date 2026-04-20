# Refactor Roadmap Context

Purpose: capture enough context for the current next-wave refactors that a fresh agent can pick one up without reconstructing the architectural story from chat history.

This is intentionally lighter than the dedicated implementation briefs such as:

- `docs/project-metadata-monitor-refactor-brief.md`
- `docs/project-metadata-monitor-followups.md`
- `docs/terminal-ws-server-refactor-brief.md`

Use this document when:

- choosing what to work on next
- orienting a fresh agent to one of the queued refactors
- deciding whether a bug fix belongs in a local patch or a broader ownership-boundary cleanup

Execution tracking note:

- `docs/todo.md` remains the source of truth for active work.
- Every active refactor listed here should have a corresponding todo item.

## Recommended Order

1. Project metadata monitor follow-ups
2. Project sync plus board cache restore
3. Frontend runtime state stream store
4. Split-brain task state
5. Manual broadcast choreography / domain-event boundaries
6. App-shell integration gravity
7. Broad provider/context surfaces
8. Remaining workflow-heavy UI surfaces

That sequence is deliberate:

- 1 through 3 continue the active optimization-shaped cleanup work.
- 4 and 5 address the two biggest remaining correctness/ownership problems in the design roadmap.
- 6 through 8 reduce the architectural pressure that keeps re-centralizing behavior in large UI surfaces and broad providers.

## 1. Project Metadata Monitor Follow-ups

Primary files:

- `src/server/project-metadata-monitor.ts`
- `src/server/project-metadata-controller.ts`
- `src/server/project-metadata-refresher.ts`
- `src/server/project-metadata-poller.ts`
- `src/server/project-metadata-remote-fetch.ts`

Existing docs:

- `docs/project-metadata-monitor-refactor-brief.md`
- `docs/project-metadata-monitor-followups.md`

What is left:

- clarify mutation ownership around shared mutable `ProjectMetadataEntry`
- make full-project refreshes and targeted task refreshes freshness-aware so stale full refreshes do not overwrite newer task results

Why this is still near the top:

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

Primary files:

- `web-ui/src/hooks/project/use-project-sync.ts`
- `web-ui/src/runtime/project-board-cache.ts`
- `web-ui/src/hooks/project/use-project-switch-cleanup.ts`
- `web-ui/src/hooks/board/use-board-metadata-sync.ts`

Current smell:

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

Primary files:

- `web-ui/src/runtime/use-runtime-state-stream.ts`
- `web-ui/src/runtime/runtime-stream-dispatch.ts`
- related runtime state stores / reducers used by the hook

Current smell:

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

Primary files:

- `src/server/runtime-state-hub.ts`
- `src/trpc/*`
- mutation-heavy runtime/server modules that currently need explicit follow-up broadcasts or refresh requests

Current smell:

- many mutations are correct only because the developer remembered which follow-up websocket messages, refreshes, or lightweight notifications to send afterward

Why it matters:

- correctness is protected by convention more than by structure
- this is the second-highest weakness in the design roadmap

What “good” looks like:

- mutation consequences are easier to audit
- fewer paths depend on “and also remember to broadcast X”
- domain events or structured mutation-result handling make downstream effects more explicit

Suggested first slice:

- inventory a few representative mutation flows end to end
- identify common families of follow-up behavior
- decide whether the right answer is explicit domain events, structured mutation result objects, or a smaller centralized post-mutation coordinator

Key risk:

- over-abstracting this too early can create a generic event system that is harder to reason about than the existing manual calls

## 6. App-shell Integration Gravity

Primary files:

- `web-ui/src/App.tsx`
- `web-ui/src/AppContent.tsx` or current app-shell composition surfaces
- top-level providers and app-facing orchestration hooks

Current smell:

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

Suggested first slice:

- inventory the widest provider return shapes
- identify where one provider is really exposing multiple sub-domains
- split interfaces before splitting implementations where possible

Key risk:

- over-fragmenting providers can make app composition noisy; narrower ownership matters more than the raw count of contexts

## 8. Remaining Workflow-heavy UI Surfaces

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

## How To Use This Doc

Use this document together with:

- `docs/todo.md`
- `docs/design-weaknesses-roadmap.md`
- `docs/optimization-shaped-architecture-followups.md`

Use a dedicated refactor brief when one exists. Use this roadmap context when the item is important enough to queue next, but not yet justified for a full implementation brief.
