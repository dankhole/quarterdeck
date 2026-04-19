# Project Metadata Monitor Refactor Brief

Purpose: give a future agent enough context to plan and execute a `project-metadata-monitor` refactor without needing prior conversation context.

This brief does not argue that the current metadata UX is wrong. The goal is to preserve the useful git-status behavior while simplifying the architecture so metadata ownership and refresh policy are not tightly coupled.

Execution tracking note:

- `docs/todo.md` is the source of truth for when this refactor should be worked on.
- The matching active todo item lives under “Optimization-shaped architecture follow-ups.”

## Summary

Quarterdeck's project metadata monitor has real jobs that must stay intact:

- publish home-repo git summary, conflict state, and stash count
- publish per-task worktree metadata for active board tasks
- keep the focused task fresher than background tasks
- refresh remote tracking refs often enough that ahead/behind counts stay credible
- avoid doing unnecessary git work for backlog/trash tasks or disconnected projects
- broadcast metadata updates only when the effective snapshot changes

The current weakness is not "the monitor polls too much." The weakness is that metadata ownership is too entangled with scheduling and freshness policy. The same module currently acts as:

- project metadata owner
- polling scheduler
- focused-vs-background prioritizer
- remote fetch policy engine
- broadcast coordinator

Healthy target:

- metadata loading and cached truth stay authoritative
- per-project lifecycle is explicit
- polling becomes a policy layer over refresh operations
- remote fetch becomes a separate freshness policy instead of part of the core model

If focused/background prioritization were disabled temporarily, metadata should still load correctly. It may become less efficient, but it should not become confusing or wrong.

## Relevant Files Today

Primary backend files:

- `src/server/project-metadata-monitor.ts`
- `src/server/project-metadata-loaders.ts`
- `src/server/runtime-state-hub.ts`

Related frontend consumers:

- `web-ui/src/hooks/board/use-board-metadata-sync.ts`
- `web-ui/src/stores/project-metadata-store.ts`

Related tests:

- `test/integration/state-streaming.integration.test.ts`
- `test/runtime/trpc/project-api-git-mutations.test.ts`
- `test/runtime/trpc/project-api-stash.test.ts`

Related docs:

- `docs/architecture.md`
- `docs/design-weaknesses-roadmap.md`
- `docs/optimization-shaped-architecture-followups.md`
- `docs/implementation-log.md`

## Current Mental Model

There are really three concerns in play, but the current code blends them together:

1. Metadata truth
   The runtime needs to know the current git state for the home repo and for task worktrees.

2. Refresh orchestration
   The runtime decides when to refresh home metadata, when to prioritize the focused task, and when to sweep background tasks.

3. Freshness policy
   The runtime periodically fetches remotes, invalidates cached state tokens, and triggers follow-up refreshes so ahead/behind counts and base-relative indicators stay accurate.

In the current design, these concerns are mixed enough that "how project metadata works" is hard to explain without talking about timers, background polling, and fetch cadence.

### Current flow model

Rough flow for a connected project:

1. `RuntimeStateHub` creates one shared monitor service and asks it to connect a project when the first websocket client attaches.
2. `connectProject()` updates tracked tasks from board state, starts timers, kicks a background remote fetch, and runs a full refresh.
3. `refreshHome()`, `refreshFocusedTask()`, and `refreshBackgroundTasks()` call the loader layer and update cached metadata.
4. `broadcastIfChanged()` compares snapshots and emits `project_metadata_updated` only when the effective payload changed.
5. Frontend consumers apply metadata to the external store and self-heal card branch/working-directory fields when the monitor reports drift.

### Current design smell

The system currently reads like:

`project metadata = cached git truth + polling cadence + fetch policy + broadcast timing`

That means optimization and freshness policy are part of the main architecture, not an implementation detail.

## What Must Not Be Lost

The refactor should not regress these behaviors:

- websocket clients still receive initial snapshot first and metadata updates after connection
- metadata broadcasts still happen only when the effective snapshot changes
- home repo git summary, conflict state, and stash count stay accurate
- focused task refresh remains more responsive than background task refresh
- remote fetch still keeps ahead/behind counts and behind-base indicators from going stale forever
- disconnected projects stop background git churn
- backlog and trash tasks stay excluded from polling
- task branch changes can still trigger base-ref updates

The desired tradeoff is:

- preserve product behavior
- preserve the worthwhile freshness and performance characteristics
- simplify reasoning about ownership and correctness

## Current Constraints And Gotchas

These are easy places to accidentally regress behavior during the refactor:

- The in-flight guards are module-scoped booleans today, not per-project state. A refresh in one project can block the same refresh type in another project. Fixing that is part of the point of the refactor, but it must be replaced with per-project dedupe rather than unlimited fan-out.
- The global `pLimit(3)` probe limit is useful. The refactor should not accidentally turn that into "three probes per project" unless the extra subprocess load is intentional.
- `requestTaskRefresh()` has a special non-focused code path today. It should converge on the same task-refresh logic as focused/background refreshes instead of preserving asymmetric side effects.
- The current stream contract intentionally sends `snapshot.projectMetadata = null` first, then a later `project_metadata_updated` message. Tests rely on that behavior.
- The monitor currently conflates several identities under "project": the project root path, the runtime connection scope, the monitor entry, and task worktree metadata rooted under that project. The new design should make these boundaries clearer, not harden the ambiguity.
- There is an active bug around task metadata drifting to the agent's current cwd instead of the assigned worktree when `worktreeAddQuarterdeckDir` is enabled. The refactor should leave room to fix that cleanly rather than baking in the wrong identity model.

## Target Mental Model

The cleaner model is:

1. There is one metadata cache per connected project.
2. Refresh operations update that cache.
3. Polling and remote fetch are optional policy layers that ask for refreshes.
4. Broadcasting is a consequence of snapshot changes, not part of refresh policy itself.

That lets the system be explained simply:

- loaders = read git state
- controller = own per-project metadata state
- refresher = update state from loaders
- poller/fetch policy = decide when to ask for refresh

## Proposed Architecture

### 1. `ProjectMetadataController`

Per-project state holder and lifecycle owner.

Responsibilities:

- own one project's mutable metadata state
- track project path, focused task id, tracked tasks, subscriber count
- hold cached home metadata and cached task metadata
- hold per-project refresh/fetch promises
- expose start/stop/dispose hooks for policy layers

What it should not own:

- git probing logic
- timer setup details
- remote fetch behavior

Likely source material today:

- `ProjectMetadataEntry`
- `updateProjectEntry()`
- connection/disconnection lifecycle in `project-metadata-monitor.ts`

### 2. `ProjectMetadataRefresher`

Per-project refresh coordinator over the loader layer.

Responsibilities:

- refresh home metadata
- refresh one task
- refresh background tasks
- refresh all tracked metadata
- update caches
- detect branch/base-ref changes
- compare snapshots and invoke broadcast callbacks when changed

What it should not own:

- interval timers
- remote fetch cadence
- project registration across multiple projects

Likely source material today:

- `refreshHome()`
- `refreshFocusedTask()`
- `refreshBackgroundTasks()`
- `refreshProject()`
- `broadcastIfChanged()`
- `checkForBranchChanges()`

### 3. `ProjectMetadataPoller`

Thin timer-based policy layer for refresh cadence.

Responsibilities:

- start/stop timers for home, focused-task, and background-task refreshes
- apply poll-interval changes
- trigger refresh requests through the refresher

What it should not own:

- cached metadata
- git probing
- websocket broadcasting

Likely source material today:

- `startTimers()`
- `stopAllTimers()`
- `setPollIntervals()`

### 4. `ProjectMetadataRemoteFetchPolicy`

Separate freshness policy for remote tracking refs.

Responsibilities:

- run `git fetch --all --prune` on a controlled cadence
- dedupe fetches per project
- invalidate cached metadata as needed after a successful fetch
- request follow-up home/focused refreshes

What it should not own:

- full metadata model
- timer cadence for home/focused/background refresh
- websocket broadcasting

Likely source material today:

- `performRemoteFetch()`
- `REMOTE_FETCH_INTERVAL_MS`

### 5. `ProjectMetadataMonitor`

Top-level registry/facade over multiple project controllers.

Responsibilities:

- keep the public monitor API stable
- create or look up per-project controllers
- wire controller callbacks into `RuntimeStateHub`
- coordinate connect/update/disconnect/dispose at project scope

What it should not own:

- project refresh details
- project timer logic
- remote fetch semantics

This layer should read primarily as service composition.

## Concrete Design Principle

Separate the system into:

- metadata truth layer
- per-project refresh/controller layer
- policy layer for polling and remote freshness

The policy layer may remain clever. The important boundary is that a broken policy should degrade freshness or efficiency, not correctness.

Smell test:

If background polling were temporarily disabled, should metadata still load and broadcast correctly when explicitly refreshed?

Desired answer: yes.

## Proposed File-Level Direction

This does not need to happen all at once, but the target shape could look roughly like this:

- `src/server/project-metadata-monitor.ts`
- `src/server/project-metadata-controller.ts`
- `src/server/project-metadata-refresher.ts`
- `src/server/project-metadata-poller.ts`
- `src/server/project-metadata-remote-fetch.ts`
- `src/server/project-metadata-loaders.ts`

Possible existing files to preserve mostly as collaborators:

- `project-metadata-loaders.ts`
- `runtime-state-hub.ts`

Possible existing files to slim down or replace:

- `project-metadata-monitor.ts`

## Suggested Rollout

This refactor should be done in small passes, not as one giant move:

1. Add test coverage for current semantics, especially stream timing and per-project independence.
2. Introduce a per-project controller type with no intended behavior change.
3. Move refresh logic into a refresher module.
4. Move poll timers into a dedicated poller.
5. Move remote fetch logic into a dedicated policy module.
6. Replace module-scoped in-flight booleans with per-controller promise-based dedupe.
7. Clean up naming and remaining glue once the structure is proven by tests.

## Test Plan Expectations

Before or during the refactor, lock down these behaviors:

- two connected projects can refresh independently
- focused-task refresh does not get starved by background refresh
- manual `requestTaskRefresh()` behaves consistently for focused and non-focused tasks
- branch changes still trigger base-ref update callbacks
- remote fetch invalidates stale home/task metadata and causes follow-up refresh
- disconnecting the last subscriber stops all polling/fetch timers for that project
- initial runtime snapshot remains metadata-null and later metadata arrives via stream update

## Open Design Choices

These choices should be made explicitly before or during implementation:

- whether controller instances should be deleted immediately on last disconnect or retained briefly as a cache
- whether remote fetch remains timer-based for every connected project or becomes more selective
- whether the shared probe limiter should remain hard-coded or become an injected dependency
- whether worktree metadata should be explicitly modeled as "assigned path" versus "observed cwd" to support the known `worktreeAddQuarterdeckDir` bug fix cleanly

## Acceptance Criteria

The refactor is done when:

- `project-metadata-monitor.ts` reads primarily as project-scope registration and wiring
- per-project state and in-flight work are explicit rather than module-scoped
- polling/fetch policy can be explained separately from metadata truth
- runtime stream behavior remains intact
- the code is easier to explain without leading with timers and fetch cadence
