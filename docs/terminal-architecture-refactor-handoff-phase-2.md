# Terminal Architecture Refactor Handoff: Through Phase 5

Purpose: capture the current terminal refactor state after the first five extraction passes so a future session can clear context and continue with measurement and possible simplification from a stable starting point.

This handoff complements:

- [docs/terminal-architecture-refactor-brief.md](./terminal-architecture-refactor-brief.md)
- [docs/todo.md](./todo.md)
- [docs/design-guardrails.md](./design-guardrails.md)

## Current Branch / Commit

- Branch: `feature/terminal-refactor`
- Latest committed checkpoint: `907d1e22` — `refactor: close out terminal architecture split`
- Base: branch was verified to be up to date with local `main` before the terminal commit

This handoff now reflects the Phase 5 prewarm-policy extraction and the final closeout commit on `feature/terminal-refactor`.

## What The Refactor Has Accomplished So Far

The first five passes completed the session-side extraction, a real viewport extraction, an explicit attachment layer, a narrower pooled-task reuse boundary, and an explicit prewarm policy boundary, but did not finish the full brief.

### Done

1. Introduced a frontend session object:
   - `web-ui/src/terminal/terminal-session-handle.ts`
   - This now owns task/project identity, socket lifecycle, restore round-trip timing, summary/error delivery, stop behavior, and shell-only exit notifications.

2. Slimmed `TerminalSlot` toward a viewport/orchestrator role:
   - `web-ui/src/terminal/terminal-slot.ts`
   - It still owns xterm + several viewport concerns, but it no longer directly owns raw socket/task/project session state.

3. Made the shell-vs-agent surface split more explicit in the UI:
   - `web-ui/src/components/terminal/persistent-terminal-panel-layout.tsx`
   - `web-ui/src/components/terminal/shell-terminal-panel.tsx`
   - `web-ui/src/components/terminal/agent-terminal-panel.tsx`
   - `web-ui/src/components/app/home-view.tsx`
   - `web-ui/src/components/task/card-detail-view.tsx`

4. Clarified tribal knowledge:
   - `AGENTS.md` now explicitly says task agent terminals and shell terminals must stay behaviorally separate.

5. Extracted a frontend viewport object:
   - `web-ui/src/terminal/terminal-viewport.ts`
   - This now owns xterm creation, DOM host/parking, renderer lifecycle, resize management, buffered writes into xterm, viewport presentation behavior, appearance updates, focus, and buffer inspection.

6. Slimmed `TerminalSlot` into more of a compatibility wrapper:
   - `web-ui/src/terminal/terminal-slot.ts`
   - It now mostly coordinates `TerminalSessionHandle` + `TerminalViewport` while preserving the existing public API expected by the pool and dedicated-terminal paths.

7. Introduced an explicit attachment/controller layer:
   - `web-ui/src/terminal/terminal-attachment-controller.ts`
   - This now binds one `TerminalSessionHandle` to one `TerminalViewport` and owns restore application sequencing, session-to-viewport event routing, connection-ready-after-restore coordination, and safe show/hide/park attachment behavior.

8. Reduced `TerminalSlot` to compatibility + prompt helpers:
   - `web-ui/src/terminal/terminal-slot.ts`
   - It now mainly preserves the old external API, owns the visibility lifecycle wrapper, and keeps prompt-detection helpers for callers that still think in terms of slots.

9. Introduced a reuse-facing task terminal manager:
   - `web-ui/src/terminal/terminal-reuse-manager.ts`
   - App-facing pooled task-terminal consumers now call reuse-manager APIs like `acquireTaskTerminal`, `releaseTaskTerminal`, `stageTaskTerminalContainer`, `requestTaskTerminalPrewarm`, and `cancelTaskTerminalPrewarmRequest` instead of importing raw pool verbs directly.

10. Shifted app-facing call sites onto the reuse manager:
   - `web-ui/src/terminal/use-persistent-terminal-session.ts`
   - `web-ui/src/hooks/app/use-app-action-models.ts`
   - These call sites no longer need to think in terms of `TerminalSlot`, `attachPoolContainer`, `acquireForTask`, or `releaseTask`.

11. Introduced an explicit prewarm policy layer:
   - `web-ui/src/terminal/terminal-prewarm-policy.ts`
   - Hover-driven “likely next terminal” behavior is now expressed as optional policy instead of app code calling reuse/pool prewarm functions directly.

12. Moved hover-triggered prewarm behavior behind the policy:
   - `web-ui/src/hooks/app/use-app-action-models.ts`
   - The app now asks the prewarm policy to handle hover enter/leave, which makes the optimization easier to disable or replace without affecting terminal correctness.

### Not Done

All five target pieces from the brief now exist:

- `TerminalSessionHandle`
- `TerminalViewport`
- `TerminalAttachmentController`
- `TerminalReuseManager`
- `TerminalPrewarmPolicy`

The current system is much closer to the target “viewer attaches to session; reuse is optional policy” mental model, but the remaining question is whether the current prewarm behavior still earns its complexity and whether more of the pool state machine should be simplified or hidden internally.

## Important Behavioral Distinction

Do not regress this split:

- Task agent terminals:
  - task-scoped
  - use the shared/pool path
  - represent agent sessions
  - should not inherit shell-only restart/exit assumptions

- Shell terminals:
  - home shell and detail shell
  - dedicated terminals, not shared-pool terminals
  - workspace/manual shell behavior
  - have different restart and exit handling

This distinction is now clearer in the component layer and preserved through the new attachment controller, but it is still easy to blur again if later reuse/pool refactors ignore the dedicated-shell vs pooled-agent split.

## Current Terminal Shape

### Session-side layer

- `web-ui/src/terminal/terminal-session-handle.ts`

Current responsibilities:

- connect/reconnect IO + control sockets
- own connected `taskId` / `projectId`
- handle restore events and restore timing
- stream summary/error/output/exit notifications to subscribers
- stop a session
- preserve shell-only `onExit` behavior

This is the strongest completed part of Phase 1.

### Viewport layer

- `web-ui/src/terminal/terminal-viewport.ts`

Current responsibilities:

- xterm creation
- DOM parking/staging
- renderer lifecycle
- resize behavior
- buffered writes into xterm
- viewport show/hide/reveal behavior
- appearance updates
- input/paste/focus/clear/reset
- buffer inspection

What it still does not solve:

- pool/reuse policy as an internal detail

### Attachment layer

- `web-ui/src/terminal/terminal-attachment-controller.ts`

Current responsibilities:

- bind one session handle to one viewport
- route live output and control flow between them
- own restore application sequencing
- own connection-ready coordination after restore/show
- own safe attach/show/hide/park behavior
- translate session state changes into viewport resize nudges

This is the main Phase 3 extraction.

### Slot compatibility layer

- `web-ui/src/terminal/terminal-slot.ts`

Current role:

- preserve the public API expected by `terminal-pool.ts`, `terminal-dedicated-registry.ts`, and `use-persistent-terminal-session.ts`
- hold the attachment controller
- own the visibility lifecycle wrapper
- own prompt heuristics for terminal controller callers

Interpretation: `TerminalSlot` is now much closer to “legacy compatibility shell” than to “the implementation home for terminal behavior.”

### Pool / dedicated split

- `web-ui/src/terminal/terminal-pool.ts`
- `web-ui/src/terminal/terminal-dedicated-registry.ts`
- `web-ui/src/terminal/terminal-reuse-manager.ts`

This split predates the new commit and is still valid:

- shared task terminals are pool-managed
- dedicated shell terminals are not pool-managed

The pool still exposes role-state vocabulary (`FREE`, `PRELOADING`, `READY`, `ACTIVE`, `PREVIOUS`) directly, which the brief says should eventually become more internal.

The new reuse manager now sits in front of that vocabulary for normal app call sites, but it is still mostly a narrow facade over the existing pool implementation rather than a full internal rewrite.

### Prewarm policy layer

- `web-ui/src/terminal/terminal-prewarm-policy.ts`

Current responsibilities:

- decide whether hover-based prewarm should run at all
- translate “likely next task” UI signals into prewarm/cancel-prewarm requests
- keep that behavior optional and replaceable without changing correctness flows

Current limitation:

- the policy currently uses a simple always-on flag and existing hover heuristics
- measurement and possible simplification/removal are still future work

## Recommended Next Slice

The next pass should probably measure and then simplify. The architectural seams are now in place, so the highest-value remaining work is deciding what policy should survive.

### Next target: measure and simplify policy

The main remaining design debt is no longer “there is no policy boundary.” The remaining problem is that the reuse manager still delegates into a pool whose responsibilities include:

- `FREE`
- `PRELOADING`
- `READY`
- `ACTIVE`
- `PREVIOUS`

The next pass should:

- re-measure whether hover prewarm materially improves perceived switching latency
- decide whether the current prewarm policy should stay, become configurable, or be removed
- keep pooled task-terminal reuse as an internal implementation detail
- let prewarm remain optional policy instead of core architecture
- preserve quick switch-back behavior
- preserve dedicated shell terminals as a separate path
- avoid teaching future maintainers slot-role state machines just to understand task switching

Practical rule: if prewarming were disabled tomorrow, the rest of the terminal stack should keep working without conceptual or behavioral breakage.

## Concrete Code Smells Still Present

These are good guides for what remains to extract:

1. `TerminalSlot` still owns restore completion choreography.
   - Fixed by `TerminalAttachmentController`.

2. `TerminalSlot` still translates session events into viewport actions directly.
   - Fixed by `TerminalAttachmentController`.

3. `usePersistentTerminalSession()` still thinks in terms of a terminal handle, but no longer imports raw pool verbs directly.
   - This is improved, and the next cleanup is to keep the handle vocabulary stable while further internalizing pool/policy complexity.

4. The pool is still the vocabulary for internal reuse behavior.
   - Fine for now, but still a candidate for later simplification if the retained policy surface shrinks.

## Files Most Relevant For The Next Pass

Primary files:

- `web-ui/src/terminal/terminal-session-handle.ts`
- `web-ui/src/terminal/terminal-viewport.ts`
- `web-ui/src/terminal/terminal-attachment-controller.ts`
- `web-ui/src/terminal/terminal-reuse-manager.ts`
- `web-ui/src/terminal/terminal-prewarm-policy.ts`
- `web-ui/src/terminal/terminal-slot.ts`
- `web-ui/src/terminal/use-persistent-terminal-session.ts`
- `web-ui/src/terminal/terminal-pool.ts`
- `web-ui/src/terminal/slot-dom-host.ts`
- `web-ui/src/terminal/slot-renderer.ts`
- `web-ui/src/terminal/slot-resize-manager.ts`
- `web-ui/src/terminal/slot-visibility-lifecycle.ts`
- `web-ui/src/terminal/slot-write-queue.ts`

UI/context files touched by the shell-vs-agent split:

- `web-ui/src/components/terminal/agent-terminal-panel.tsx`
- `web-ui/src/components/terminal/shell-terminal-panel.tsx`
- `web-ui/src/components/terminal/persistent-terminal-panel-layout.tsx`
- `web-ui/src/components/app/home-view.tsx`
- `web-ui/src/components/task/card-detail-view.tsx`

## Verified Behavior Before This Handoff

These checks were run successfully around the first five terminal refactor passes:

```bash
npm --prefix web-ui run test -- src/terminal/use-persistent-terminal-session.test.tsx src/terminal/terminal-pool-dedicated.test.ts src/terminal/terminal-pool-acquire.test.ts src/terminal/terminal-pool-lifecycle.test.ts
npm --prefix web-ui run typecheck
npx @biomejs/biome check web-ui/src/components/terminal/agent-terminal-panel.tsx web-ui/src/components/terminal/persistent-terminal-panel-layout.tsx web-ui/src/components/terminal/shell-terminal-panel.tsx web-ui/src/components/terminal/index.ts web-ui/src/components/app/home-view.tsx web-ui/src/components/task/card-detail-view.tsx AGENTS.md
npx @biomejs/biome check web-ui/src/terminal/terminal-slot.ts web-ui/src/terminal/terminal-viewport.ts web-ui/src/terminal/terminal-attachment-controller.ts web-ui/src/terminal/terminal-reuse-manager.ts web-ui/src/terminal/terminal-prewarm-policy.ts web-ui/src/terminal/terminal-session-handle.ts web-ui/src/terminal/use-persistent-terminal-session.ts web-ui/src/hooks/app/use-app-action-models.ts web-ui/src/terminal/use-persistent-terminal-session.test.tsx docs/terminal-architecture-refactor-handoff-phase-2.md
```

If the next pass changes viewport/attachment boundaries, rerun the same terminal-focused tests at minimum.

## Guardrails For The Next Session

1. Preserve shell-vs-agent behavior separation even if some abstractions get renamed again.
2. Do not let `TerminalViewport` learn task/project identity in any direct semantic way.
3. Do not move prewarm/pool policy into the viewport or future attachment layers.
4. `TerminalSlot` is now a compatibility layer, not the desired end state.
5. Prefer measuring/simplifying policy before adding new cleverness on top of the current seams.

## Recommended Starting Prompt For The Next Session

“Read `docs/terminal-architecture-refactor-brief.md` and `docs/terminal-architecture-refactor-handoff-phase-2.md`, then assess whether the current hover prewarm policy still earns its complexity. Keep shell-vs-agent behavior separate, preserve reconnect/restore and quick switch-back behavior, and treat prewarm as optional policy rather than correctness-critical architecture.”
