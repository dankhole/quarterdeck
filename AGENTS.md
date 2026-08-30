# Quarterdeck Agent Instructions

`AGENTS.md` is the canonical repo-owned shared agent-instructions file. Keep `CLAUDE.md` as a tiny Claude Code compatibility shim that imports `@AGENTS.md`; do not duplicate shared rules or project documentation there. Human-facing setup, architecture, and developer guidance belongs in `README.md`, `DEVELOPMENT.md`, or `docs/`.

This file contains universal rules and routes specialized work to the smallest relevant reference. Read a routed document before changing that area; do not bulk-read unrelated convention or history documents.

## Maintaining these instructions

Add high-signal guidance when an issue required user correction, several failed attempts, a non-obvious cross-file investigation, or behavior that contradicted reasonable expectations. Record durable architecture and forensic detail in the relevant project document; keep only the universal rule or routing trigger here. Do not add routine facts discoverable from a few files.

When changing the instruction bridge, run `npm run check:agent-instructions`. Do not run the full runtime test suite solely for an instruction-only edit.

## Core engineering rules

### TypeScript

- Avoid `any` unless no sound alternative exists.
- Inspect installed dependency types instead of guessing external APIs. Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions.
- Use standard top-level imports. Never use dynamic imports for types, `await import("./foo.js")`, or `import("pkg").Type` type positions.
- Never remove or downgrade working code to accommodate stale dependency types; upgrade the dependency.

### Code quality and architecture

- Write production-quality code with small, single-responsibility modules and explicit ownership boundaries.
- Extract shared domain logic into hooks, services, or pure utilities. Prefer maintainability and navigability over line-count reduction.
- Avoid thin one-call-site wrappers that only forward props or relocate JSX. Extract state, effects, validation, or orchestration before presentation-only pass-through layers.
- Before adding custom utility code, consider whether a well-maintained dependency meaningfully reduces complexity and maintenance cost.
- Keep correctness separate from caching, batching, retry, preload, recovery, and other performance policy. Read `docs/conventions/architecture-guardrails.md` before adding such behavior.

### Supported agents

Claude Code, Codex, and Pi are supported desktop task-agent targets. Pi support is pinned to the exact validated release declared in `src/config/agent-registry.ts`; do not accept newer Pi releases until their lifecycle, trust, interaction, and exact-resume contracts pass the compatibility suite.

## Work-area routing

Read the referenced document before editing the listed area:

- Frontend work under `web-ui`: `docs/conventions/web-ui.md`.
- Hook/domain extraction or provider/context contracts: `docs/conventions/frontend-hooks.md`.
- Main views, sidebars, toolbar tabs, task-detail routing, or surface navigation: `docs/conventions/ui-layout.md`.
- Durable board state, board commands/receipts, lifecycle board transitions, authoritative hydration, project-scoped projections, automatic titles, notifications, or task indicators: `docs/conventions/runtime-state.md`.
- Task-agent start/stop/resume/restart, startup recovery, session reconciliation, PTY identity, terminal restore, agent adapters, native hooks, input state, or host process launches: `docs/conventions/session-lifecycle.md`.
- Diagnostics recorder, journal, panel delivery, doctor, capture, or bundle format: `docs/diagnostics.md`.
- Test selection, validation scope, or deciding whether a heavier testing lane is justified: `docs/testing.md`.
- Current architecture priorities or active refactors: `docs/todo.md` and the specific linked plan.

Tracked historical context lives under `docs/history/`. Read it only when current docs and code do not answer the question or the user explicitly requests archival context.

## Frontend rules

- In `web-ui`, prefer `react-use` hooks through `@/quarterdeck/utils/react-use` when applicable.
- When a hook in `web-ui/src/hooks/` contains more than 50 lines of non-React validation, transformation, or state-machine logic, extract that logic into a colocated pure TypeScript domain module with no React imports. Test it with plain `describe` / `it`. Follow `docs/conventions/web-ui.md` and `docs/conventions/frontend-hooks.md`.
- Keep runtime-aware orchestration in hooks or domain modules and components focused on rendering view models.

## Runtime ownership guardrails

- `ProjectBoardCommandService` is the only production writer of durable board state. Browsers and future clients submit typed intent and may show optimistic presentation; they never replace `board.json` or coordinate managed lifecycle effects themselves.
- Managed task lifecycle intent goes through `ProjectTaskLifecycleService`. Process-side transition consequences go through `SessionTransitionController`.
- Runtime session truth comes from the server-owned terminal/session store. Terminal output and input/submit intent are not proof that an agent is working; only a current launch-scoped native provider hook may assert resumed work.
- `applyAuthoritativeProjectState(...)` is the single browser apply path for authoritative project state.
- `IRuntimeHostIntegrations` is the sole production boundary for server-side file, application, URL, IDE, and folder-picker effects. Preserve its launch-derived capability checks and typed outcomes; never accept arbitrary browser-supplied commands.
- Do not start Quarterdeck runtime or dev instances (`npm run dev`, `npm run dev:full`, `npm run dogfood`, `quarterdeck`) without asking when the user's app may already be running. Overlapping runtimes can proxy to the wrong instance. Use build/test validation or the isolated Agent Lab as appropriate.
- Agent availability has separate display and launch policies. Settings/config display reads may use the 30-second stale-while-revalidate cache, but task launches must go through `resolveAgentCommandForLaunch(...)`: reuse only a fresh successful result, await expired or cached-failure refreshes, never cache probe timeouts/execution failures, and preserve the typed failure message. Startup recovery may retry one transient availability probe inside preparation; deterministic missing/version/feature failures remain non-retryable preparation errors. Keep probe diagnostics metadata-only (`agentId`, probe kind, duration, typed outcome), without command output or thrown messages.

The summaries above are not substitutes for the routed runtime-state and session-lifecycle documents.

## Git and GitHub

- Never commit unless the user asks.
- When reading a GitHub issue, read every comment in one call:

  `gh issue view <number> --json title,body,comments,labels,state`

- When the user asks for a commit that closes an issue, include `fixes #<number>` or `closes #<number>` in the commit message.

## Release hygiene

When a user-visible feature or fix lands, or an active todo item is completed:

1. Remove the completed active item from `docs/todo.md`, if present.
2. Add a matching bullet under the current version in `CHANGELOG.md`. If no current version exists, create the next patch section.

When bumping a version, retain `## [Unreleased]` above the new version heading.

Add a concise top entry to `docs/implementation-log.md` only for high-signal forensic context: architecture or ownership boundaries, persistence/migration/recovery, terminal/session lifecycle, concurrency or race behavior, production/dogfood incidents, broad cross-cutting edits, or non-obvious investigation future agents would otherwise repeat. Include what changed, why, the key invariant or failure mode, notable files, validation, and the commit hash when known. Skip routine UI polish, mechanical refactors, test-only work, and small isolated fixes.

## Configuration changes

Before adding a global config field, follow the checklist at the top of `src/config/global-config-fields.ts`. For Settings UI, update `SettingsFormValues` and `resolveInitialValues` in `web-ui/src/hooks/settings/settings-form.ts`, then add the JSX control; dirty checking, reset-on-open, payload construction, and save types derive from that mapping.

Avoid broad edits to copied config mocks during feature work. Prefer the shared runtime-config factory; if repeated fixtures remain, defer mechanical updates to a final pass or consolidate them behind `createDefaultMockConfig()` to reduce merge conflicts.

## Validation

- Follow `docs/testing.md` and run the smallest validation set that proves the changed invariant.
- Do not run an umbrella command and its constituent commands on the same unchanged tree. Reconcile the final base before any broad final gate, and re-run only validation affected by later changes.
- Documentation-only work does not require runtime or browser tests. Validate the instruction bridge only when it changed and check only links added or modified.
- Use the deterministic Agent Lab only when browser/runtime/PTY, persistence, Git/Files, host-integration, or visual behavior is part of the claim. Use screenshots only for visual claims and `restart-runtime` only for cold-start or recovery claims.
- Use a real provider only with explicit authorization and only when provider TUI, hooks, event ordering, version compatibility, or launcher behavior is the unresolved risk.
- When Agent Lab is selected, use the repo-owned `quarterdeck-functional-testing` skill. Never attach automation to the user's active Quarterdeck instance or substitute `npm run dev`, `npm run dev:full`, `npm run dogfood`, or `quarterdeck` for the lab.
- Use only synthetic lab data and always stop the run. The lab isolates data and processes but is not a hardened security sandbox.
- Mutable dependency directories such as `node_modules` are never shared into task worktrees. Never follow or mutate a legacy dependency symlink target.

## Diagnostics

Begin live-instance investigation with `quarterdeck diagnostics list|status|doctor|capture|watch`; do not ask the user to reproduce after enabling logging. Diagnostic access is authenticated and read-only: it does not connect as a board client, write project state, attach or resize a PTY, refresh Git, or repair anything.

Quarterdeck has one bounded diagnostics recorder, schema, journal, CLI family, panel, and bundle contract. Production evidence stays content-safe. Synthetic Agent Lab evidence may add terminal viewport text, Git diffs, fixture state, screenshots, and traces without widening the production privacy boundary. Start bundle analysis at `manifest.json` and correlate `records.jsonl`, `doctor.json`, provider snapshots, and indexed evidence.
