# Project Metadata Monitor Follow-ups

Purpose: capture the two remaining architectural follow-ups that surfaced after the `project-metadata-monitor` refactor landed, so they stay visible without being treated like urgent bugs.

This document is intentionally narrower than [`project-metadata-monitor-refactor-brief.md`](./project-metadata-monitor-refactor-brief.md). The refactor itself is done; these are the next design questions that became easier to see once the controller / refresher / poller / remote-fetch split was in place.

## Why This Exists

The refactor fixed the real correctness issue that was worth addressing immediately:

- module-scoped refresh/fetch guards could block refreshes in other connected projects

It also improved the manual task refresh path by routing focused and non-focused task refreshes through the same per-task machinery.

What remains are two deeper ownership/concurrency follow-ups:

1. shared mutable `ProjectMetadataEntry` coupling
2. `refreshProject()` vs per-task refresh overwrite races

These are worth tracking, but they are not the same class of problem as the old module-scoped guards. Addressing them cleanly requires a stronger state-ownership model, not just a small patch.

## Follow-up 1: Shared Mutable `ProjectMetadataEntry` Coupling

### Current shape

- `ProjectMetadataController` owns the per-project lifecycle and creates the `ProjectMetadataEntry`
- `ProjectMetadataRefresher` receives that same entry by reference and mutates it directly
- the poller and remote-fetch policy trigger refresh work that also mutates the same entry indirectly through the refresher

This is workable, but it means the refresher is not an isolated "pure refresh coordinator." It depends on the controller and refresher cooperating around shared mutable state.

### Why it is a design smell

The refactor goal was to separate:

- per-project ownership/lifecycle
- refresh logic
- polling cadence
- remote freshness policy

Passing one mutable entry across those boundaries keeps the code understandable enough, but the boundary is still softer than ideal. The refresher can be reasoned about locally only if callers avoid changing key fields such as:

- `entry.trackedTasks`
- `entry.focusedTaskId`
- `entry.taskMetadataByTaskId`

mid-refresh.

### Why this was not fixed in the refactor pass

Solving this properly is not a tiny cleanup. It would require choosing and applying a stronger ownership rule, for example:

- controller is the only mutator; refresher returns patches or next-state values
- controller owns writes and refresher becomes a pure "load and compute next values" service
- entry state is split into smaller owned stores instead of one shared mutable object

Any of those options changes the model more substantially than the refactor brief required.

### Healthy direction

Move toward a model where `ProjectMetadataController` is the clear state owner and the refresher is either:

- a pure state transition helper, or
- a narrower service that returns refresh results instead of mutating shared state directly

The key outcome is not "zero mutation." The key outcome is "one place clearly owns mutation."

## Follow-up 2: `refreshProject()` vs Per-task Refresh Overwrite Races

### Current shape

There are now two broad classes of refresh:

- full-project refreshes via `refreshProject()`
- targeted task refreshes via focused/background/manual task refreshes

Both ultimately load metadata and then write results back into `entry.taskMetadataByTaskId`.

### Why this can race

A typical race looks like:

1. `refreshProject()` starts and snapshots the current tracked tasks
2. a focused/manual task refresh starts for one task
3. the task refresh finishes first and writes newer metadata for that task
4. the full refresh finishes later and replaces the map with an older value it loaded earlier

That means "last writer wins" is not always "freshest writer wins."

This race is not new. The old monolithic monitor had the same general shape. The refactor just makes the competing write paths easier to see.

### Why this was not fixed in the refactor pass

Fixing this cleanly requires choosing merge semantics, not just adding another guard. Some plausible options:

- serialize full-project and targeted task refresh writes through one controller-owned commit path
- keep per-task freshness/version markers and reject stale overwrites
- have `refreshProject()` merge per-task results into the current map instead of replacing it wholesale
- treat task refreshes as authoritative for their task if they finish after the full refresh started

Each option has behavior tradeoffs and should be chosen deliberately.

### Healthy direction

Make refresh result application explicit and freshness-aware. The system should prefer:

- "newer task result wins for that task"

over:

- "last async writer wins for the whole map"

The exact mechanism can vary, but the merge rule should become intentional instead of incidental.

## What Is Not Being Claimed

This doc does **not** claim:

- the current implementation is broken in normal usage
- the refactor should be reconsidered
- another immediate architecture split is required

The current design is a good improvement. These are simply the next two places where ownership and concurrency are still softer than ideal.

## Suggested Trigger For Doing This Work

Pick up these follow-ups if any of the following happen:

- another metadata bug appears that smells like stale overwrites or surprising refresh interleavings
- more refresh entry points are added and `taskMetadataByTaskId` write coordination gets harder to reason about
- `ProjectMetadataRefresher` starts growing more controller-style state management responsibilities
- future work needs stronger guarantees about refresh ordering or freshness

## Acceptance Criteria For A Future Pass

This follow-up work should feel done when:

- per-project metadata state has one clear mutation owner
- the refresher boundary is easier to describe without caveats about shared mutable entry state
- full refresh and task refresh writes have an explicit freshness/merge rule
- targeted tests cover at least one stale-overwrite scenario directly
