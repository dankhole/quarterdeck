# Design Investigation Follow-ups

Purpose: track architectural and responsibility-boundary questions separately from readability-only refactors.

This document is for places where the concern is not just "this file is hard to read," but "the ownership boundaries may be wrong enough to create long-term bugs, change friction, or hidden coupling." Some of these may end in refactors; some may end in "the current design is justified, document the invariants and leave it alone."

## Goals

- Distinguish readability cleanup from actual architectural risk
- Investigate ownership boundaries before committing to large refactors
- Identify where overloaded coordinators or split authority may be causing ongoing change-cost
- Produce either targeted refactors or explicit "leave as-is" conclusions with rationale

## 1. Reassess board-state ownership between browser and runtime

Primary files:

- `web-ui/src/state/board-state.ts`
- `src/core/task-board-mutations.ts`

### Question

After the parser/schema cleanup and board-rule consolidation work, is there still any real split-authority problem between the browser layer and the runtime/core layer?

### Why this is a design question

If the browser and runtime layers both remain plausible "owners" of board rules, that is more than a readability issue. It means the domain boundary is still blurry and future changes may keep duplicating logic or introducing drift.

### Investigation target

- confirm there is one canonical home for board domain rules
- identify any remaining rule duplication or ambiguous ownership
- document whether the browser layer is truly just an adapter after the follow-up refactors

### Good outcome

One module is clearly authoritative for board rules, and the other is clearly an adapter.

## 2. Reassess terminal architecture across `terminal-slot.ts` and `terminal-pool.ts`

Primary files:

- `web-ui/src/terminal/terminal-slot.ts`
- `web-ui/src/terminal/terminal-pool.ts`

### Question

Do these files still hide shared invariants across pooling, restore, reconnect, focus, and DOM attachment in a way that creates real design risk?

### Why this is a design question

Terminal code is inherently stateful and cross-cutting. If key lifecycle invariants are spread across both modules, the issue is not just readability. It means the architecture may be relying on implicit coordination rather than explicit ownership.

### Investigation target

- map the core lifecycle invariants across slot and pool
- determine whether reconnect/restore/attachment ownership is explicit or implicit
- decide whether the real design unit is still wrong even after readability refactors

### Good outcome

Either:

- lifecycle ownership becomes clearly explicit, or
- the investigation concludes the current split is justified and documents the invariants that future changes must preserve

## 3. Reassess runtime coordination boundaries between `runtime-state-hub.ts` and `workspace-registry.ts`

Primary files:

- `src/server/runtime-state-hub.ts`
- `src/server/workspace-registry.ts`

### Question

Are these still acting as overlapping central coordinators, or do they have cleanly separated responsibilities after the readability work?

### Why this is a design question

If both modules remain "smart hubs" with overlapping authority, that is an architectural smell. It makes changes expensive because readers have to understand both systems before touching either.

### Investigation target

- identify whether ownership is split between registry, hub, and broadcast concerns in a coherent way
- confirm whether websocket streaming and workspace ownership are layered cleanly
- determine whether the code has a true service-boundary problem or just large implementation files

### Good outcome

The runtime layer has understandable service boundaries, even if some files remain large.

## 4. Reassess large UI components that still own workflow state

Primary candidates:

- `web-ui/src/components/app/project-navigation-panel.tsx`
- `web-ui/src/components/app/top-bar.tsx`
- git/history panels and other large UI orchestrators as needed

### Question

Are the remaining large components merely big, or do they still own too much workflow/state logic to count as healthy UI boundaries?

### Why this is a design question

When workflow logic lives in components too long, the result is not just hard-to-read JSX. It becomes harder to test behavior, reuse logic, or reason about state transitions independently from rendering.

### Investigation target

- identify which large components are truly presentational versus locally stateful controllers
- decide whether logic should live in hooks/domain modules instead
- avoid creating needless indirection where the component is already an appropriate boundary

### Good outcome

Large components are large for understandable UI reasons, not because they are hiding business/workflow orchestration.

## Investigation order

Recommended order:

1. board-state ownership
2. terminal slot/pool architecture
3. runtime-state-hub vs workspace-registry boundaries
4. remaining large UI components

Why this order:

- board-state ownership affects a core domain model used across browser/runtime boundaries
- terminal architecture is the highest-risk behavioral area after board-state
- runtime coordinator boundaries matter next if smart-hub coupling remains
- large UI component reassessment is valuable, but many concerns there may resolve naturally after the earlier work

## Output expectations

Each investigation should end in one of two ways:

1. A targeted refactor with clear ownership improvements
2. A documented conclusion that the current design is acceptable, plus any key invariants future work must preserve

Avoid "refactor because it feels ugly." The bar here is architectural value, not aesthetic cleanup.
