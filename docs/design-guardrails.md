# Design Guardrails

Purpose: capture reusable rules for adding clever features without letting optimization or recovery behavior become the architecture.

This is a guardrails doc, not a style guide. It exists because several Quarterdeck subsystems have followed the same failure mode:

1. start with a simple core job
2. add smart caching/retry/preload/batching/recovery logic
3. let that smart behavior become the main system model

The goal is to keep the cleverness while protecting the design.

Execution tracking note:

- Do not use this document as a backlog.
- If a guardrail violation turns into real work, add or update the corresponding item in `docs/todo.md`.

## Core Rule

Build the dumb correct version first. Then add smart behavior around it.

If the feature only makes sense when the optimization is present, the optimization is probably becoming architecture.

## Guardrails

### 1. Keep correctness separate from performance

Ask:

- what is the simplest correct version of this feature?
- what makes it faster, smoother, or cheaper?

Those two layers should be distinguishable in the code and in the explanation.

### 2. Give optimization an off switch

Before adopting a clever optimization, ask:

- if we disable this, does the feature still work correctly?

Desired answer:

- yes, but maybe slower

Bad sign:

- no, correctness or core behavior breaks

### 3. Separate mechanism from policy

Mechanism does the thing.
Policy decides when, why, and how aggressively to do it.

Examples:

- mechanism: send websocket updates
- policy: batch them every 150ms

- mechanism: attach a terminal viewer to a session
- policy: keep one viewer warm for fast switching

### 4. Do not hide five systems behind one class name

If one class or hook owns several of these at once, stop and reassess:

- truth/state ownership
- caching
- scheduling/timers
- retries/reconnect
- prioritization
- UI rendering
- cross-system coordination

The more of these a single unit owns, the more likely the design is drifting.

### 5. Preserve a simple explanation

A healthy subsystem should be explainable in a few simple sentences without leading with the optimization.

Good:

- “The viewer attaches to the backend session.”
- “We sometimes reuse or prewarm viewers to make switching faster.”

Bad:

- “The system works by moving slots through several optimization roles and timed transitions.”

### 6. Only keep complexity that earned its place

Optimization should be justified by one of:

- measured performance pain
- a repeated product issue
- a concrete user-experience requirement

Avoid “just in case” cleverness.

### 7. Make policy layers replaceable

Optimization code should be easy to:

- disable
- swap out
- simplify later

If it cannot be removed without rewriting the feature, it is probably too central.

### 8. Refactor when the workaround becomes the model

The danger moment is when:

- people explain the system using the workaround
- the workaround shapes public APIs
- other features start depending on the workaround directly

That is the time to extract a new boundary.

## Smell Tests

Use these in PR review or refactor planning:

- Does the feature still work if the optimization is turned off?
- Can I explain the subsystem without leading with timers, cache states, or batching rules?
- Is one class acting as truth owner, scheduler, cache, and recovery engine at the same time?
- Did we add a policy decision into a low-level infrastructure class?
- Are we preserving clever behavior because it is useful, or because it is now fused to correctness?

## Quarterdeck-Specific Pattern To Watch

Quarterdeck is especially vulnerable to optimization-shaped architecture in places that mix:

- long-lived runtime state
- websocket/event streaming
- UI restore/reconnect behavior
- project switching
- terminal/session UX

When working in those areas, prefer:

- narrow owner of truth
- explicit attachment/translation layers
- optional policy modules for caching, batching, prewarm, or prioritization

## Companion Docs

- `docs/design-weaknesses-roadmap.md`
- `docs/terminal-architecture-refactor-brief.md`
- `docs/optimization-shaped-architecture-followups.md`
