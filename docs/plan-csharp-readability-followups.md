# C# Readability Follow-ups

Purpose: turn the TypeScript readability audit into concrete, low-risk refactor slices that make the codebase easier to navigate for developers coming from C# and other class/service-oriented ecosystems.

This is a follow-up to the codebase review that identified several areas where the code is correct enough but still expensive to read because orchestration, parsing, state coordination, and UI logic are spread across large files or mixed abstraction levels.

## Goals

- Make high-level control flow visible without reading hundreds of lines of local details
- Make domain rules easier to find with ctrl+click navigation
- Reduce "read two files to understand one behavior" situations
- Prefer named modules, typed contracts, and thin adapters over mixed-responsibility files

## 1. Split `App.tsx` into composition hooks and shell components — done

Primary file: `web-ui/src/App.tsx`

### Problem

`App.tsx` still acts like several things at once:

- composition root
- top-level effect orchestrator
- card action factory
- callback registry
- render surface

That makes the file read more like a merged controller + service locator + view than a clear React shell. A new reader has to hold too much state in their head before they can answer basic questions like "where do notifications come from?" or "what owns workspace persistence?"

### Why it is hard for C#-oriented readers

In a C# codebase, these concerns would usually be separated into a few named services or view-model-like collaborators. Here, the logic is technically typed, but the shape still forces the reader to scan a single large function body with a lot of interleaved setup.

### Refactor target

Keep `App.tsx` as a composition root and move grouped orchestration into named hooks/modules such as:

- `use-app-notifications`
- `use-app-workspace-persistence`
- `use-app-card-actions`
- `use-app-navbar-model`
- `use-home-side-panel-resize`

The end state should be:

- `App.tsx` wires providers and top-level surfaces
- composition hooks gather related inputs and produce a small, named view model
- JSX-heavy sections remain in components, not in the orchestration hook

### Done when

- `App.tsx` is substantially smaller and reads top-to-bottom as composition, not implementation
- notification/effect setup is grouped by concern behind named hooks
- card action creation is extracted from the main render function

## 2. Replace manual `unknown` normalization in `board-state.ts` with named parsers/schemas — done

Primary file: `web-ui/src/state/board-state.ts`

### Problem

The board normalization path relies on long stretches of manual shape checking:

- `normalizeTaskImages`
- `normalizeCard`
- `normalizeDependency`
- `normalizeBoardData`

This is safe enough, but it is noisy to read. The reader has to infer the data contract from repeated `typeof`, `Array.isArray`, and inline object casts.

### Why it is hard for C#-oriented readers

For someone used to DTOs, validators, or explicit serializers, this feels like business rules and validation are embedded in control flow instead of being named as contracts.

### Refactor target

Use explicit parser/schema helpers for board hydration, likely with `zod` since the repo already depends on it. The goal is not to validate everything twice; it is to make the contract legible.

Possible shape:

- `board-state-schema.ts` for raw persisted payload contracts
- `parseBoardCard`
- `parseBoardDependency`
- `parseBoardData`

Keep browser-specific defaults in the browser layer, but make the accepted raw shape explicit.

### Done when

- the normalization path reads as "parse, map, normalize" instead of "inspect each property inline"
- raw persisted board shapes are named and reusable
- tests can target parser behavior directly

## 3. Consolidate board rules so the browser layer is a thin adapter — done

Primary files:

- `src/core/task-board-mutations.ts`
- `web-ui/src/state/board-state.ts`

### Problem

The shared runtime mutation module is already relatively readable, but the browser layer still carries nearby responsibilities like:

- board normalization
- browser UUID generation
- dependency cleanup helpers
- drag/drop orchestration
- wrappers over runtime board mutations

The result is that a reader often has to compare the runtime module and the browser adapter to understand which rules are canonical and which are UI-only.

### Why it is hard for C#-oriented readers

This creates ambiguity around ownership. In a service-oriented design, readers want to know which module is authoritative for board behavior and which one is just adapting inputs for a specific runtime.

### Refactor target

Make the separation sharper:

- shared domain rules live in one pure module
- browser-specific concerns stay in the browser layer
- wrappers become obviously thin and mostly argument translation

Good extraction candidates:

- shared dependency cleanup logic
- shared normalization helpers where browser/runtime duplication is accidental
- explicit naming for browser-only helpers versus domain helpers

### Done when

- a reader can identify the canonical board rules module quickly
- `web-ui/src/state/board-state.ts` mostly adapts browser concerns instead of re-expressing domain logic
- duplicated concepts between the two layers are reduced

## 4. Break `cli.ts` startup into a named bootstrap pipeline — done

Primary file: `src/cli.ts`

### Problem

`startServer()` is understandable, but it is still a long procedural startup blob containing:

- lazy module loading
- startup cleanup phases
- workspace registry construction
- runtime hub setup
- backup startup
- runtime server creation
- shutdown closure assembly

The comments help, but the reader still has to scroll through one large function to understand the boot sequence.

### Why it is hard for C#-oriented readers

This is the kind of code that would usually become a bootstrapper, startup pipeline, or coordinator class with explicit phases. The missing piece is not type safety; it is named structure.

### Refactor target

Split `startServer()` into named helpers or a bootstrap module, for example:

- `loadRuntimeServerModules`
- `runStartupCleanupPhases`
- `createWorkspaceRegistryWithTracking`
- `createRuntimeServerHandle`

No class is required, but the code should read as a pipeline of named phases.

### Done when

- `startServer()` mostly narrates the boot flow
- each startup phase has a small, named helper
- the lazy import boundary remains intact

## 5. Decompose `terminal-slot.ts` so terminal concerns are easier to locate

Primary file: `web-ui/src/terminal/terminal-slot.ts`

### Problem

`TerminalSlot` still owns many terminal concerns at once:

- DOM parking and host-element management
- xterm construction and addon setup
- socket wiring
- restore handling
- visibility-change handling
- geometry and resize integration
- clipboard and keybinding behavior
- subscriber fanout

The earlier module extraction helped, but the class still feels like a large coordinator with too many reasons to change.

### Why it is hard for C#-oriented readers

This reads like a god object. Even with strong types, a new reader still has to inspect a long constructor and a broad instance API to answer simple questions like "where does reconnect logic live?" or "which layer owns restore versus rendering?"

### Refactor target

Push more ownership into clearly named collaborators so `TerminalSlot` reads as an orchestrator, not the implementation home for every terminal behavior.

Potential directions:

- separate lifecycle/reconnect behavior from presentation concerns
- make restore and visibility-refresh responsibilities more explicit
- reduce constructor setup noise with named factory/setup helpers

### Done when

- a reader can find reconnect, restore, and DOM-hosting logic without scanning the whole class
- the constructor mainly wires collaborators together
- `TerminalSlot` has a smaller, clearer responsibility boundary

## 6. Split `runtime-state-hub.ts` by client registry versus broadcast coordination

Primary file: `src/server/runtime-state-hub.ts`

### Problem

`RuntimeStateHubImpl` still combines several server-side coordination concerns:

- websocket client registry
- workspace-scoped client tracking
- summary batching
- debug-log batching
- resume-on-connect behavior
- metadata-monitor integration
- runtime broadcast APIs
- workspace disposal/cleanup

It is more navigable than before, but it is still a central coordinator with many moving parts.

### Why it is hard for C#-oriented readers

Readers coming from service-oriented codebases usually expect client/session bookkeeping to be separated from message production/broadcast policy. Here, both are interleaved in one implementation.

### Refactor target

Make the hub easier to reason about by separating:

- client registration and cleanup
- batching/flush behavior
- higher-level workspace broadcast APIs

The public surface can stay the same; the goal is internal ownership clarity.

### Done when

- client-lifecycle logic is not interleaved with every broadcast method
- batching behavior has a clear home
- the main hub implementation reads as coordination of smaller parts

## 7. Decompose `project-navigation-panel.tsx` into hooks and slimmer view components

Primary file: `web-ui/src/components/app/project-navigation-panel.tsx`

### Problem

The component currently owns too much view-model logic along with its render tree:

- optimistic reorder state
- drag/drop behavior
- removal confirmation state
- badge/count derivation
- portal logic for dragging
- large JSX surface

That makes it harder to treat the component as a mostly presentational UI.

### Why it is hard for C#-oriented readers

This looks like a view, a local controller, and a view-model all in one file. It is workable, but it raises the cost of understanding and safely changing the panel.

### Refactor target

Use the same approach that worked for `App.tsx`:

- extract local orchestration into one or two named composition hooks
- keep the component focused on rendering
- split sub-sections into smaller view components if that makes the structure clearer

### Done when

- the panel’s stateful behavior is grouped behind named hooks/helpers
- the main component reads top-to-bottom as UI composition
- drag/reorder and removal flows are easier to find in isolation

## 8. Reassess `terminal-pool.ts` for allocation-policy versus lifecycle splitting

Primary file: `web-ui/src/terminal/terminal-pool.ts`

### Problem

`terminal-pool.ts` is still large enough to suggest that multiple concerns may be mixed together:

- slot allocation policy
- lifecycle/release behavior
- pooling heuristics
- dedicated-versus-shared terminal coordination
- UI-facing integration points

This may be justified by the domain, but it is a likely readability hotspot.

### Why it is hard for C#-oriented readers

Pool/resource-management code is already cognitively dense. When policy and lifecycle coordination live together, readers have to reconstruct invariants by reading across the whole file.

### Refactor target

First reassess whether the current size reflects necessary complexity or removable coupling. If it does need cleanup, split by concept rather than just by line count:

- allocation and eviction policy
- slot lifecycle transitions
- public pool API and ownership rules

### Done when

- the main pool module makes its ownership rules and lifecycle easier to follow
- allocation policy is easier to inspect independently
- readers do not need to infer core invariants from unrelated UI-facing code

## Suggested sequence

Recommended order:

1. `App.tsx`
2. `board-state.ts` parser/schema cleanup
3. board rule consolidation between runtime and browser
4. `cli.ts` bootstrap decomposition
5. `project-navigation-panel.tsx`
6. `runtime-state-hub.ts`
7. `terminal-slot.ts`
8. reassess `terminal-pool.ts`

Why this order:

- the `App.tsx` work pays back immediately in daily frontend navigation
- parser/schema cleanup makes later board-state refactors safer
- board rule consolidation is easier once parsing boundaries are clearer
- `cli.ts` is independent and can happen in parallel if someone prefers backend work
- `project-navigation-panel.tsx` is a relatively safe frontend decomposition after the app-shell cleanup
- `runtime-state-hub.ts` is a strong backend readability target once the lower-risk items are done
- `terminal-slot.ts` is valuable but higher risk because terminal lifecycle bugs are easy to introduce
- `terminal-pool.ts` should be reassessed before committing to a larger refactor

## Risk notes

- `App.tsx` refactors should preserve existing provider boundaries and avoid re-expanding component prop drilling
- parser/schema work should not silently change persisted board compatibility
- board rule consolidation should preserve the single-writer board-state rule documented in `AGENTS.md`
- `cli.ts` decomposition must preserve lazy imports for command-style invocations
- terminal refactors should be treated as higher-risk because reconnect, restore, and focus behavior can regress subtly
- `runtime-state-hub.ts` changes should preserve existing websocket message timing and workspace disposal behavior

## Todo mapping

These suggestions are tracked in `docs/todo.md` under:

- `C# readability follow-ups`

Each todo item is intended to be independently shippable.
