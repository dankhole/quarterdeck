# Design Weaknesses Roadmap

Purpose: capture the highest-leverage architectural weaknesses in Quarterdeck in priority order, so future refactors can be planned from a stable document instead of scattered chat context.

This is not a full implementation plan. It is a ranked map of the biggest design problems to solve, with enough explanation to help future agents and humans decide what deserves attention first.

Related docs:

- `docs/design-guardrails.md`
- `docs/refactor-roadmap-context.md`
- `docs/todo.md`

Execution tracking note:

- `docs/todo.md` is the source of truth for what should be worked on next.
- This roadmap is for prioritization and framing; if a weakness needs action, it should have a corresponding todo item.

## Ranking

The previous top-wave refactors around split-brain task state, manual broadcast choreography, provider narrowing, task-detail composition, notification scoping/indicator semantics, and project/worktree identity first-pass normalization have now landed. The ranking below reflects the biggest remaining weaknesses after that cleanup wave.

### 1. Terminal/session lifecycle ownership is still too broad

The terminal transport layer is in much better shape, but `TerminalSessionManager` still carries too much lifecycle coordination at once: spawn/attach, stale recovery, restart ownership, reconciliation timer wiring, listener fanout, and process/session registry responsibilities still meet at one seam.

Why it matters:

- terminal bugs are still the most likely to become hard-to-reproduce lifecycle bugs
- restart/recovery changes still carry broader regression risk than they should
- the manager reads more like a composed system now, but not yet like a mostly honest composition root

### 2. Project-level frontend ownership is still broader than ideal

The provider split helped a lot, but `ProjectProvider` remains the broadest frontend ownership seam. Project navigation, runtime ingress, authoritative sync outputs, notification projection, persistence gating, and metadata/debug-log exposure are still close enough together that “project-level everything” can regather there.

Why it matters:

- it is still the easiest place for project-scoped feature work to attach “just one more field/action”
- consumers can still depend on more project-level surface area than they actually need
- future provider cleanup will be harder if this seam regrows breadth quietly

### 3. Too many critical invariants still live in docs and team memory

Quarterdeck has good docs, but some of its most important rules are still protected mainly by explanation rather than by APIs, tests, or structural constraints.

Why it matters:

- new contributors can follow the wrong path accidentally
- knowledge leaks across time and worktrees
- the system stays dependent on “people remembering”

### 4. Orphan cleanup and reconciliation boundaries are still blurred

Session reconciliation, stale lock cleanup, orphan worktree cleanup, and dangling state repair are adjacent but not yet cleanly partitioned into one obvious lifecycle model.

Why it matters:

- maintenance-style fixes still want to attach themselves to whatever sweep already exists
- stale artifact bugs can span process/session state, filesystem state, and persistent state references
- it is not yet obvious which timer or maintenance path should own a new cleanup case

### 5. Branch/base-ref UX state is still a fragmented domain

Branch identity, pinned refs, inferred base refs, detached-head display, and integration-branch behavior still read more like a pile of fixes than one coherent model.

Why it matters:

- recurring branch/base-ref bugs are often model problems, not isolated UI mistakes
- different surfaces can still render slightly different interpretations of the same git situation
- future git workflow features will keep rediscovering the same missing state distinctions

### 6. File browser/diff viewer transport and view policy are still too mixed

The file browser and diff viewer are not just slow; the data-flow boundary is still fuzzy. Scope resolution, tree loading, diff/content fetching, caching, and view-local behavior are still too intertwined.

Why it matters:

- performance work risks becoming local hot-path tuning instead of a clearer pipeline
- it is still hard to say which work should happen server-side, which should be cached, and which should stay view-local
- the same ambiguity will keep moving lag from one interaction to another

### 7. Shared LLM helper features are still provider-specific

Titles, summaries, and small helper generations still depend on an Anthropic/Bedrock-shaped helper client even though the app now supports multiple agent providers.

Why it matters:

- auxiliary UX should not disappear just because the primary agent changes
- the current helper client bakes provider assumptions into a shared supporting path
- more multi-provider feature work will keep tripping on this boundary until the helper layer is neutral

### 8. Optimization-shaped architecture is repeating in multiple subsystems

This is the recurring pattern behind several otherwise unrelated design smells: a subsystem starts with a simple job, then gains caching, batching, retry, preload, backpressure, or prioritization logic until the clever behavior defines the architecture.

Why it matters:

- the same mistake keeps repeating
- features become difficult to explain simply
- future changes preserve cleverness accidentally because they cannot isolate it

See `docs/refactor-roadmap-context.md`.

### 9. Hook/domain-module discipline is good but still vulnerable to regression

The documented frontend hook pattern is strong, but it still depends on people noticing when a hook is drifting into multi-concern orchestration.

Why it matters:

- large hooks can quietly regrow complexity
- good conventions are easy to bypass under delivery pressure
- design drift happens gradually

### 10. Project/worktree identity follow-through still needs cleanup

The first project/worktree identity pass landed, but the migration is not fully closed out yet. Compatibility cleanup and remaining edge cases can still blur assigned task identity, launch-path identity, and displayed git identity if the distinctions are not kept explicit.

Why it matters:

- the remaining bugs here now look narrow, which makes them tempting to patch one by one
- the compatibility tail can keep stale vocabulary alive longer than intended
- if true live-cwd streaming ever returns, the code needs to stay disciplined about assigned identity versus execution identity

## How To Use This Doc

Use this document when deciding:

- what refactor work is worth prioritizing
- whether a new feature is adding accidental complexity
- whether a proposed optimization should become a policy layer instead of a core model

Use `docs/design-guardrails.md` for reusable design heuristics, and treat `docs/todo.md` as the authoritative execution tracker.
