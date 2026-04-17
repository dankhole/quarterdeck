# Design Weaknesses Roadmap

Purpose: capture the highest-leverage architectural weaknesses in Quarterdeck in priority order, so future refactors can be planned from a stable document instead of scattered chat context.

This is not a full implementation plan. It is a ranked map of the biggest design problems to solve, with enough explanation to help future agents and humans decide what deserves attention first.

Related docs:

- `docs/design-guardrails.md`
- `docs/terminal-architecture-refactor-brief.md`
- `docs/optimization-shaped-architecture-followups.md`
- `docs/todo.md`

Execution tracking note:

- `docs/todo.md` is the source of truth for what should be worked on next.
- This roadmap is for prioritization and framing; if a weakness needs action, it should have a corresponding todo item.

## Ranking

### 1. Split-brain task state

Task truth is still spread across server persistence, in-memory session state, websocket deltas, browser board state, and client-side cache/restore behavior. The system works, but correctness depends too much on update ordering and repair paths instead of one clear source of truth.

Why it matters:

- easy to create drift bugs
- hard to change without breaking sync behavior
- encourages more reconciliation logic instead of clearer ownership

### 2. Manual broadcast choreography instead of stronger domain-event boundaries

Many state-changing operations still depend on developers remembering which follow-up refreshes, websocket messages, or lightweight notifications must fire after a mutation. That makes the system accurate by convention more than by structure.

Why it matters:

- easy to miss a refresh path
- hard to audit full mutation consequences
- encourages copy-paste post-mutation behavior

### 3. Terminal/session runtime correctness is too entangled with optimization policy

The terminal system needs real optimization, but too much of its architecture is shaped by prewarm/reuse/restore policy instead of a simpler session/viewer/attachment model.

Why it matters:

- terminal bugs are hard to reason about
- performance policy has become part of the mental model
- future optimization changes carry correctness risk

See `docs/terminal-architecture-refactor-brief.md`.

### 4. `App.tsx` and app-shell orchestration still carry too much integration gravity

The provider split helped, but the top-level app shell remains a high-gravity integration point where many cross-feature concerns still meet. The file is much healthier than before, but the architecture still pushes broad orchestration upward.

Why it matters:

- top-level changes remain expensive
- app-wide integration concerns are easy to re-centralize
- features drift toward “just add one more top-level wire”

### 5. Broad provider/context surfaces still hide too much cross-domain ownership

Some providers, especially project- and git-related ones, still aggregate multiple concerns that would be easier to reason about if they were exposed through narrower interfaces.

Why it matters:

- easy to grow god-contexts
- makes reuse and testing harder
- encourages mixed ownership behind one hook or provider

### 6. Task detail and related large UI surfaces still carry workflow state too close to rendering

Some major UI surfaces are decomposed better now, but the pattern still exists: large render surfaces accumulate enough workflow behavior that the UI boundary becomes the design boundary.

Why it matters:

- rendering and workflow logic evolve together
- code becomes harder to test in smaller units
- UI churn can destabilize business logic

### 7. Project/workspace identity and sync ownership remain easy to blur

The codebase has improved its naming, but there are still places where project path, project ID, active project state, metadata snapshots, and UI cache/restore behavior are too easy to treat as one thing.

Why it matters:

- confusing bugs at switch/reconnect boundaries
- encourages hidden assumptions
- makes state ownership harder to explain

### 8. Optimization-shaped architecture is repeating in multiple subsystems

This is the recurring pattern behind several otherwise unrelated design smells: a subsystem starts with a simple job, then gains caching, batching, retry, preload, backpressure, or prioritization logic until the clever behavior defines the architecture.

Why it matters:

- the same mistake keeps repeating
- features become difficult to explain simply
- future changes preserve cleverness accidentally because they cannot isolate it

See `docs/optimization-shaped-architecture-followups.md`.

### 9. Hook/domain-module discipline is good but still vulnerable to regression

The documented frontend hook pattern is strong, but it still depends on people noticing when a hook is drifting into multi-concern orchestration.

Why it matters:

- large hooks can quietly regrow complexity
- good conventions are easy to bypass under delivery pressure
- design drift happens gradually

### 10. Too many critical invariants still live in docs and team memory

Quarterdeck has good docs, but some of its most important rules are still protected mainly by explanation rather than by APIs, tests, or structural constraints.

Why it matters:

- new contributors can follow the wrong path accidentally
- knowledge leaks across time and worktrees
- the system stays dependent on “people remembering”

## How To Use This Doc

Use this document when deciding:

- what refactor work is worth prioritizing
- whether a new feature is adding accidental complexity
- whether a proposed optimization should become a policy layer instead of a core model

Use `docs/design-guardrails.md` for reusable design heuristics, and treat `docs/todo.md` as the authoritative execution tracker.
