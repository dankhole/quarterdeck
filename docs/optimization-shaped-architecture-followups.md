# Optimization-Shaped Architecture Follow-ups

Purpose: track subsystems where a simple core job has become too entangled with caching, polling, batching, preloading, or recovery logic.

This is the recurring design smell behind several current refactor candidates:

- the clever behavior is useful
- the system should keep most of it
- but the clever behavior has become too central to the architecture

Use `docs/design-guardrails.md` as the reusable rulebook and `docs/todo.md` for execution tracking.

Execution tracking note:

- `docs/todo.md` is the source of truth for active follow-up work.
- Each subsystem listed here should map cleanly to a todo item in the “Optimization-shaped architecture follow-ups” section.

## Priority Order

### 1. Project metadata monitor

Primary file:

- `src/server/project-metadata-monitor.ts`

Simple job:

- know the current project/task metadata

What it also became:

- polling scheduler
- focused-vs-background prioritizer
- remote fetch policy engine
- concurrency coordination layer

Why it deserves follow-up:

- the TODO in the file already calls out blurred project identity and module-scoped guards
- metadata ownership is mixed with scheduling policy

Healthy direction:

- keep a clear metadata owner
- move polling/fetch/prioritization policy behind narrower boundaries

See `docs/project-metadata-monitor-refactor-brief.md`.

### 2. Project sync plus board cache restore

Primary files:

- `web-ui/src/hooks/project/use-project-sync.ts`
- `web-ui/src/runtime/project-board-cache.ts`

Simple job:

- apply runtime project state to the UI

What it also became:

- project-switch cache/restore system
- stale-write protection layer
- request cancellation system
- hydration policy engine

Why it deserves follow-up:

- sync correctness and cache optimization are too intertwined
- the cache shapes the project-switch architecture instead of staying a thin acceleration layer

Healthy direction:

- keep project-state application simple and authoritative
- push cache/restore policy behind a more explicit boundary

### 3. Terminal websocket bridge

Primary file:

- `src/terminal/ws-server.ts`

Planning brief:

- `docs/terminal-ws-server-refactor-brief.md`

Simple job:

- move terminal data between backend sessions and browser viewers

What it also became:

- buffering system
- multi-viewer coordination layer
- backpressure manager
- snapshot/restore timing controller

Why it deserves follow-up:

- the bridge is carrying a lot of transport policy
- correctness and performance behavior are hard to separate mentally

Healthy direction:

- preserve the useful backpressure and restore behavior
- make the bridge easier to explain in terms of connection ownership first, policy second

### 4. Runtime state message batcher

Primary file:

- `src/server/runtime-state-message-batcher.ts`

Simple job:

- coalesce outgoing runtime updates

What it also became:

- part of notification timing
- part of project-refresh timing
- part of stream semantics

Why it deserves follow-up:

- batching is not just an efficiency detail; it helps shape behavior
- that can be okay, but it should be more explicit

Healthy direction:

- preserve batching
- make the boundary between “event meaning” and “delivery policy” easier to see

### 5. Frontend runtime state stream store

Primary file:

- `web-ui/src/runtime/use-runtime-state-stream.ts`

Simple job:

- receive runtime stream messages and update frontend state

What it also became:

- preload-aware hydration layer
- reconnect strategy
- snapshot merge policy
- notification memory store

Why it deserves follow-up:

- transport policy and state ownership are tightly mixed
- it is doing more than “listen and apply”

Healthy direction:

- keep the reducer/store role clear
- isolate preload/reconnect/merge policy where possible

## Short Heuristic

If a subsystem becomes hard to explain without mentioning cache states, timers, batching windows, or prioritization rules, it is probably becoming optimization-shaped.

That does not mean the optimization should be removed. It usually means the optimization needs a cleaner boundary.
