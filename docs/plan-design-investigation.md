# Design Investigation Follow-ups

Purpose: track architectural and responsibility-boundary questions separately from readability-only refactors.

This document is for places where the concern is not just "this file is hard to read," but "the ownership boundaries may be wrong enough to create long-term bugs, change friction, or hidden coupling." Some of these may end in refactors; some may end in "the current design is justified, document the invariants and leave it alone."

## Goals

- Distinguish readability cleanup from actual architectural risk
- Investigate ownership boundaries before committing to large refactors
- Identify where overloaded coordinators or split authority may be causing ongoing change-cost
- Produce either targeted refactors or explicit "leave as-is" conclusions with rationale

## 1. Reassess board-state ownership between browser and runtime — done

Primary files:

- `web-ui/src/state/board-state.ts`
- `src/core/task-board-mutations.ts`

**Conclusion (cbf81f71):** Board rule consolidation confirmed `task-board-mutations.ts` as the canonical owner of board domain rules. The browser-side `board-state.ts` is a thin adapter that applies mutations and manages persistence — no remaining rule duplication or split authority.

## 2. Reassess terminal architecture across `terminal-slot.ts` and `terminal-pool.ts` — done

Primary files:

- `web-ui/src/terminal/terminal-slot.ts`
- `web-ui/src/terminal/terminal-pool.ts`

**Conclusion (c9abe225):** Slot decomposed into `terminal-slot.ts` (orchestrator) + `slot-dom-host.ts` (DOM hosting/parking) + `slot-visibility-lifecycle.ts` (refresh/reconnect). Pool split into shared-pool policy + `terminal-dedicated-registry.ts` (dedicated-terminal ownership with different lifecycle rules). Lifecycle ownership is now explicit across named collaborators.

## 3. Reassess runtime coordination boundaries between `runtime-state-hub.ts` and `workspace-registry.ts` — done

Primary files:

- `src/server/runtime-state-hub.ts`
- `src/server/workspace-registry.ts`

**Conclusion (c9abe225):** Hub split into coordinator + `runtime-state-client-registry.ts` (WebSocket client bookkeeping/cleanup) + `runtime-state-message-batcher.ts` (summary/debug-log batching). Service boundaries are now understandable — hub coordinates, registry tracks clients, batcher coalesces messages.

## 4. Reassess large UI components that still own workflow state — done

Primary candidates:

- ~~`web-ui/src/components/app/project-navigation-panel.tsx`~~ — Decomposed (c9abe225)
- ~~`web-ui/src/components/app/top-bar.tsx`~~ — Decomposed on the current branch
- other large UI orchestrators are better tracked as Phase 3 component decomposition work in `docs/todo.md`

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

## Status

Items 1–4 completed. The remaining large-component cleanup is now tracked in one place under Phase 3 in `docs/todo.md` rather than split between this investigation doc and the main todo list.
